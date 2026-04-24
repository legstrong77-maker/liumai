/* =========================================================
   自動獵手 AUTO HUNTER · 客戶端
   ---------------------------------------------------------
   - 預設從 /api/hunter/* 讀 server 端的全球獵手資料
   - 若 API 回 503 (D1 未設定) → 自動降級到 localStorage 模式
   - UI 自動顯示目前是「雲端同步」或「本機模式」
   ========================================================= */

const Hunter = (() => {

  const KEY = {
    signals:  "stk_hunter_signals",
    universe: "stk_hunter_universe",
    klcache:  "stk_hunter_kline_",
  };

  function loadJSON(k, d=null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function today() { return new Date().toISOString().slice(0, 10); }

  const state = {
    mode: "unknown",              // 'cloud' | 'local' | 'unknown'
    signals: loadJSON(KEY.signals, []),
    stats: null,
    lastScan: null,
    lastPoll: null,
    running: false,
    scanning: false,
    pollInterval: null,
    localScanInterval: null,
    universe: [],
    minComposite: 60,
    freq: 180_000,
    listeners: new Set(),
  };
  function emit(evt = {}) { state.listeners.forEach(fn => { try { fn(evt); } catch {} }); }

  /* -------------------- Cloud mode (server API) -------------------- */
  async function pollCloud() {
    try {
      const [sigsR, statsR] = await Promise.all([
        fetch("/api/hunter/signals?limit=500", { cache: "no-store" }),
        fetch("/api/hunter/stats", { cache: "no-store" }),
      ]);
      if (sigsR.status === 503 || statsR.status === 503) {
        state.mode = "local";
        emit({ type: "mode", mode: "local" });
        return false;
      }
      if (!sigsR.ok || !statsR.ok) throw new Error("api err");
      state.signals = await sigsR.json();
      state.stats   = await statsR.json();
      state.mode = "cloud";
      state.lastPoll = Date.now();
      // fetch latest scan info (optional, best-effort)
      try {
        const scR = await fetch("/api/hunter/scans?limit=1");
        const sc = await scR.json();
        if (sc?.[0]) state.lastScan = sc[0].ran_at;
      } catch {}
      emit({ type: "cloud-update" });
      return true;
    } catch (e) {
      console.warn("hunter cloud poll failed", e);
      return false;
    }
  }

  async function detectMode() {
    try {
      const r = await fetch("/api/hunter/stats", { cache: "no-store" });
      if (r.status === 503) { state.mode = "local"; return "local"; }
      if (r.ok) { state.mode = "cloud"; return "cloud"; }
    } catch {}
    state.mode = "local";
    return "local";
  }

  /* -------------------- Local fallback (old behavior) -------------------- */
  async function localBuildUniverse(force=false) {
    const cached = loadJSON(KEY.universe);
    if (!force && cached && cached.date === today() && cached.codes?.length) {
      state.universe = cached.codes; return state.universe;
    }
    const all = await API.stockDayAll();
    const picked = (Array.isArray(all) ? all : [])
      .filter(r => r.Code && /^[1-9]\d{3}$/.test(r.Code))
      .filter(r => Number(r.TradeValue) > 30_000_000)
      .sort((a,b) => Number(b.TradeValue) - Number(a.TradeValue))
      .slice(0, 100).map(r => r.Code);
    if (picked.length) {
      state.universe = picked;
      saveJSON(KEY.universe, { date: today(), codes: picked });
    }
    return state.universe;
  }
  async function localGetKLine(code) {
    const key = KEY.klcache + code;
    const cache = loadJSON(key);
    if (cache && cache.date === today() && cache.data?.length) return cache.data;
    const data = await API.stockPriceHistory(code, API.isoDaysAgo(200));
    if (data?.length) saveJSON(key, { date: today(), data });
    return data;
  }
  async function localScan() {
    if (state.scanning) return;
    state.scanning = true; emit({ type: "scan-start" });
    const fresh = [];
    try {
      await localBuildUniverse();
      if (!state.universe.length) return;
      const chunks = [];
      for (let i = 0; i < state.universe.length; i += 50) chunks.push(state.universe.slice(i, i+50));
      const snaps = [];
      for (const c of chunks) {
        try {
          const r = (await API.misSnapshotSmart(c)).map(API.normalizeMIS);
          snaps.push(...r.filter(x => x.code && x.price != null));
        } catch {}
      }
      for (const r of snaps) {
        let hist; try { hist = await localGetKLine(r.code); } catch { continue; }
        if (!hist || hist.length < 30) continue;
        const ai = AI.analyze(hist, [], r);
        if (!ai || ai.composite < state.minComposite) continue;
        const trigger = ai.signals.find(s =>
          s.type === "buy" && /黃金交叉|突破前高|布林上軌|爆量|MACD 紅柱翻正|KD 低檔黃金交叉/.test(s.msg));
        if (!trigger) continue;
        const rr = parseFloat(ai.plan.rr);
        if (!isFinite(rr) || rr < 1.0) continue;
        const key = `${r.code}_${today()}`;
        if (state.signals.find(s => s.key === key)) continue;
        fresh.push({
          key, code: r.code, name: r.name, firedAt: Date.now(),
          marketOpen: API.isMarketOpen(),
          entry: r.price,
          stopLoss: +ai.plan.stopLoss.toFixed(2),
          target: +ai.plan.target.toFixed(2),
          rr, composite: ai.composite, verdict: ai.verdict,
          trigger: trigger.msg.replace(/<[^>]+>/g,""),
          allSignals: ai.signals.map(s => s.msg.replace(/<[^>]+>/g,"")),
          dims: { ...ai.dims },
          sources: [
            { label: "TWSE MIS 即時", url: `https://mis.twse.com.tw/stock/fibest.jsp?stock=${r.code}` },
            { label: "FinMind 歷史", url: `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${r.code}` },
            { label: "MIS 時間戳", ts: r.time },
          ],
          status: "open",
          highSeen: r.price, lowSeen: r.price, lastPrice: r.price,
          lastCheckAt: Date.now(),
        });
      }
      if (fresh.length) {
        state.signals = [...fresh, ...state.signals].slice(0, 1000);
        saveJSON(KEY.signals, state.signals);
        maybeNotify(fresh);
      }
      state.lastScan = Date.now();
    } finally {
      state.scanning = false;
      emit({ type: "scan-done", fresh });
    }
  }
  async function localUpdateOutcomes() {
    const open = state.signals.filter(s => s.status === "open");
    if (!open.length) return;
    const codes = [...new Set(open.map(s => s.code))];
    const priceMap = {};
    for (let i=0; i<codes.length; i+=50) {
      try {
        const snap = (await API.misSnapshotSmart(codes.slice(i,i+50))).map(API.normalizeMIS);
        for (const r of snap) if (r.code && r.price != null) priceMap[r.code] = r;
      } catch {}
    }
    let changed = 0;
    for (const s of state.signals) {
      if (s.status !== "open") continue;
      const p = priceMap[s.code]; if (!p) continue;
      s.highSeen = Math.max(s.highSeen || p.price, p.high ?? p.price);
      s.lowSeen  = Math.min(s.lowSeen  || p.price, p.low  ?? p.price);
      s.lastPrice = p.price; s.lastCheckAt = Date.now();
      const age = Date.now() - s.firedAt;
      if (s.lowSeen <= s.stopLoss) {
        s.status = "stop"; s.outcomePct = (s.stopLoss - s.entry)/s.entry; s.closedAt = Date.now(); changed++;
      } else if (s.highSeen >= s.target) {
        s.status = "win"; s.outcomePct = (s.target - s.entry)/s.entry; s.closedAt = Date.now(); changed++;
      } else if (age > 7*86400_000) {
        s.status = "expired"; s.outcomePct = (p.price - s.entry)/s.entry; s.closedAt = Date.now(); changed++;
      }
    }
    if (changed) { saveJSON(KEY.signals, state.signals); emit({ type: "outcomes-updated" }); }
  }

  function localComputeStats() {
    const sigs = state.signals;
    const closed = sigs.filter(s => s.status !== "open");
    const wins = closed.filter(s => s.status === "win");
    const stops = closed.filter(s => s.status === "stop");
    const expired = closed.filter(s => s.status === "expired");
    const decisive = wins.length + stops.length;
    const winRate = decisive ? wins.length / decisive : null;
    const avgWin = wins.length ? wins.reduce((s,x)=>s+x.outcomePct,0)/wins.length : null;
    const avgLoss = stops.length ? stops.reduce((s,x)=>s+x.outcomePct,0)/stops.length : null;
    const expectancy = (winRate!=null && avgWin!=null && avgLoss!=null) ? winRate*avgWin + (1-winRate)*avgLoss : null;
    const avgClosed = closed.length ? closed.reduce((s,x)=>s+(x.outcomePct||0),0)/closed.length : null;
    const confidence = decisive >= 100 ? "樣本充足" : decisive >= 30 ? "樣本可參考" : decisive >= 10 ? "樣本偏少" : "資料不足";
    return {
      total: sigs.length, open: sigs.length - closed.length, closed: closed.length,
      wins: wins.length, stops: stops.length, expired: expired.length,
      decisive, winRate, avgReturnClosed: avgClosed, avgWin, avgLoss, expectancy, confidence,
    };
  }

  /* -------------------- Notifications -------------------- */
  function canNotify() {
    return ("Notification" in window) && Notification.permission === "granted";
  }
  async function requestNotifyPerm() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  }
  function maybeNotify(fresh) {
    if (!canNotify() || !fresh.length) return;
    const top = fresh.slice(0,3).map(s => `${s.code} ${s.name} @ ${s.entry.toFixed(2)}`).join("\n");
    try {
      new Notification(`🎯 六脈獵手：${fresh.length} 支新訊號`, { body: top, tag: "liumai-hunter", renotify: true });
    } catch {}
  }

  /* -------------------- Lifecycle -------------------- */
  async function start(opts = {}) {
    if (state.running) return;
    state.running = true;
    if (opts.minComposite != null) state.minComposite = opts.minComposite;
    if (opts.freq != null) state.freq = Math.max(30_000, opts.freq);
    emit({ type: "running", running: true });

    // detect mode
    await detectMode();

    if (state.mode === "cloud") {
      // just poll server every 30 sec
      await pollCloud();
      state.pollInterval = setInterval(pollCloud, 30_000);
    } else {
      // local fallback: do the scanning in-browser
      (async () => {
        await localUpdateOutcomes();
        if (API.isMarketOpen()) await localScan();
      })();
      state.localScanInterval = setInterval(async () => {
        await localUpdateOutcomes();
        if (API.isMarketOpen()) await localScan();
      }, state.freq);
    }
  }

  function stop() {
    state.running = false;
    if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
    if (state.localScanInterval) { clearInterval(state.localScanInterval); state.localScanInterval = null; }
    emit({ type: "running", running: false });
  }

  // Force a fresh pull (cloud) or scan (local)
  async function refresh() {
    if (state.mode === "cloud") return pollCloud();
    return localScan();
  }

  function getStats() {
    if (state.mode === "cloud" && state.stats) return state.stats;
    return localComputeStats();
  }

  function clearHistory() {
    if (state.mode === "cloud") {
      alert("雲端模式無法從用戶端清除 — 全球共享資料受保護。如需重置請洽管理員。");
      return;
    }
    state.signals = [];
    saveJSON(KEY.signals, []);
    emit({ type: "cleared" });
  }

  function subscribe(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }

  return {
    start, stop, refresh,
    getStats,
    subscribe,
    clearHistory,
    canNotify, requestNotifyPerm,
    get signals() { return state.signals; },
    get universe() { return state.universe; },
    get mode() { return state.mode; },
    get running() { return state.running; },
    get scanning() { return state.scanning; },
    get lastScan() { return state.lastScan; },
    get lastPoll() { return state.lastPoll; },
    get config() { return { minComposite: state.minComposite, freq: state.freq }; },
  };
})();
