/* =========================================================
   API wrappers for Taiwan stock data.
   Primary sources:
     - TWSE MIS (即時報價, 5 檔)       https://mis.twse.com.tw
     - TWSE OpenAPI (盤後/法人/排行)   https://openapi.twse.com.tw/v1
     - TPEx OpenAPI (櫃買)             https://www.tpex.org.tw/openapi/v1
     - FinMind v4 (歷史K線, 基本資料)  https://api.finmindtrade.com/api/v4

   CORS strategy:
     - openapi.twse.com.tw & openapi tpex: public CORS OK
     - api.finmindtrade.com: CORS OK
     - mis.twse.com.tw: CORS blocked — route via proxy list
     - If local server.py is running on :8787, it proxies everything.
   ========================================================= */

const API = (() => {

  // ---------- proxy chain ----------
  // Same-origin /proxy: works BOTH for local (server.py) AND deployed
  // (Cloudflare Pages Functions). Only falls back to public proxies if
  // opened as file:// or on a host without our Function.
  const SAME_ORIGIN_PROXY = "/proxy?url=";
  const HEALTH_URL = "/health";
  const PUBLIC_PROXIES = [
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];

  const isHttp = typeof location !== "undefined" && /^https?:$/.test(location.protocol);
  let ownProxyAlive = null;
  async function checkOwnProxy() {
    if (ownProxyAlive !== null) return ownProxyAlive;
    if (!isHttp) { ownProxyAlive = false; return false; }
    try {
      const r = await fetch(HEALTH_URL, { cache: "no-store" });
      ownProxyAlive = r.ok;
    } catch { ownProxyAlive = false; }
    return ownProxyAlive;
  }

  async function fetchThroughProxies(url, opts={}) {
    // 1) try direct (openapi.twse.com.tw and api.finmindtrade.com allow CORS)
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r;
    } catch {}
    // 2) try same-origin proxy (server.py locally, CF Pages Function in prod)
    if (await checkOwnProxy()) {
      try {
        const r = await fetch(SAME_ORIGIN_PROXY + encodeURIComponent(url), opts);
        if (r.ok) return r;
      } catch {}
    }
    // 3) last resort: public proxies
    for (const wrap of PUBLIC_PROXIES) {
      try {
        const r = await fetch(wrap(url), opts);
        if (r.ok) return r;
      } catch {}
    }
    throw new Error(`All fetch paths failed: ${url}`);
  }

  // ---------- TWSE OpenAPI (CORS OK) ----------
  const TWSE = "https://openapi.twse.com.tw/v1";
  const TPEX = "https://www.tpex.org.tw/openapi/v1";

  async function jsonGet(url) {
    const r = await fetchThroughProxies(url, { cache: "no-store" });
    return r.json();
  }

  async function textGet(url) {
    const r = await fetchThroughProxies(url, { cache: "no-store" });
    return r.text();
  }

  // ===== Real-time MIS =====
  // Encoded ex_ch like "tse_2330.tw|otc_6488.tw"
  async function misSnapshot(exChs) {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exChs.join("|"))}&json=1&delay=0&_=${Date.now()}`;
    const data = await jsonGet(url);
    return data?.msgArray || [];
  }

  // resolve "2330" -> "tse_2330.tw" or "otc_6488.tw" using lookup
  // we try TSE first; if response is empty we try OTC
  async function misSnapshotSmart(codes) {
    if (!codes.length) return [];
    // try all as TSE
    let snap = await misSnapshot(codes.map(c => `tse_${c}.tw`));
    const found = new Set(snap.map(r => r.c));
    const missing = codes.filter(c => !found.has(c));
    if (missing.length) {
      try {
        const otc = await misSnapshot(missing.map(c => `otc_${c}.tw`));
        snap = snap.concat(otc);
      } catch {}
    }
    return snap;
  }

  // normalize MIS row into friendlier shape
  function normalizeMIS(r) {
    const num = v => (v === "-" || v === "" || v == null) ? null : Number(v);
    const bestBidP = (r.b || "").split("_").filter(Boolean).map(Number);
    const bestBidV = (r.g || "").split("_").filter(Boolean).map(Number);
    const bestAskP = (r.a || "").split("_").filter(Boolean).map(Number);
    const bestAskV = (r.f || "").split("_").filter(Boolean).map(Number);
    // price fallback chain: latest → prior-close(pz) → best bid → best ask → yesterday
    const price = num(r.z) ?? num(r.pz) ?? bestBidP[0] ?? bestAskP[0] ?? num(r.y);
    return {
      code: r.c, name: r.n, full: r.nf,
      market: r.ex,                  // "tse" | "otc"
      price,
      open:  num(r.o),
      high:  num(r.h),
      low:   num(r.l),
      ref:   num(r.y),               // 昨收
      uplim: num(r.u),
      dnlim: num(r.w),
      volume: num(r.v),              // 累計張
      lastQty: num(r.tv),            // 當次成交張
      time: r.t,
      tlong: r.tlong,
      ts: num(r.ts),
      bidPrices: bestBidP, bidVols: bestBidV,
      askPrices: bestAskP, askVols: bestAskV,
      live: num(r.z) != null,        // true when market gave fresh z
      raw: r,
    };
  }

  // ===== Indices (加權, 櫃買 via MIS — these are the reliably quoted ones) =====
  async function indicesSnapshot() {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(
      "tse_t00.tw|otc_o00.tw"
    )}&json=1&delay=0&_=${Date.now()}`;
    try {
      const j = await jsonGet(url);
      const out = (j?.msgArray || []).map(r => ({
        code: r.c, name: r.n,
        price: Number(r.z && r.z !== "-" ? r.z : (r.pz && r.pz !== "-" ? r.pz : r.y)),
        ref: Number(r.y),
        time: r.t,
      }));
      // add sector indices from openapi when available (cached daily)
      try {
        const sec = await sectorIndex();
        const want = ["寶島股價指數", "發行量加權股價指數", "台灣公司治理100指數",
                      "電子類指數", "金融保險類指數", "半導體類指數"];
        // Chinese keys come as raw UTF-8 from OpenAPI — use Object.values to pick by position
        sec.forEach(row => {
          const vals = Object.values(row);
          // schema: [日期, 指數, 收盤指數, 漲跌, 漲跌點數, 漲跌百分比, 備註]
          const [date, name, close, dir, diff, pct] = vals;
          if (!name || !close) return;
          if (want.some(w => name.includes(w.replace("指數", "")))) {
            // avoid duplicate 加權 which is already from MIS t00
            if (name.includes("發行量加權")) return;
            const ref = Number(close) - (dir === "-" ? -Number(diff) : Number(diff));
            out.push({
              code: name.slice(0, 4), name,
              price: Number(close),
              ref: isFinite(ref) ? ref : Number(close),
              time: date,
            });
          }
        });
      } catch {}
      return out;
    } catch { return []; }
  }

  // ===== Top movers: derive from STOCK_DAY_ALL (one API call, computed locally) =====
  const _stockDayCache = { t: 0, data: null };
  async function stockDayAll() {
    const now = Date.now();
    if (_stockDayCache.data && now - _stockDayCache.t < 120_000) return _stockDayCache.data;
    try {
      const d = await jsonGet(`${TWSE}/exchangeReport/STOCK_DAY_ALL`);
      _stockDayCache.data = Array.isArray(d) ? d : [];
      _stockDayCache.t = now;
      return _stockDayCache.data;
    } catch { return []; }
  }

  function pctChange(r) {
    const close = Number(r.ClosingPrice);
    const chg = Number(r.Change);
    if (!isFinite(close) || !isFinite(chg) || close - chg === 0) return 0;
    return (chg / (close - chg)) * 100;
  }

  async function topGainers() {
    const all = await stockDayAll();
    return all
      .filter(r => !/^00\d{3,}/.test(r.Code))   // skip ETFs
      .map(r => ({ ...r, _pct: pctChange(r) }))
      .sort((a, b) => b._pct - a._pct).slice(0, 20);
  }
  async function topLosers() {
    const all = await stockDayAll();
    return all
      .filter(r => !/^00\d{3,}/.test(r.Code))
      .map(r => ({ ...r, _pct: pctChange(r) }))
      .sort((a, b) => a._pct - b._pct).slice(0, 20);
  }
  async function topValue() {
    const all = await stockDayAll();
    return all
      .map(r => ({ ...r, _pct: pctChange(r), _val: Number(r.TradeValue) }))
      .sort((a, b) => b._val - a._val).slice(0, 20);
  }

  // Margin trading (raw Chinese field names preserved)
  async function marginTrading() {
    try {
      const d = await jsonGet(`${TWSE}/exchangeReport/MI_MARGN`);
      return d || [];
    } catch { return []; }
  }

  // 類股漲跌 / 指數清單
  async function sectorIndex() {
    try {
      const d = await jsonGet(`${TWSE}/exchangeReport/MI_INDEX`);
      return d || [];
    } catch { return []; }
  }

  // PE / PB / dividend yield per stock
  async function perPbAll() {
    try {
      const d = await jsonGet(`${TWSE}/exchangeReport/BWIBBU_ALL`);
      return d || [];
    } catch { return []; }
  }

  // individual stock daily (specific month)
  async function stockDay(code, yyyymm) {
    try {
      const ym = yyyymm || "";
      const url = `${TWSE}/exchangeReport/STOCK_DAY?stockNo=${code}${ym ? `&date=${ym}01` : ""}`;
      const d = await jsonGet(url);
      return d || [];
    } catch { return []; }
  }

  // ===== FinMind (free 300/hr) =====
  const FM = "https://api.finmindtrade.com/api/v4/data";
  async function finmind(dataset, params={}) {
    const qs = new URLSearchParams({ dataset, ...params }).toString();
    const r = await fetchThroughProxies(`${FM}?${qs}`, { cache: "no-store" });
    const j = await r.json();
    return j?.data || [];
  }

  async function stockPriceHistory(code, startDate) {
    const start = startDate || isoDaysAgo(400);
    const data = await finmind("TaiwanStockPrice", { data_id: code, start_date: start });
    // [{date, stock_id, open, max, min, close, Trading_Volume, Trading_money, spread}, ...]
    return data.map(d => ({
      date: d.date,
      open: +d.open, high: +d.max, low: +d.min, close: +d.close,
      volume: +d.Trading_Volume, amount: +d.Trading_money,
    })).filter(d => d.close > 0);
  }

  async function stockInfo(code) {
    const data = await finmind("TaiwanStockInfo", {});
    return data.find(r => r.stock_id === code);
  }

  async function stockChipFM(code, startDate) {
    const start = startDate || isoDaysAgo(60);
    return finmind("TaiwanStockInstitutionalInvestorsBuySell", { data_id: code, start_date: start });
  }

  async function stockPerPbr(code, startDate) {
    const start = startDate || isoDaysAgo(120);
    return finmind("TaiwanStockPER", { data_id: code, start_date: start });
  }

  // ===== News (Google News RSS — CORS OK via proxy) =====
  async function news(query) {
    const q = encodeURIComponent(query + " 股票 OR 台股");
    const url = `https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    try {
      const xml = await textGet(url);
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, "text/xml");
      return Array.from(doc.querySelectorAll("item")).slice(0, 15).map(it => ({
        title: it.querySelector("title")?.textContent || "",
        link:  it.querySelector("link")?.textContent || "",
        pub:   it.querySelector("pubDate")?.textContent || "",
        src:   it.querySelector("source")?.textContent || "",
      }));
    } catch { return []; }
  }

  // helpers
  function isoDaysAgo(days) {
    const d = new Date(Date.now() - days * 86400_000);
    return d.toISOString().slice(0, 10);
  }

  function isMarketOpen() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const hm = now.getHours() * 60 + now.getMinutes();
    return hm >= 9 * 60 && hm <= 13 * 60 + 30;
  }

  return {
    misSnapshotSmart, normalizeMIS, indicesSnapshot,
    topGainers, topLosers, topValue, marginTrading, sectorIndex, stockDay, perPbAll, stockDayAll,
    stockPriceHistory, stockInfo, stockChipFM, stockPerPbr,
    news, isMarketOpen, isoDaysAgo,
    _fetch: fetchThroughProxies,
  };
})();
