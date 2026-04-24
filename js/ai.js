/* =========================================================
   AI analysis engine — heuristic multi-dimensional scoring.
   Each dimension scored 0..1 from:
     - 趨勢 trend      : MA alignment + slope
     - 動能 momentum   : RSI + MACD position
     - 量能 volume     : volume vs average, price-volume sync
     - 籌碼 chip       : foreign + investor net buy trend (if available)
     - 波動 volatility : BB bandwidth + ATR/price (lower=steadier)
     - 位階 position   : price position within 60d range
   Composite = weighted average × 100.
   Signals generated from threshold crossings.
   ========================================================= */

const AI = (() => {

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function analyze(candles, chip, realtime) {
    if (!candles || candles.length < 30) {
      return null;
    }
    const closes = candles.map(c => c.close);
    const last = candles.at(-1);
    const prevClose = closes.at(-2);

    const ma5  = TA.sma(closes, 5).at(-1);
    const ma10 = TA.sma(closes, 10).at(-1);
    const ma20 = TA.sma(closes, 20).at(-1);
    const ma60 = TA.sma(closes, 60).at(-1);
    const rsi14 = TA.rsi(candles, 14).at(-1);
    const macd  = TA.macd(candles);
    const difN = macd.dif.at(-1);
    const deaN = macd.dea.at(-1);
    const oscN = macd.osc.at(-1);
    const kd   = TA.kd(candles, 9);
    const K = kd.K.at(-1), D = kd.D.at(-1);
    const bb = TA.bollinger(candles, 20, 2);
    const bbw = bb.bandwidth.at(-1);
    const atr = TA.atr(candles, 14).at(-1);
    const rpos = TA.rangePct(candles, 60);
    const vr   = TA.volRatio(candles, 20);
    const pivs = TA.pivots(candles, 5);
    const lastPrice = realtime?.price ?? last.close;

    // ----- trend -----
    let trend = 0.5;
    if (ma5 && ma10 && ma20 && ma60) {
      const aligned = (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) ? 1
        : (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) ? 0
        : 0.5;
      const slope20 = (ma20 - TA.sma(closes, 20).at(-10)) / ma20;
      trend = clamp01(aligned * 0.6 + (0.5 + slope20 * 20) * 0.4);
    }

    // ----- momentum -----
    let momentum = 0.5;
    if (rsi14 != null) {
      const rsiScore = clamp01((rsi14 - 30) / 50);     // 30→0, 80→1
      const macdScore = oscN != null ? clamp01(0.5 + oscN * 10) : 0.5;
      const kdScore = K != null ? clamp01(K / 100) : 0.5;
      momentum = clamp01(rsiScore * 0.4 + macdScore * 0.35 + kdScore * 0.25);
    }

    // ----- volume -----
    let volume = 0.5;
    if (vr != null) {
      // price-volume sync: rising+volume surge = very good (1.0), falling+volume surge = bad
      const up = (lastPrice - prevClose) > 0;
      const raw = clamp01(vr / 2.5);
      volume = up ? raw : (1 - raw) * 0.6 + 0.2;
    }

    // ----- chip (法人) -----
    let chipScore = 0.5;
    if (chip && chip.length) {
      // last 5 days foreign net
      const last5 = chip.slice(-15);                 // chip has multi rows per day (foreign/invest/dealer)
      const byDate = {};
      last5.forEach(r => {
        const key = r.date; byDate[key] = byDate[key] || 0;
        const net = Number(r.buy) - Number(r.sell);
        if (!isNaN(net)) byDate[key] += net;
      });
      const vals = Object.values(byDate).slice(-5);
      if (vals.length) {
        const posDays = vals.filter(v => v > 0).length;
        const avg = vals.reduce((s,v)=>s+v,0) / vals.length;
        chipScore = clamp01(posDays / vals.length * 0.6 + (avg > 0 ? 0.4 : 0));
      }
    }

    // ----- volatility (lower = more stable, scored higher) -----
    let volatility = 0.5;
    if (bbw != null && atr != null && lastPrice) {
      const atrPct = atr / lastPrice;
      // BB squeeze (< 6%) + low ATR is bullish setup, not bad vol
      const squeeze = bbw < 0.06 ? 1 : bbw > 0.15 ? 0.3 : 0.6;
      const stable = atrPct < 0.02 ? 1 : atrPct > 0.05 ? 0.2 : 0.6;
      volatility = clamp01((squeeze + stable) / 2);
    }

    // ----- position -----
    const position = clamp01(rpos);

    const dims = {
      trend, momentum, volume, chip: chipScore, volatility, position,
    };

    const weights = { trend: .25, momentum: .22, volume: .15, chip: .18, volatility: .08, position: .12 };
    let composite = 0;
    for (const k in weights) composite += dims[k] * weights[k];
    composite = Math.round(composite * 100);

    const verdict =
      composite >= 75 ? "強烈多方"
      : composite >= 60 ? "偏多"
      : composite >= 45 ? "中性偏多"
      : composite >= 35 ? "中性偏空"
      : composite >= 20 ? "偏空"
      : "強烈空方";

    // -------------------- SIGNALS --------------------
    const signals = [];
    const push = (type, msg) => signals.push({ type, msg, t: new Date() });

    // Golden / dead cross on MA5/MA20
    if (candles.length > 22) {
      const prevMa5 = TA.sma(closes, 5).at(-2);
      const prevMa20 = TA.sma(closes, 20).at(-2);
      if (prevMa5 != null && prevMa20 != null && ma5 && ma20) {
        if (prevMa5 < prevMa20 && ma5 > ma20) push("buy", `MA5 黃金交叉 MA20：<b>${last.date}</b> 短期轉強`);
        if (prevMa5 > prevMa20 && ma5 < ma20) push("sell", `MA5 死亡交叉 MA20：<b>${last.date}</b> 短期轉弱`);
      }
    }

    // MACD cross
    if (macd.osc.length > 2) {
      const oP = macd.osc.at(-2), oN = macd.osc.at(-1);
      if (oP != null && oN != null) {
        if (oP < 0 && oN > 0) push("buy", "MACD 紅柱翻正 · 動能轉強");
        if (oP > 0 && oN < 0) push("sell", "MACD 綠柱翻負 · 動能轉弱");
      }
    }

    // RSI extremes
    if (rsi14 != null) {
      if (rsi14 >= 80) push("warn", `RSI <b>${rsi14.toFixed(1)}</b> 進入超買區 · 留意震盪`);
      if (rsi14 <= 20) push("warn", `RSI <b>${rsi14.toFixed(1)}</b> 進入超賣區 · 留意反彈`);
    }

    // KD cross
    const kPrev = kd.K.at(-2), dPrev = kd.D.at(-2);
    if (kPrev != null && dPrev != null && K != null && D != null) {
      if (kPrev < dPrev && K > D && K < 30) push("buy", `KD 低檔黃金交叉 K=<b>${K.toFixed(1)}</b>`);
      if (kPrev > dPrev && K < D && K > 70) push("sell", `KD 高檔死亡交叉 K=<b>${K.toFixed(1)}</b>`);
    }

    // BB break
    const bbUp = bb.upper.at(-1), bbLo = bb.lower.at(-1);
    if (bbUp && lastPrice > bbUp) push("info", `突破布林上軌 <b>${bbUp.toFixed(2)}</b> · 強勢`);
    if (bbLo && lastPrice < bbLo) push("info", `跌破布林下軌 <b>${bbLo.toFixed(2)}</b> · 弱勢`);

    // Volume spike
    if (vr > 2) push("info", `成交量放大 <b>${vr.toFixed(2)}×</b> 近20日均 · 量能異常`);
    if (vr < 0.4) push("info", `成交量萎縮 <b>${vr.toFixed(2)}×</b> 近20日均 · 觀望`);

    // Break resistance / support
    if (pivs.resistances.length) {
      const lastRes = pivs.resistances.at(-1).price;
      if (lastPrice > lastRes) push("buy", `突破前高 <b>${lastRes.toFixed(2)}</b>`);
    }
    if (pivs.supports.length) {
      const lastSup = pivs.supports.at(-1).price;
      if (lastPrice < lastSup) push("sell", `跌破前低 <b>${lastSup.toFixed(2)}</b>`);
    }

    // Trading plan — suggested levels
    const plan = buildPlan(candles, dims, composite, lastPrice, bb, pivs, atr);

    return { dims, composite, verdict, signals, plan };
  }

  function buildPlan(candles, dims, score, price, bb, pivs, atr) {
    const bbLo = bb.lower.at(-1);
    const bbUp = bb.upper.at(-1);
    const atrFallback = atr && atr > 0 ? atr : Math.max(price * 0.01, 0.5);

    // minimum meaningful distance = 1 ATR or 1.5% of price
    const minDist = Math.max(atrFallback, price * 0.015);

    // candidate supports/resistances with minimum distance filter
    const supBelow = pivs.supports.map(s => s.price)
      .filter(p => p < price - minDist * 0.5).sort((a, b) => b - a);
    const resAbove = pivs.resistances.map(s => s.price)
      .filter(p => p > price + minDist * 0.5).sort((a, b) => a - b);

    // stopLoss: nearest pivot below, or BB lower if further than 2*ATR, or 2*ATR projection
    let stopLoss = supBelow[0];
    if (stopLoss == null && bbLo != null && bbLo < price - minDist) stopLoss = bbLo;
    if (stopLoss == null) stopLoss = price - atrFallback * 2;

    // target: nearest pivot above (if meaningful) or BB upper or 3*ATR projection
    let target = resAbove[0];
    if (target == null && bbUp != null && bbUp > price + minDist) target = bbUp;
    if (target == null) target = price + atrFallback * 3;

    // sanity: require meaningful spread
    if (stopLoss >= price - minDist * 0.5) stopLoss = price - atrFallback * 2;
    if (target <= price + minDist * 0.5)   target   = price + atrFallback * 3;

    const risk   = Math.max(0.01, price - stopLoss);
    const reward = Math.max(0.01, target - price);
    const rr     = (reward / risk).toFixed(2);

    let bias = "觀望";
    if (score >= 60) bias = "偏多佈局";
    else if (score <= 35) bias = "偏空避險";
    else bias = "中性輪動";

    return { bias, entry: price, stopLoss, target, rr, atr: atrFallback };
  }

  return { analyze };
})();
