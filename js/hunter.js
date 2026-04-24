/* =========================================================
   自動獵手 AUTO HUNTER · 懶人買股決策引擎
   ---------------------------------------------------------
   - 每 3 分鐘掃描全市場 top-100 高成交股
   - 跑六脈 AI 引擎找強訊號
   - 記錄每一筆建議 + 追蹤後續停損/停利觸發
   - 計算勝率、平均報酬、期望值

   盤中 (9:00-13:30) 才執行主動掃描；
   盤後仍會更新 open signals 的 outcome。
   ========================================================= */

const Hunter = (() => {

  const KEY = {
    signals:  "stk_hunter_signals",
    universe: "stk_hunter_universe",
    klcache:  "stk_hunter_kline_",   // prefix: + code
  };

  function loadJSON(k, d=null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function today() { return new Date().toISOString().slice(0, 10); }

  const state = {
    signals: loadJSON(KEY.signals, []),
    universe: [],
    running: false,
    scanInterval: null,
    scanning: false,
    lastScan: null,
    lastScanResult: null,
    minComposite: 60,
    freq: 180_000,           // 3 min
    listeners: new Set(),
    debug: false,
  };

  function emit(evt = {}) { state.listeners.forEach(fn => { try { fn(evt); } catch {} }); }

  // ---------- universe ----------
  async function buildUniverse(forceRefresh = false) {
    const cached = loadJSON(KEY.universe);
    if (!forceRefresh && cached && cached.date === today() && cached.codes?.length) {
      state.universe = cached.codes;
      return state.universe;
    }
    const all = await API.stockDayAll();
    const picked = (Array.isArray(all) ? all : [])
      .filter(r => r.Code && /^[1-9]\d{3}$/.test(r.Code))   // 4-digit TSE stocks only
      .filter(r => Number(r.TradeValue) > 30_000_000)      // min NT$3k萬 daily turnover
      .sort((a, b) => Number(b.TradeValue) - Number(a.TradeValue))
      .slice(0, 100)
      .map(r => r.Code);

    if (picked.length) {
      state.universe = picked;
      saveJSON(KEY.universe, { date: today(), codes: picked });
    }
    return state.universe;
  }

  // ---------- cached K-line (FinMind is T+1 so daily cache is fine) ----------
  async function getKLine(code) {
    const key = KEY.klcache + code;
    const cache = loadJSON(key);
    if (cache && cache.date === today() && cache.data?.length) return cache.data;
    const data = await API.stockPriceHistory(code, API.isoDaysAgo(200));
    if (data?.length) saveJSON(key, { date: today(), data });
    return data;
  }

  // ---------- scan ----------
  async function scanOnce() {
    if (state.scanning) return { skipped: "already scanning" };
    state.scanning = true;
    emit({ type: "scan-start" });
    const fresh = [];
    let errors = 0;
    try {
      await buildUniverse();
      if (!state.universe.length) return { error: "empty universe" };

      // Batch MIS in chunks of 50 to be nice to server
      const chunks = [];
      for (let i = 0; i < state.universe.length; i += 50) {
        chunks.push(state.universe.slice(i, i + 50));
      }
      const allSnap = [];
      for (const chunk of chunks) {
        try {
          const snap = (await API.misSnapshotSmart(chunk)).map(API.normalizeMIS);
          allSnap.push(...snap.filter(r => r.code && r.price != null));
        } catch (e) { errors++; }
      }

      for (const r of allSnap) {
        let hist;
        try { hist = await getKLine(r.code); } catch { continue; }
        if (!hist || hist.length < 30) continue;

        const ai = AI.analyze(hist, [], r);
        if (!ai) continue;

        if (ai.composite < state.minComposite) continue;

        // Require a tradeable entry signal (just fired)
        const tradeableSignal = ai.signals.find(s =>
          s.type === "buy" &&
          /黃金交叉|突破前高|布林上軌|爆量|MACD 紅柱翻正|KD 低檔黃金交叉/.test(s.msg)
        );
        if (!tradeableSignal) continue;

        // Dedupe: (code, date) — only one signal per stock per day
        const sigKey = `${r.code}_${today()}`;
        if (state.signals.find(s => s.key === sigKey)) continue;

        // Require min R:R of 1.0 — reward must >= risk
        const rr = parseFloat(ai.plan.rr);
        if (!isFinite(rr) || rr < 1.0) continue;

        const sig = {
          key: sigKey,
          code: r.code,
          name: r.name,
          firedAt: Date.now(),
          firedLocal: new Date().toLocaleString("zh-Hant", { hour12: false }),
          marketOpen: API.isMarketOpen(),
          entry: r.price,
          stopLoss: +ai.plan.stopLoss.toFixed(2),
          target:   +ai.plan.target.toFixed(2),
          rr,
          composite: ai.composite,
          verdict: ai.verdict,
          dims: { ...ai.dims },
          trigger: tradeableSignal.msg.replace(/<[^>]+>/g, ""),
          allSignals: ai.signals.map(s => s.msg.replace(/<[^>]+>/g, "")),
          sources: [
            { label: "TWSE MIS · 即時報價", url: `https://mis.twse.com.tw/stock/fibest.jsp?stock=${r.code}`, type: "即時價" },
            { label: "FinMind · 歷史 K 線", url: `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${r.code}`, type: "K線" },
            { label: "TWSE OpenAPI · 個股", url: `https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY?stockNo=${r.code}`, type: "盤後" },
            { label: "即時 MIS 時間戳", ts: r.time, type: "snapshot-time" },
          ],
          status: "open",
          highSeen: r.price,
          lowSeen: r.price,
          lastPrice: r.price,
          lastCheckAt: Date.now(),
        };
        fresh.push(sig);
      }

      if (fresh.length) {
        state.signals.unshift(...fresh);
        if (state.signals.length > 1000) state.signals.length = 1000;
        saveJSON(KEY.signals, state.signals);
        maybeNotify(fresh);
      }

      state.lastScan = Date.now();
      state.lastScanResult = { fresh: fresh.length, scanned: allSnap.length, errors };
      return state.lastScanResult;
    } finally {
      state.scanning = false;
      emit({ type: "scan-done", fresh });
    }
  }

  // ---------- outcome tracking ----------
  async function updateOutcomes() {
    const open = state.signals.filter(s => s.status === "open");
    if (!open.length) return { updated: 0 };

    const codes = [...new Set(open.map(s => s.code))];
    const priceMap = {};
    for (let i = 0; i < codes.length; i += 50) {
      const chunk = codes.slice(i, i + 50);
      try {
        const snap = (await API.misSnapshotSmart(chunk)).map(API.normalizeMIS);
        for (const r of snap) if (r.code && r.price != null) priceMap[r.code] = { price: r.price, high: r.high, low: r.low };
      } catch {}
    }

    let changed = 0;
    for (const s of state.signals) {
      if (s.status !== "open") continue;
      const p = priceMap[s.code];
      if (!p) continue;
      // track high/low since signal fired
      s.highSeen = Math.max(s.highSeen || p.price, p.high ?? p.price);
      s.lowSeen  = Math.min(s.lowSeen  || p.price, p.low  ?? p.price);
      s.lastPrice = p.price;
      s.lastCheckAt = Date.now();

      const age = Date.now() - s.firedAt;

      // Stop-loss hit first (conservative assumption if both in same bar)
      if (s.lowSeen <= s.stopLoss) {
        s.status = "stop";
        s.outcomePct = (s.stopLoss - s.entry) / s.entry;
        s.closedAt = Date.now();
        changed++;
      } else if (s.highSeen >= s.target) {
        s.status = "win";
        s.outcomePct = (s.target - s.entry) / s.entry;
        s.closedAt = Date.now();
        changed++;
      } else if (age > 7 * 86400_000) {
        // expire after 7 days, mark with current P&L as reference
        s.status = "expired";
        s.outcomePct = (p.price - s.entry) / s.entry;
        s.closedAt = Date.now();
        changed++;
      }
    }

    if (changed) {
      saveJSON(KEY.signals, state.signals);
      emit({ type: "outcomes-updated", changed });
    }
    return { updated: changed };
  }

  // ---------- stats ----------
  function getStats() {
    const sigs = state.signals;
    const open = sigs.filter(s => s.status === "open").length;
    const closed = sigs.filter(s => s.status !== "open");
    const wins = closed.filter(s => s.status === "win");
    const stops = closed.filter(s => s.status === "stop");
    const expired = closed.filter(s => s.status === "expired");

    const decisive = wins.length + stops.length;       // win/stop only (expired excluded from win rate)
    const winRate = decisive ? wins.length / decisive : null;

    const avgReturnClosed = closed.length ?
      closed.reduce((s, x) => s + (x.outcomePct || 0), 0) / closed.length : null;
    const avgWin = wins.length ?
      wins.reduce((s, x) => s + x.outcomePct, 0) / wins.length : null;
    const avgLoss = stops.length ?
      stops.reduce((s, x) => s + x.outcomePct, 0) / stops.length : null;
    const expectancy = (winRate != null && avgWin != null && avgLoss != null) ?
      winRate * avgWin + (1 - winRate) * avgLoss : null;

    // Sample size confidence note
    let confidence = "資料不足";
    if (decisive >= 100) confidence = "樣本充足";
    else if (decisive >= 30) confidence = "樣本可參考";
    else if (decisive >= 10) confidence = "樣本偏少";

    return {
      total: sigs.length,
      open,
      closed: closed.length,
      wins: wins.length,
      stops: stops.length,
      expired: expired.length,
      decisive,
      winRate,
      avgReturnClosed,
      avgWin,
      avgLoss,
      expectancy,
      confidence,
    };
  }

  // ---------- notifications ----------
  function canNotify() {
    return ("Notification" in window) && Notification.permission === "granted";
  }
  async function requestNotifyPerm() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const p = await Notification.requestPermission();
    return p === "granted";
  }
  function maybeNotify(fresh) {
    if (!canNotify() || !fresh.length) return;
    const top = fresh.slice(0, 3).map(s => `${s.code} ${s.name} @ ${s.entry.toFixed(2)}`).join("\n");
    try {
      new Notification(`🎯 六脈獵手：${fresh.length} 支新訊號`, {
        body: top,
        tag: "liumai-hunter",
        renotify: true,
      });
    } catch {}
  }

  // ---------- lifecycle ----------
  function start(opts = {}) {
    if (state.running) return;
    if (opts.minComposite != null) state.minComposite = opts.minComposite;
    if (opts.freq != null) state.freq = Math.max(60_000, opts.freq);

    state.running = true;
    emit({ type: "running", running: true });

    // first tick: update outcomes regardless of hours, scan only if market open
    (async () => {
      await updateOutcomes();
      if (API.isMarketOpen()) await scanOnce();
    })();

    state.scanInterval = setInterval(async () => {
      await updateOutcomes();
      if (API.isMarketOpen()) await scanOnce();
    }, state.freq);
  }

  function stop() {
    if (state.scanInterval) clearInterval(state.scanInterval);
    state.scanInterval = null;
    state.running = false;
    emit({ type: "running", running: false });
  }

  function clearHistory() {
    state.signals = [];
    saveJSON(KEY.signals, []);
    emit({ type: "cleared" });
  }

  function subscribe(fn) {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  }

  return {
    start, stop,
    scanOnce, updateOutcomes, buildUniverse,
    getStats,
    get signals() { return state.signals; },
    get universe() { return state.universe; },
    get running() { return state.running; },
    get scanning() { return state.scanning; },
    get lastScan() { return state.lastScan; },
    get lastScanResult() { return state.lastScanResult; },
    get config() { return { minComposite: state.minComposite, freq: state.freq }; },
    setConfig(o) {
      if (o.minComposite != null) state.minComposite = o.minComposite;
      if (o.freq != null) state.freq = Math.max(60_000, o.freq);
    },
    canNotify, requestNotifyPerm,
    clearHistory, subscribe,
  };
})();
