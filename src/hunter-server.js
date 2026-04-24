// 六脈 LIUMAI · Hunter server-side engine
// =======================================================
// Runs inside Cloudflare Worker (both fetch + scheduled handlers).
// Requires env.DB binding (Cloudflare D1).
//
// Self-contained — embeds the TA + AI scoring logic used by
// the browser side, so the Worker doesn't need any bundler.

/* -------------------- TA indicators (inline) -------------------- */
const TA = {
  sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  },
  ema(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      prev = prev == null ? values[i] : (values[i] - prev) * k + prev;
      if (i >= period - 1) out[i] = prev;
    }
    return out;
  },
  stdev(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      const s = values.slice(i - period + 1, i + 1);
      const m = s.reduce((a, b) => a + b, 0) / period;
      const v = s.reduce((a, b) => a + (b - m) ** 2, 0) / period;
      out[i] = Math.sqrt(v);
    }
    return out;
  },
  bollinger(candles, period = 20, mult = 2) {
    const c = candles.map(x => x.close);
    const mid = TA.sma(c, period);
    const sd = TA.stdev(c, period);
    return {
      mid,
      upper: mid.map((m, i) => m == null ? null : m + mult * sd[i]),
      lower: mid.map((m, i) => m == null ? null : m - mult * sd[i]),
      bandwidth: mid.map((m, i) => m == null ? null : (2 * mult * sd[i]) / m),
    };
  },
  rsi(candles, period = 14) {
    const c = candles.map(x => x.close);
    const out = new Array(c.length).fill(null);
    let avgG = 0, avgL = 0;
    for (let i = 1; i < c.length; i++) {
      const ch = c[i] - c[i - 1];
      const g = ch > 0 ? ch : 0;
      const l = ch < 0 ? -ch : 0;
      if (i <= period) {
        avgG += g; avgL += l;
        if (i === period) {
          avgG /= period; avgL /= period;
          out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
        }
      } else {
        avgG = (avgG * (period - 1) + g) / period;
        avgL = (avgL * (period - 1) + l) / period;
        out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
      }
    }
    return out;
  },
  macd(candles) {
    const c = candles.map(x => x.close);
    const ef = TA.ema(c, 12);
    const es = TA.ema(c, 26);
    const dif = c.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    const difClean = dif.map(x => x == null ? 0 : x);
    const dea = TA.ema(difClean, 9).map((v, i) => dif[i] == null ? null : v);
    const osc = dif.map((d, i) => (d != null && dea[i] != null) ? (d - dea[i]) * 2 : null);
    return { dif, dea, osc };
  },
  kd(candles, period = 9) {
    const n = candles.length;
    const out = { K: new Array(n).fill(null), D: new Array(n).fill(null) };
    let K = 50, D = 50;
    for (let i = period - 1; i < n; i++) {
      const s = candles.slice(i - period + 1, i + 1);
      const hi = Math.max(...s.map(x => x.high));
      const lo = Math.min(...s.map(x => x.low));
      const rsv = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
      K = (2 / 3) * K + (1 / 3) * rsv;
      D = (2 / 3) * D + (1 / 3) * K;
      out.K[i] = K; out.D[i] = D;
    }
    return out;
  },
  atr(candles, period = 14) {
    const tr = new Array(candles.length).fill(0);
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    return TA.ema(tr, period);
  },
  pivots(candles, lookback = 5) {
    const out = { supports: [], resistances: [] };
    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low <= candles[i].low) isLow = false;
      }
      if (isHigh) out.resistances.push({ i, price: candles[i].high });
      if (isLow)  out.supports.push({ i, price: candles[i].low });
    }
    return out;
  },
  volRatio(candles, period = 20) {
    const last = candles.at(-1);
    if (!last) return 1;
    const avg = candles.slice(-period - 1, -1).reduce((s, x) => s + (x.volume || 0), 0) / period;
    return avg === 0 ? 1 : (last.volume || 0) / avg;
  },
  rangePct(candles, period = 60) {
    const last = candles.at(-1);
    if (!last || candles.length < period) return 0.5;
    const s = candles.slice(-period);
    const hi = Math.max(...s.map(x => x.high));
    const lo = Math.min(...s.map(x => x.low));
    return hi === lo ? 0.5 : (last.close - lo) / (hi - lo);
  },
};

/* -------------------- AI scoring (inline, same formula as browser) -------------------- */
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function aiAnalyze(candles, realtime) {
  if (!candles || candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const last = candles.at(-1);
  const prevClose = closes.at(-2);

  const ma5 = TA.sma(closes, 5).at(-1);
  const ma10 = TA.sma(closes, 10).at(-1);
  const ma20 = TA.sma(closes, 20).at(-1);
  const ma60 = TA.sma(closes, 60).at(-1);
  const rsi14 = TA.rsi(candles, 14).at(-1);
  const macd = TA.macd(candles);
  const oscN = macd.osc.at(-1);
  const kd = TA.kd(candles, 9);
  const K = kd.K.at(-1), D = kd.D.at(-1);
  const bb = TA.bollinger(candles, 20, 2);
  const bbw = bb.bandwidth.at(-1);
  const atr = TA.atr(candles, 14).at(-1);
  const rpos = TA.rangePct(candles, 60);
  const vr = TA.volRatio(candles, 20);
  const pivs = TA.pivots(candles, 5);
  const lastPrice = realtime?.price ?? last.close;

  let trend = 0.5;
  if (ma5 && ma10 && ma20 && ma60) {
    const aligned = (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) ? 1
      : (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) ? 0 : 0.5;
    const slope20 = (ma20 - TA.sma(closes, 20).at(-10)) / ma20;
    trend = clamp01(aligned * 0.6 + (0.5 + slope20 * 20) * 0.4);
  }
  let momentum = 0.5;
  if (rsi14 != null) {
    const rs = clamp01((rsi14 - 30) / 50);
    const ms = oscN != null ? clamp01(0.5 + oscN * 10) : 0.5;
    const ks = K != null ? clamp01(K / 100) : 0.5;
    momentum = clamp01(rs * 0.4 + ms * 0.35 + ks * 0.25);
  }
  let volume = 0.5;
  if (vr != null) {
    const up = (lastPrice - prevClose) > 0;
    const raw = clamp01(vr / 2.5);
    volume = up ? raw : (1 - raw) * 0.6 + 0.2;
  }
  let volatility = 0.5;
  if (bbw != null && atr != null && lastPrice) {
    const atrPct = atr / lastPrice;
    const squeeze = bbw < 0.06 ? 1 : bbw > 0.15 ? 0.3 : 0.6;
    const stable = atrPct < 0.02 ? 1 : atrPct > 0.05 ? 0.2 : 0.6;
    volatility = clamp01((squeeze + stable) / 2);
  }
  const position = clamp01(rpos);

  const dims = { trend, momentum, volume, chip: 0.5, volatility, position };
  const weights = { trend: .25, momentum: .22, volume: .15, chip: .18, volatility: .08, position: .12 };
  let composite = 0;
  for (const k in weights) composite += dims[k] * weights[k];
  composite = Math.round(composite * 100);

  const verdict = composite >= 75 ? "強烈多方"
    : composite >= 60 ? "偏多"
    : composite >= 45 ? "中性偏多"
    : composite >= 35 ? "中性偏空"
    : composite >= 20 ? "偏空"
    : "強烈空方";

  const signals = [];
  if (candles.length > 22) {
    const prevMa5 = TA.sma(closes, 5).at(-2);
    const prevMa20 = TA.sma(closes, 20).at(-2);
    if (prevMa5 != null && prevMa20 != null && ma5 && ma20) {
      if (prevMa5 < prevMa20 && ma5 > ma20) signals.push({ type: "buy", msg: "MA5 黃金交叉 MA20" });
      if (prevMa5 > prevMa20 && ma5 < ma20) signals.push({ type: "sell", msg: "MA5 死亡交叉 MA20" });
    }
  }
  if (macd.osc.length > 2) {
    const oP = macd.osc.at(-2), oN = macd.osc.at(-1);
    if (oP != null && oN != null) {
      if (oP < 0 && oN > 0) signals.push({ type: "buy", msg: "MACD 紅柱翻正" });
      if (oP > 0 && oN < 0) signals.push({ type: "sell", msg: "MACD 綠柱翻負" });
    }
  }
  if (rsi14 != null) {
    if (rsi14 >= 80) signals.push({ type: "warn", msg: `RSI ${rsi14.toFixed(1)} 超買` });
    if (rsi14 <= 20) signals.push({ type: "warn", msg: `RSI ${rsi14.toFixed(1)} 超賣` });
  }
  const kPrev = kd.K.at(-2), dPrev = kd.D.at(-2);
  if (kPrev != null && dPrev != null && K != null && D != null) {
    if (kPrev < dPrev && K > D && K < 30) signals.push({ type: "buy", msg: `KD 低檔黃金交叉` });
    if (kPrev > dPrev && K < D && K > 70) signals.push({ type: "sell", msg: `KD 高檔死亡交叉` });
  }
  const bbUp = bb.upper.at(-1), bbLo = bb.lower.at(-1);
  if (bbUp && lastPrice > bbUp) signals.push({ type: "buy", msg: `突破布林上軌 ${bbUp.toFixed(2)}` });
  if (bbLo && lastPrice < bbLo) signals.push({ type: "info", msg: `跌破布林下軌 ${bbLo.toFixed(2)}` });
  if (vr > 2) signals.push({ type: "info", msg: `爆量 ${vr.toFixed(2)}×` });
  if (pivs.resistances.length) {
    const lr = pivs.resistances.at(-1).price;
    if (lastPrice > lr) signals.push({ type: "buy", msg: `突破前高 ${lr.toFixed(2)}` });
  }

  const plan = buildPlan(composite, lastPrice, bb, pivs, atr);
  return { dims, composite, verdict, signals, plan };
}

function buildPlan(score, price, bb, pivs, atr) {
  const bbLo = bb.lower.at(-1);
  const bbUp = bb.upper.at(-1);
  const atrFallback = atr && atr > 0 ? atr : Math.max(price * 0.01, 0.5);
  const minDist = Math.max(atrFallback, price * 0.015);

  const supBelow = pivs.supports.map(s => s.price)
    .filter(p => p < price - minDist * 0.5).sort((a, b) => b - a);
  const resAbove = pivs.resistances.map(s => s.price)
    .filter(p => p > price + minDist * 0.5).sort((a, b) => a - b);

  let stopLoss = supBelow[0];
  if (stopLoss == null && bbLo != null && bbLo < price - minDist) stopLoss = bbLo;
  if (stopLoss == null) stopLoss = price - atrFallback * 2;

  let target = resAbove[0];
  if (target == null && bbUp != null && bbUp > price + minDist) target = bbUp;
  if (target == null) target = price + atrFallback * 3;

  if (stopLoss >= price - minDist * 0.5) stopLoss = price - atrFallback * 2;
  if (target <= price + minDist * 0.5) target = price + atrFallback * 3;

  const risk = Math.max(0.01, price - stopLoss);
  const reward = Math.max(0.01, target - price);
  const rr = +(reward / risk).toFixed(2);
  const bias = score >= 60 ? "偏多佈局" : score <= 35 ? "偏空避險" : "中性輪動";

  return { bias, entry: price, stopLoss, target, rr };
}

/* -------------------- Upstream fetchers -------------------- */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

async function fetchMISSmart(codes) {
  const chunks = [];
  for (let i = 0; i < codes.length; i += 50) chunks.push(codes.slice(i, i + 50));
  const result = [];
  for (const chunk of chunks) {
    try {
      const tseUrl = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" +
        encodeURIComponent(chunk.map(c => `tse_${c}.tw`).join("|")) + `&json=1&delay=0&_=${Date.now()}`;
      const r = await fetch(tseUrl, { headers: { "User-Agent": UA, "Referer": "https://mis.twse.com.tw/" } });
      const d = await r.json();
      const seen = new Set((d.msgArray || []).map(x => x.c));
      result.push(...(d.msgArray || []));
      const miss = chunk.filter(c => !seen.has(c));
      if (miss.length) {
        const otcUrl = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" +
          encodeURIComponent(miss.map(c => `otc_${c}.tw`).join("|")) + `&json=1&delay=0&_=${Date.now()}`;
        const r2 = await fetch(otcUrl, { headers: { "User-Agent": UA, "Referer": "https://mis.twse.com.tw/" } });
        const d2 = await r2.json();
        result.push(...(d2.msgArray || []));
      }
    } catch {}
  }
  return result;
}

function normalizeMIS(r) {
  const num = v => (v === "-" || v === "" || v == null) ? null : Number(v);
  const bestBidP = (r.b || "").split("_").filter(Boolean).map(Number);
  const bestAskP = (r.a || "").split("_").filter(Boolean).map(Number);
  return {
    code: r.c, name: r.n,
    price: num(r.z) ?? num(r.pz) ?? bestBidP[0] ?? bestAskP[0] ?? num(r.y),
    open: num(r.o), high: num(r.h), low: num(r.l), ref: num(r.y),
    volume: num(r.v), time: r.t,
  };
}

async function fetchKLine(code, days = 200) {
  const startDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${startDate}`;
  const r = await fetch(url);
  const d = await r.json();
  return (d.data || []).map(x => ({
    date: x.date,
    open: +x.open, high: +x.max, low: +x.min, close: +x.close,
    volume: +x.Trading_Volume, amount: +x.Trading_money,
  })).filter(x => x.close > 0);
}

async function fetchStockDayAll() {
  const r = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

function isMarketOpenTW() {
  // Taiwan time = UTC+8
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 3600_000);
  const day = tw.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hm = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return hm >= 9 * 60 && hm <= 13 * 60 + 30;
}
function twToday() {
  const now = new Date(Date.now() + 8 * 3600_000);
  return now.toISOString().slice(0, 10);
}

/* -------------------- D1 helpers -------------------- */
async function getUniverse(env) {
  const today = twToday();
  const cached = await env.DB.prepare("SELECT codes FROM universe_cache WHERE date = ?").bind(today).first();
  if (cached?.codes) return JSON.parse(cached.codes);

  const all = await fetchStockDayAll();
  const universe = all
    .filter(r => r.Code && /^[1-9]\d{3}$/.test(r.Code))
    .filter(r => Number(r.TradeValue) > 30_000_000)
    .sort((a, b) => Number(b.TradeValue) - Number(a.TradeValue))
    .slice(0, 100)
    .map(r => r.Code);

  if (universe.length) {
    await env.DB.prepare("INSERT OR REPLACE INTO universe_cache (date, codes) VALUES (?, ?)")
      .bind(today, JSON.stringify(universe)).run();
  }
  return universe;
}

async function getKLineCached(env, code) {
  const today = twToday();
  const cached = await env.DB.prepare("SELECT data FROM kline_cache WHERE code = ? AND date = ?")
    .bind(code, today).first();
  if (cached?.data) return JSON.parse(cached.data);

  const data = await fetchKLine(code, 200);
  if (data.length) {
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO kline_cache (code, date, data) VALUES (?, ?, ?)")
        .bind(code, today, JSON.stringify(data)).run();
    } catch {}
  }
  return data;
}

/* -------------------- Scan logic -------------------- */
export async function scanMarket(env, opts = {}) {
  const minComposite = opts.minComposite ?? 60;
  const maxStocks = opts.maxStocks ?? 100;
  const startedAt = Date.now();
  let scanned = 0, fresh = 0, errors = 0;
  const marketOpen = isMarketOpenTW();

  try {
    const universe = (await getUniverse(env)).slice(0, maxStocks);
    const snaps = (await fetchMISSmart(universe))
      .map(normalizeMIS)
      .filter(r => r.code && r.price != null);

    for (const r of snaps) {
      scanned++;
      let hist;
      try { hist = await getKLineCached(env, r.code); }
      catch { errors++; continue; }
      if (!hist || hist.length < 30) continue;

      const ai = aiAnalyze(hist, r);
      if (!ai) continue;
      if (ai.composite < minComposite) continue;

      const tradeable = ai.signals.find(s =>
        s.type === "buy" && /黃金交叉|突破前高|布林上軌|爆量|MACD 紅柱翻正|KD 低檔黃金交叉/.test(s.msg)
      );
      if (!tradeable) continue;
      if (!isFinite(ai.plan.rr) || ai.plan.rr < 1.0) continue;

      const key = `${r.code}_${twToday()}`;
      const existing = await env.DB.prepare("SELECT key FROM signals WHERE key = ?").bind(key).first();
      if (existing) continue;

      await env.DB.prepare(`
        INSERT INTO signals
          (key, code, name, fired_at, market_open, entry, stop_loss, target, rr, composite, verdict,
           trigger_msg, all_signals, dims, sources, status, high_seen, low_seen, last_price, last_check_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `).bind(
        key, r.code, r.name, Date.now(), marketOpen ? 1 : 0,
        r.price, +ai.plan.stopLoss.toFixed(2), +ai.plan.target.toFixed(2), ai.plan.rr,
        ai.composite, ai.verdict, tradeable.msg,
        JSON.stringify(ai.signals.map(s => s.msg)),
        JSON.stringify(ai.dims),
        JSON.stringify([
          { label: "TWSE MIS 即時", url: `https://mis.twse.com.tw/stock/fibest.jsp?stock=${r.code}` },
          { label: "FinMind 歷史", url: `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${r.code}` },
          { label: "MIS 時間戳", ts: r.time },
        ]),
        r.price, r.price, r.price, Date.now()
      ).run();
      fresh++;
    }
  } catch (e) {
    errors++;
  }

  await env.DB.prepare(
    "INSERT INTO scans (ran_at, scanned_count, fresh_count, duration_ms, error_count, market_open) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(startedAt, scanned, fresh, Date.now() - startedAt, errors, marketOpen ? 1 : 0).run();

  return { scanned, fresh, errors, duration: Date.now() - startedAt, marketOpen };
}

export async function updateOutcomes(env) {
  const rows = await env.DB.prepare(
    "SELECT key, code, fired_at, entry, stop_loss, target, high_seen, low_seen FROM signals WHERE status = 'open'"
  ).all();
  const opens = rows.results || [];
  if (!opens.length) return { updated: 0 };

  const codes = [...new Set(opens.map(s => s.code))];
  const snaps = (await fetchMISSmart(codes)).map(normalizeMIS);
  const priceMap = {};
  for (const r of snaps) if (r.code && r.price != null) priceMap[r.code] = r;

  let updated = 0;
  const now = Date.now();
  for (const s of opens) {
    const p = priceMap[s.code];
    if (!p) continue;

    const highSeen = Math.max(s.high_seen ?? p.price, p.high ?? p.price);
    const lowSeen  = Math.min(s.low_seen  ?? p.price, p.low  ?? p.price);
    const age = now - s.fired_at;

    if (lowSeen <= s.stop_loss) {
      await env.DB.prepare(
        "UPDATE signals SET status='stop', outcome_pct=?, closed_at=?, high_seen=?, low_seen=?, last_price=?, last_check_at=? WHERE key=?"
      ).bind(
        (s.stop_loss - s.entry) / s.entry, now, highSeen, lowSeen, p.price, now, s.key
      ).run();
      updated++;
    } else if (highSeen >= s.target) {
      await env.DB.prepare(
        "UPDATE signals SET status='win', outcome_pct=?, closed_at=?, high_seen=?, low_seen=?, last_price=?, last_check_at=? WHERE key=?"
      ).bind(
        (s.target - s.entry) / s.entry, now, highSeen, lowSeen, p.price, now, s.key
      ).run();
      updated++;
    } else if (age > 7 * 86400_000) {
      await env.DB.prepare(
        "UPDATE signals SET status='expired', outcome_pct=?, closed_at=?, high_seen=?, low_seen=?, last_price=?, last_check_at=? WHERE key=?"
      ).bind(
        (p.price - s.entry) / s.entry, now, highSeen, lowSeen, p.price, now, s.key
      ).run();
      updated++;
    } else {
      await env.DB.prepare(
        "UPDATE signals SET high_seen=?, low_seen=?, last_price=?, last_check_at=? WHERE key=?"
      ).bind(highSeen, lowSeen, p.price, now, s.key).run();
    }
  }
  return { updated, checked: opens.length };
}

/* -------------------- API handlers -------------------- */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function parseSignal(row) {
  return {
    key: row.key, code: row.code, name: row.name,
    firedAt: row.fired_at, marketOpen: !!row.market_open,
    entry: row.entry, stopLoss: row.stop_loss, target: row.target, rr: row.rr,
    composite: row.composite, verdict: row.verdict,
    trigger: row.trigger_msg,
    allSignals: JSON.parse(row.all_signals || "[]"),
    dims: JSON.parse(row.dims || "{}"),
    sources: JSON.parse(row.sources || "[]"),
    status: row.status,
    highSeen: row.high_seen, lowSeen: row.low_seen,
    lastPrice: row.last_price, lastCheckAt: row.last_check_at,
    outcomePct: row.outcome_pct, closedAt: row.closed_at,
  };
}

export async function handleHunterAPI(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) {
    return jsonResp({ error: "D1 not configured", setup: "see SETUP-D1.md" }, 503);
  }

  const path = url.pathname.replace(/^\/api\/hunter/, "") || "/";

  try {
    if (path === "/signals" && request.method === "GET") {
      const status = url.searchParams.get("status");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 1000);
      const sql = status
        ? "SELECT * FROM signals WHERE status = ? ORDER BY fired_at DESC LIMIT ?"
        : "SELECT * FROM signals ORDER BY fired_at DESC LIMIT ?";
      const stmt = status
        ? env.DB.prepare(sql).bind(status, limit)
        : env.DB.prepare(sql).bind(limit);
      const rows = await stmt.all();
      return jsonResp((rows.results || []).map(parseSignal));
    }

    if (path === "/stats" && request.method === "GET") {
      const agg = await env.DB.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN status='win' THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN status='stop' THEN 1 ELSE 0 END) AS stops,
          SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expired,
          AVG(CASE WHEN status='win' THEN outcome_pct END) AS avg_win,
          AVG(CASE WHEN status='stop' THEN outcome_pct END) AS avg_loss,
          AVG(CASE WHEN status IN ('win','stop','expired') THEN outcome_pct END) AS avg_closed
        FROM signals
      `).first();
      const wins = agg.wins || 0;
      const stops = agg.stops || 0;
      const decisive = wins + stops;
      const winRate = decisive ? wins / decisive : null;
      const avgWin = agg.avg_win || null;
      const avgLoss = agg.avg_loss || null;
      const expectancy = (winRate != null && avgWin != null && avgLoss != null)
        ? winRate * avgWin + (1 - winRate) * avgLoss : null;
      const confidence =
        decisive >= 100 ? "樣本充足"
        : decisive >= 30 ? "樣本可參考"
        : decisive >= 10 ? "樣本偏少"
        : "資料不足";
      return jsonResp({
        total: agg.total || 0,
        open: agg.open || 0,
        closed: (agg.total || 0) - (agg.open || 0),
        wins, stops, expired: agg.expired || 0,
        decisive, winRate,
        avgReturnClosed: agg.avg_closed || null,
        avgWin, avgLoss, expectancy, confidence,
      });
    }

    if (path === "/scans" && request.method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      const rows = await env.DB.prepare("SELECT * FROM scans ORDER BY ran_at DESC LIMIT ?").bind(limit).all();
      return jsonResp(rows.results || []);
    }

    if (path === "/scan" && request.method === "POST") {
      // Manual trigger (admin) — rate limit via secret or just allow
      const result = await scanMarket(env);
      await updateOutcomes(env);
      return jsonResp(result);
    }

    return jsonResp({ error: "not found" }, 404);
  } catch (err) {
    return jsonResp({ error: `api: ${err.message || err}` }, 500);
  }
}
