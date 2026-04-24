/* =========================================================
   App orchestrator
   ========================================================= */

const APP = (() => {

  // --------- state ---------
  const DEFAULT_WATCH = [
    { code: "2330", name: "台積電" },
    { code: "2317", name: "鴻海" },
    { code: "2454", name: "聯發科" },
    { code: "2412", name: "中華電" },
    { code: "2308", name: "台達電" },
    { code: "2881", name: "富邦金" },
    { code: "2891", name: "中信金" },
    { code: "3008", name: "大立光" },
    { code: "2603", name: "長榮" },
    { code: "2610", name: "華航" },
    { code: "2382", name: "廣達" },
    { code: "2357", name: "華碩" },
    { code: "6505", name: "台塑化" },
    { code: "1216", name: "統一" },
    { code: "2002", name: "中鋼" },
  ];

  const state = {
    watch: loadLocal("watch", DEFAULT_WATCH),
    selected: "2330",
    candles: [],
    chip: [],
    intraday: [],
    realtime: null,
    tf: "1d",
    chart: null,
    timer: null,
    timerIdx: null,
    signals: [],
    gen: 0,                 // generation counter to cancel stale fetches
    lastTickKey: null,      // avoid duplicate tick rows when realtime didn't tick
  };

  // --------- utility ---------
  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function loadLocal(k, def) { try { return JSON.parse(localStorage.getItem("stk_" + k)) ?? def; } catch { return def; } }
  function saveLocal(k, v) { localStorage.setItem("stk_" + k, JSON.stringify(v)); }

  function fmtPrice(v) { if (v == null || isNaN(v)) return "--"; return Number(v).toFixed(2); }
  function fmtInt(v) { if (v == null || isNaN(v)) return "--"; return Math.round(v).toLocaleString(); }
  function fmtChg(v, pct = false) {
    if (v == null || isNaN(v)) return "--";
    const s = v > 0 ? "+" : "";
    return pct ? `${s}${v.toFixed(2)}%` : `${s}${v.toFixed(2)}`;
  }
  function colorCls(v) { return v > 0 ? "up" : v < 0 ? "dn" : "flat"; }
  function toast(msg, ms = 2200) {
    const el = $("#toast"); el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add("hidden"), ms);
  }
  // Escape untrusted text before putting into innerHTML
  function esc(v) {
    if (v == null) return "";
    return String(v).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  // --------- indices ticker ---------
  async function renderIndices() {
    const data = await API.indicesSnapshot();
    const el = $("#indices");
    if (!data.length) return;
    el.innerHTML = data.map(d => {
      const chg = (d.price != null && d.ref != null) ? d.price - d.ref : null;
      const chgp = chg != null && d.ref ? (chg / d.ref) * 100 : null;
      const cls = colorCls(chg);
      return `<div class="idx">
        <div class="idx-name">${esc(d.name || d.code)}</div>
        <div class="idx-val ${cls}">${fmtPrice(d.price)}</div>
        <div class="idx-chg ${cls}">${fmtChg(chg)} (${fmtChg(chgp, true)})</div>
      </div>`;
    }).join("");
  }

  // --------- watchlist ---------
  // Render the shell (DOM) only when the watch set or selection changes.
  function renderWatchShell() {
    const el = $("#watchlist");
    if (!state.watch.length) { el.innerHTML = `<div class="muted" style="padding:14px">尚無自選</div>`; return; }
    el.innerHTML = state.watch.map(w => `
      <div class="wl-row ${w.code === state.selected ? "active" : ""}" data-code="${esc(w.code)}">
        <div class="wl-code">${esc(w.code)}</div>
        <div class="wl-name" title="${esc(w.name)}">${esc(w.name)}</div>
        <div class="wl-price" id="wl-p-${esc(w.code)}">--</div>
        <div class="wl-chg"   id="wl-c-${esc(w.code)}">--</div>
        <div class="wl-del" data-del="${esc(w.code)}" title="移除自選">✕</div>
      </div>`).join("");
    el.querySelectorAll(".wl-row").forEach(row => {
      row.addEventListener("click", e => {
        if (e.target.classList.contains("wl-del")) return;
        selectStock(row.dataset.code);
      });
    });
    el.querySelectorAll(".wl-del").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        removeWatch(btn.dataset.del);
      });
    });
  }

  // Update only prices in-place (no DOM rebuild). Safe to call every 5 sec.
  async function updateWatchPrices() {
    if (!state.watch.length) return;
    try {
      const rows = (await API.misSnapshotSmart(state.watch.map(w => w.code))).map(API.normalizeMIS);
      rows.forEach(r => {
        if (!r.code) return;
        const chg = (r.price != null && r.ref != null) ? r.price - r.ref : null;
        const pct = chg != null && r.ref ? (chg / r.ref) * 100 : null;
        const p = $(`#wl-p-${CSS.escape(r.code)}`), c = $(`#wl-c-${CSS.escape(r.code)}`);
        if (p) {
          const prev = p.textContent;
          const nextTxt = fmtPrice(r.price);
          if (prev !== nextTxt && prev !== "--" && prev !== "") {
            // flash animation on price change
            p.classList.remove("flash-up", "flash-dn");
            void p.offsetWidth;
            p.classList.add(Number(nextTxt) >= Number(prev) ? "flash-up" : "flash-dn");
          }
          p.textContent = nextTxt; p.className = "wl-price " + colorCls(chg);
        }
        if (c) { c.textContent = fmtChg(pct, true); c.className = "wl-chg " + colorCls(chg); }
        const w = state.watch.find(x => x.code === r.code);
        if (w && r.name && w.name !== r.name) {
          w.name = r.name;
          saveLocal("watch", state.watch);
          const nameEl = document.querySelector(`.wl-row[data-code="${CSS.escape(r.code)}"] .wl-name`);
          if (nameEl) { nameEl.textContent = r.name; nameEl.title = r.name; }
        }
      });
    } catch (e) {
      console.warn("watch prices update failed", e);
    }
  }

  // Full render: shell + prices. Use this after add/remove.
  async function renderWatch() {
    renderWatchShell();
    await updateWatchPrices();
  }

  // --------- add / remove watch ---------
  function bindWatchAdd() {
    $("#watch-add-btn").addEventListener("click", addWatch);
    $("#watch-add").addEventListener("keydown", e => { if (e.key === "Enter") addWatch(); });
  }
  async function addWatch() {
    const inp = $("#watch-add");
    const code = inp.value.trim();
    if (!/^[0-9A-Z]{4,6}$/.test(code)) { toast("請輸入 4-6 碼股票代號"); return; }
    if (state.watch.find(w => w.code === code)) { toast("已在自選中"); return; }
    // probe — reject if MIS returns nothing
    try {
      const probe = (await API.misSnapshotSmart([code])).map(API.normalizeMIS);
      if (!probe.length || !probe[0].code) { toast(`查無代號 ${code}`); return; }
      state.watch.push({ code, name: probe[0].name || code });
    } catch {
      // be lenient if probe fails — just add by code
      state.watch.push({ code, name: code });
    }
    saveLocal("watch", state.watch);
    inp.value = "";
    await renderWatch();
    selectStock(code);
  }

  function removeWatch(code) {
    const idx = state.watch.findIndex(w => w.code === code);
    if (idx < 0) return;
    state.watch.splice(idx, 1);
    saveLocal("watch", state.watch);
    renderWatchShell();                             // always rebuild shell so stale row is gone
    if (state.selected === code && state.watch.length) {
      selectStock(state.watch[0].code);             // auto-pick first remaining
    }
    updateWatchPrices().catch(()=>{});
    toast(`已移除 ${code}`);
  }

  // --------- select / load selected ---------
  async function selectStock(code) {
    // cancel any in-flight work by stamping a generation
    const gen = ++state.gen;
    state.selected = code;
    // clear transient per-stock state
    state.signals = [];
    state.realtime = null;
    state.candles = [];
    state.chip = [];
    $("#ticks").innerHTML = `<div class="muted" style="padding:8px">載入中…</div>`;
    $("#book").innerHTML  = `<div class="muted" style="padding:8px">載入中…</div>`;
    $("#fund").innerHTML  = `<div class="muted" style="padding:8px">載入中…</div>`;
    $("#ai-dims").innerHTML = `<div class="muted" style="padding:8px">AI 計算中…</div>`;
    $("#signals").innerHTML = ``;

    $$(".wl-row").forEach(r => r.classList.toggle("active", r.dataset.code === code));
    $("#h-code").textContent = code;
    $("#h-name").textContent = state.watch.find(w => w.code === code)?.name || code;
    try {
      await Promise.all([loadRealtime(), loadHistory()]);
      await loadChip();
    } catch (e) {
      console.warn("selectStock load failed", e);
    }
    if (gen !== state.gen) return;           // newer select happened, bail
    rerenderAll();
    renderNews().catch(()=>{});
  }

  async function loadRealtime() {
    try {
      const rows = (await API.misSnapshotSmart([state.selected])).map(API.normalizeMIS);
      state.realtime = rows[0] || null;
      if (state.realtime?.name) {
        $("#h-name").textContent = state.realtime.name;
        const w = state.watch.find(x => x.code === state.selected);
        if (w) { w.name = state.realtime.name; saveLocal("watch", state.watch); }
      }
    } catch (e) {
      console.warn("realtime failed", e);
    }
  }

  async function loadHistory() {
    try {
      state.candles = await API.stockPriceHistory(state.selected);
    } catch (e) {
      console.warn("history failed", e);
      state.candles = [];
    }
  }

  async function loadChip() {
    try {
      state.chip = await API.stockChipFM(state.selected);
    } catch (e) {
      state.chip = [];
    }
  }

  // --------- render selected stock ---------
  function renderHero() {
    const r = state.realtime;
    const last = state.candles.at(-1);
    const price = r?.price ?? last?.close;
    const ref = r?.ref ?? state.candles.at(-2)?.close;
    const chg = (price != null && ref != null) ? price - ref : null;
    const pct = (chg != null && ref) ? (chg / ref) * 100 : null;

    $("#h-price").textContent = fmtPrice(price);
    $("#h-price").className = colorCls(chg);
    $("#h-chg").textContent  = fmtChg(chg);
    $("#h-chg").className = "chg " + colorCls(chg);
    $("#h-chgp").textContent = pct != null ? `(${fmtChg(pct, true)})` : "--";
    $("#h-chgp").className = "chg " + colorCls(chg);

    $("#h-open").textContent = fmtPrice(r?.open ?? last?.open);
    $("#h-high").textContent = fmtPrice(r?.high ?? last?.high);
    $("#h-low").textContent  = fmtPrice(r?.low ?? last?.low);
    $("#h-ref").textContent  = fmtPrice(ref);

    // MIS r.volume is in 張 (lots of 1000 shares). FinMind candle.volume is
    // in shares — divide by 1000 to get 張. Normalize to 張.
    const volLots = r?.volume != null ? r.volume : (last?.volume != null ? last.volume / 1000 : null);
    $("#h-vol").textContent  = volLots != null ? `${fmtInt(volLots)} 張` : "--";

    // amount: FinMind amount is NT$. If MIS live volume × price exists, compute.
    let amt = last?.amount;
    if (r?.volume != null && r?.price != null) amt = r.volume * 1000 * r.price;
    $("#h-amt").textContent  = amt ? (amt >= 1e8 ? (amt/1e8).toFixed(2) + " 億" : (amt/1e4).toFixed(0)+" 萬") : "--";

    $("#h-uplimit").textContent = fmtPrice(r?.uplim);
    $("#h-dnlimit").textContent = fmtPrice(r?.dnlim);

    const mk = r?.market === "otc" ? "OTC" : "TSE";
    $("#h-market").textContent = mk;

    // XSS-safe name (could contain odd chars from FinMind/MIS)
    $("#h-name").textContent = state.watch.find(w => w.code === state.selected)?.name || state.selected;
  }

  function renderBook() {
    const r = state.realtime;
    const box = $("#book");
    if (!r || !r.askPrices?.length) { box.innerHTML = `<div class="muted">盤中五檔資料載入中…</div>`; return; }
    const asks = r.askPrices.slice(0, 5).map((p, i) => ({ p, v: r.askVols[i] || 0 })).reverse();
    const bids = r.bidPrices.slice(0, 5).map((p, i) => ({ p, v: r.bidVols[i] || 0 }));
    const maxV = Math.max(...asks.map(a => a.v), ...bids.map(b => b.v), 1);
    const last = r.price;
    const inner = (r.bidVols[0] || 0), outer = (r.askVols[0] || 0);
    const ratio = inner + outer > 0 ? (outer / (inner + outer) * 100) : 50;

    let html = "";
    for (const a of asks) html += `
      <div class="book-row">
        <span class="vol">${a.v || ""}</span>
        <span></span>
        <span class="ask">${a.p?.toFixed(2) ?? ""}</span>
        <span class="bar ask-bar" style="width:${(a.v/maxV)*50}%"></span>
      </div>`;
    html += `<div class="book-mid">
      <div>成交 <b class="${colorCls((r.price||0)-(r.ref||0))}">${fmtPrice(last)}</b></div>
      <div>內外比 <b>${(100-ratio).toFixed(0)} / ${ratio.toFixed(0)}</b></div>
    </div>`;
    for (const b of bids) html += `
      <div class="book-row">
        <span class="bid">${b.p?.toFixed(2) ?? ""}</span>
        <span></span>
        <span class="vol">${b.v || ""}</span>
        <span class="bar bid-bar" style="width:${(b.v/maxV)*50}%"></span>
      </div>`;
    box.innerHTML = html;
  }

  function renderTicks() {
    const box = $("#ticks");
    const r = state.realtime;
    if (!r || r.price == null) {
      if (!box.childElementCount || box.firstElementChild?.classList?.contains("muted"))
        box.innerHTML = `<div class="muted" style="padding:8px">盤後無即時成交明細</div>`;
      return;
    }
    // de-dupe: same timestamp + same price → don't add another row
    const key = `${r.time || ""}|${r.price}`;
    if (key === state.lastTickKey) return;
    state.lastTickKey = key;

    // clear placeholder on first real tick
    if (box.firstElementChild?.classList?.contains("muted")) box.innerHTML = "";

    const chg = (r.price || 0) - (r.ref || 0);
    const cls = chg > 0 ? "up" : chg < 0 ? "dn" : "flat";
    const row = document.createElement("div");
    row.className = `ticks-row ${cls}`;
    const t = r.time ? r.time.slice(0, 8) : new Date().toLocaleTimeString("zh-Hant", {hour12:false});
    // ESC: r.time and numeric fields are already trusted (from our normalize)
    row.innerHTML =
      `<span>${esc(t)}</span><b>${fmtPrice(r.price)}</b>` +
      `<span>${r.lastQty ?? "-"}</span><span>${fmtChg(chg)}</span>`;
    box.prepend(row);
    while (box.childElementCount > 60) box.lastChild.remove();
  }

  async function renderFund() {
    const box = $("#fund");
    if (!state.chip?.length) {
      box.innerHTML = `<div class="muted">法人資料載入中…（若空白則該股無法人交易）</div>`;
      return;
    }
    // aggregate last-day values
    const latestDate = state.chip.at(-1)?.date;
    const today = state.chip.filter(r => r.date === latestDate);
    // 10-day accumulated
    const recent = groupByDate(state.chip).slice(-10);

    const inv = (name) => today.find(r => r.name === name);
    const foreign = inv("Foreign_Investor") || inv("Foreign_Dealer_Self") || { buy: 0, sell: 0 };
    const trust   = inv("Investment_Trust") || { buy: 0, sell: 0 };
    const dealer  = inv("Dealer") || inv("Dealer_self") || inv("Dealer_Hedging") || { buy: 0, sell: 0 };

    function net(r) { return ((+r.buy||0) - (+r.sell||0)) / 1000; }   // 千股
    const fNet = net(foreign), iNet = net(trust), dNet = net(dealer);

    let html = `<div class="muted" style="margin-bottom:6px">最新日 ${latestDate || "-"}</div>`;
    html += `<div class="fund-row"><span>外資</span>
      <div>
        <div class="fund-bar"><div class="fill ${fNet<0?'dn':''}" style="width:${Math.min(100, Math.abs(fNet)/50*100)}%"></div></div>
      </div>
      <span class="val ${fNet>0?'up':'dn'}">${fNet>=0?'+':''}${fmtInt(fNet)} 張</span></div>`;
    html += `<div class="fund-row"><span>投信</span>
      <div>
        <div class="fund-bar"><div class="fill ${iNet<0?'dn':''}" style="width:${Math.min(100, Math.abs(iNet)/20*100)}%"></div></div>
      </div>
      <span class="val ${iNet>0?'up':'dn'}">${iNet>=0?'+':''}${fmtInt(iNet)} 張</span></div>`;
    html += `<div class="fund-row"><span>自營商</span>
      <div>
        <div class="fund-bar"><div class="fill ${dNet<0?'dn':''}" style="width:${Math.min(100, Math.abs(dNet)/20*100)}%"></div></div>
      </div>
      <span class="val ${dNet>0?'up':'dn'}">${dNet>=0?'+':''}${fmtInt(dNet)} 張</span></div>`;

    // 10 day history mini
    if (recent.length) {
      html += `<div class="muted" style="margin-top:10px">近10日外資買賣超</div>`;
      html += `<div style="display:flex;gap:2px;height:36px;align-items:flex-end;margin-top:4px">`;
      const maxAbs = Math.max(...recent.map(r => Math.abs(r.foreign))) || 1;
      recent.forEach(r => {
        const h = Math.max(2, (Math.abs(r.foreign)/maxAbs)*34);
        const cls = r.foreign>=0 ? 'up' : 'dn';
        html += `<div style="flex:1;height:${h}px;background:var(--${cls==='up'?'up':'dn'});border-radius:2px;opacity:.8" title="${r.date} ${r.foreign.toFixed(0)}張"></div>`;
      });
      html += `</div>`;
    }
    box.innerHTML = html;
  }

  function groupByDate(chip) {
    const byD = {};
    chip.forEach(r => {
      if (!byD[r.date]) byD[r.date] = { date: r.date, foreign: 0, trust: 0, dealer: 0 };
      const net = ((+r.buy||0) - (+r.sell||0)) / 1000;
      if (r.name?.startsWith("Foreign")) byD[r.date].foreign += net;
      else if (r.name?.startsWith("Investment")) byD[r.date].trust += net;
      else byD[r.date].dealer += net;
    });
    return Object.values(byD).sort((a,b) => a.date.localeCompare(b.date));
  }

  function renderAI() {
    const ai = AI.analyze(state.candles, state.chip, state.realtime);
    if (!ai) {
      $("#ai-score").textContent = "—";
      $("#ai-verdict").textContent = "資料不足";
      $("#ai-dims").innerHTML = `<div class="muted">尚未取得歷史資料</div>`;
      return;
    }
    $("#ai-score").textContent = ai.composite;
    $("#ai-score-bar").style.width = ai.composite + "%";
    $("#ai-verdict").textContent = ai.verdict;
    $("#ai-verdict").className = "gauge-verdict " + (ai.composite >= 55 ? "up" : ai.composite <= 45 ? "dn" : "flat");

    const dimsLabel = {
      trend: "趨勢", momentum: "動能", volume: "量能",
      chip: "籌碼", volatility: "波動", position: "位階",
    };
    const col = v => v >= 0.65 ? "#ff5a6a" : v >= 0.5 ? "#ffb547" : v >= 0.35 ? "#4cc9f0" : "#3ed598";
    let html = "";
    Object.entries(ai.dims).forEach(([k, v]) => {
      html += `<div class="ai-dim-row">
        <div class="ai-dim-head"><span>${dimsLabel[k]}</span><b>${v.toFixed(2)}</b></div>
        <div class="ai-dim-bar"><div class="fill" style="width:${v*100}%;background:${col(v)}"></div></div>
      </div>`;
    });
    html += `<div class="ai-summary">
      <div><span class="label">操作建議：</span>${ai.plan.bias}</div>
      <div style="margin-top:4px">
        進場 <b>${fmtPrice(ai.plan.entry)}</b> ·
        停損 <b class="dn">${fmtPrice(ai.plan.stopLoss)}</b> ·
        目標 <b class="up">${fmtPrice(ai.plan.target)}</b> ·
        R:R <b>${ai.plan.rr}</b>
      </div>
    </div>`;
    $("#ai-dims").innerHTML = html;

    // merge signals (dedup simple)
    const existing = new Set(state.signals.map(s => s.type + s.msg));
    for (const s of ai.signals) {
      if (!existing.has(s.type + s.msg)) state.signals.unshift(s);
    }
    if (state.signals.length > 80) state.signals.length = 80;
    renderSignals();
  }

  function renderSignals() {
    const box = $("#signals");
    if (!state.signals.length) { box.innerHTML = `<div class="muted" style="padding:14px">AI 正在分析中…</div>`; return; }
    const time = d => new Date(d).toLocaleTimeString("zh-Hant", { hour: "2-digit", minute: "2-digit" });
    box.innerHTML = state.signals.slice(0, 30).map(s => {
      const cls = s.type === "buy" ? "sig-buy" :
                  s.type === "sell" ? "sig-sell" :
                  s.type === "warn" ? "sig-warn" : "sig-info";
      const dot = s.type === "buy" ? "▲" : s.type === "sell" ? "▼" : s.type === "warn" ? "⚠" : "●";
      return `<div class="sig-row ${cls}">
        <span class="t">${time(s.t)}</span>
        <span class="dot">${dot}</span>
        <span class="msg">${s.msg}</span>
      </div>`;
    }).join("");
  }

  function renderChart() {
    if (!state.chart) {
      state.chart = new KChart($("#chart"), $("#chart-sub"), {
        onHover(c) {
          $("#k-o").textContent = fmtPrice(c.open);
          $("#k-h").textContent = fmtPrice(c.high);
          $("#k-l").textContent = fmtPrice(c.low);
          $("#k-c").textContent = fmtPrice(c.close);
          $("#k-v").textContent = c.volume ? fmtInt(c.volume) : "--";
        }
      });
    }
    let data = state.candles;
    let mode = "candle";
    if (state.tf === "60d") {
      data = state.candles.slice(-60);
      mode = "line";
    } else if (state.tf === "1w") {
      data = aggregate(data, 5);
    } else if (state.tf === "1mo") {
      data = aggregate(data, 20);
    }
    state.chart.setData(data, mode);
  }

  function aggregate(daily, n) {
    const out = [];
    for (let i = 0; i < daily.length; i += n) {
      const grp = daily.slice(i, i + n);
      if (!grp.length) continue;
      out.push({
        date: grp.at(-1).date,
        open: grp[0].open,
        high: Math.max(...grp.map(x => x.high)),
        low:  Math.min(...grp.map(x => x.low)),
        close: grp.at(-1).close,
        volume: grp.reduce((s, x) => s + (x.volume || 0), 0),
      });
    }
    return out;
  }

  function rerenderAll() {
    renderHero();
    renderBook();
    renderFund();
    renderChart();
    renderAI();
    renderTicks();
  }

  // --------- top movers ---------
  async function renderMovers() {
    try {
      const [g, l, v] = await Promise.all([API.topGainers(), API.topLosers(), API.topValue()]);
      fillMovers("#gainers", g);
      fillMovers("#losers", l);
      fillMovers("#value", v);
    } catch (e) {
      console.warn("movers failed", e);
      $("#gainers").innerHTML = $("#losers").innerHTML = $("#value").innerHTML = `<div class="muted" style="padding:10px">排行資料盤後才會更新</div>`;
    }
  }

  function fillMovers(sel, rows) {
    const box = $(sel);
    if (!rows || !rows.length) { box.innerHTML = `<div class="muted" style="padding:10px">盤後更新</div>`; return; }
    const norm = rows.map(r => ({
      code: r.Code,
      name: r.Name,
      price: Number(r.ClosingPrice),
      chg: Number(r.Change),
      chgp: Number(r._pct ?? 0),
    })).slice(0, 15);
    box.innerHTML = norm.map(r => `
      <div class="mv-row" data-code="${esc(r.code || '')}">
        <div>${esc(r.code || '')}</div>
        <div>${esc(r.name || '')}</div>
        <div class="mv-price ${colorCls(r.chg)}">${fmtPrice(r.price)}</div>
        <div class="mv-chgp ${colorCls(r.chg)}">${fmtChg(r.chgp, true)}</div>
      </div>`).join("");
    box.querySelectorAll(".mv-row").forEach(row => {
      row.addEventListener("click", () => {
        const c = row.dataset.code;
        if (!c) return;
        const already = state.watch.find(w => w.code === c);
        if (!already) {
          state.watch.push({ code: c, name: norm.find(n => n.code === c)?.name || c });
          saveLocal("watch", state.watch);
          renderWatch();
        }
        selectStock(c);
      });
    });
  }

  async function renderSectors() {
    const box = $("#sectors");
    try {
      const data = await API.sectorIndex();
      if (!data || !data.length) { box.innerHTML = `<div class="muted" style="padding:10px">盤後更新</div>`; return; }
      // OpenAPI returns Chinese field names; extract by position
      // columns: [日期, 指數, 收盤指數, 漲跌, 漲跌點數, 漲跌百分比, 特殊處理註記]
      const rows = data.map(r => {
        const vals = Object.values(r);
        const name = vals[1] || "";
        const close = Number(vals[2] || 0);
        const dir = vals[3] || "";     // "+" / "-" / ""
        const diff = Number(vals[4] || 0);
        const chgp = Number(vals[5] || 0);
        const chg = dir === "-" ? -diff : diff;
        return { name, close, chg, chgp };
      }).filter(r => {
          const n = r.name || "";
          // keep sector indices & curated thematic ones; drop report/redundant variants
          if (/報酬指數|兩倍槓桿|反向指數|RI/i.test(n)) return false;
          return /類|半導體|電子|金融|航運|水泥|鋼鐵|塑膠|紡織|建材|貿易|食品|油電|汽車|生技|醫療|造紙|玻璃|觀光|資訊|通信|光電|化學|電機|橡膠|百貨|運輸|電腦|零組件|服務/i.test(n);
        })
        .sort((a,b) => (b.chgp || 0) - (a.chgp || 0));
      if (!rows.length) { box.innerHTML = `<div class="muted" style="padding:10px">無類股資料</div>`; return; }
      const maxAbs = Math.max(...rows.map(r => Math.abs(r.chgp || 0))) || 1;
      box.innerHTML = rows.slice(0, 20).map(r => {
        const w = (Math.abs(r.chgp || 0) / maxAbs) * 100;
        const up = (r.chgp || 0) >= 0;
        return `<div class="sec-row">
          <span>${esc(r.name)}</span>
          <div class="sec-bar"><div class="f" style="width:${w}%;background:${up?'var(--up)':'var(--dn)'}"></div></div>
          <span class="${colorCls(r.chg)}">${fmtChg(r.chgp, true)}</span>
        </div>`;
      }).join("");
    } catch (e) { box.innerHTML = `<div class="muted" style="padding:10px">類股資料載入失敗</div>`; }
  }

  // --------- news ---------
  async function renderNews() {
    const box = $("#news");
    const name = $("#h-name").textContent.trim();
    const code = state.selected;
    const q = `${code} ${name}`.trim() || "台股";
    box.innerHTML = `<div class="muted" style="padding:10px">新聞載入中…</div>`;
    try {
      const list = await API.news(q);
      if (!list.length) { box.innerHTML = `<div class="muted" style="padding:10px">目前無相關新聞</div>`; return; }
      // sanitize — news titles/links come from third party
      box.innerHTML = list.slice(0, 12).map(n => {
        const link = /^https?:\/\//i.test(n.link) ? n.link : "#";
        const pub = n.pub ? new Date(n.pub) : null;
        const when = pub && !isNaN(pub) ? pub.toLocaleString("zh-Hant", {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"}) : "";
        return `
          <div class="news-item">
            <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
            <div class="src">${esc(n.src || "")} · ${esc(when)}</div>
          </div>`;
      }).join("");
    } catch (e) {
      box.innerHTML = `<div class="muted" style="padding:10px">新聞載入失敗</div>`;
    }
  }

  // --------- scanner ---------
  async function runScanner() {
    const box = $("#scanner-result");
    box.innerHTML = `<div class="muted">掃描中…</div>`;
    const pool = state.watch.map(w => w.code);
    if (!pool.length) { box.innerHTML = `<div class="muted">請先加入自選</div>`; return; }
    const want = {
      rs: $("#scan-rs").checked,
      vol: $("#scan-volspike").checked,
      brk: $("#scan-break").checked,
      foreign: $("#scan-foreign").checked,
    };
    const results = [];
    for (const code of pool) {
      try {
        const hist = await API.stockPriceHistory(code, API.isoDaysAgo(120));
        if (hist.length < 30) continue;
        const tags = [];
        const c = hist.at(-1), prev20 = hist.at(-21);
        if (want.rs && prev20 && (c.close - prev20.close) / prev20.close > 0.08) tags.push("RS");
        const vr = TA.volRatio(hist, 20);
        if (want.vol && vr > 2) tags.push(`爆量${vr.toFixed(1)}×`);
        const ma20 = TA.sma(hist.map(x=>x.close), 20).at(-1);
        if (want.brk && ma20 && c.close > ma20 * 1.02) tags.push("突破MA20");
        if (want.foreign) {
          try {
            const chip = await API.stockChipFM(code, API.isoDaysAgo(20));
            const byD = groupByDate(chip).slice(-5);
            const pos = byD.filter(r => r.foreign > 0).length;
            if (pos >= 4) tags.push("外資連買");
          } catch {}
        }
        if (tags.length) results.push({ code, name: (state.watch.find(w=>w.code===code)||{}).name || code, tags });
      } catch {}
    }
    if (!results.length) { box.innerHTML = `<div class="muted">無符合條件之股票</div>`; return; }
    box.innerHTML = results.map(r => `
      <div class="sr-row" data-code="${esc(r.code)}">
        <span>${esc(r.code)}</span>
        <span>${esc(r.name)}</span>
        <span class="tag-up">${esc(r.tags.join(" · "))}</span>
      </div>`).join("");
    box.querySelectorAll(".sr-row").forEach(row => row.addEventListener("click", () => selectStock(row.dataset.code)));
  }

  // --------- clock & auto refresh ---------
  function startClock() {
    setInterval(() => {
      const d = new Date();
      $("#clock").textContent = d.toLocaleTimeString("zh-Hant", { hour12: false });
      const open = API.isMarketOpen();
      const ms = $("#market-status");
      ms.textContent = open ? "盤中" : "盤後";
      ms.className = "pill " + (open ? "live" : "closed");
    }, 1000);
  }

  function startAutoRefresh() {
    const tick = async () => {
      if (document.hidden) return;
      try {
        await loadRealtime();
        renderHero();
        renderBook();
        renderTicks();
        updateWatchPrices().catch(()=>{});      // lightweight: price-only
      } catch (e) {
        console.warn("tick failed", e);
      }
      $("#last-update").textContent = "更新於 " + new Date().toLocaleTimeString("zh-Hant", { hour12: false });
    };
    state.timer = setInterval(tick, 5000);
  }

  // --------- segment toolbars ---------
  function bindToolbars() {
    $$("#tf-seg button").forEach(b => b.addEventListener("click", () => {
      $$("#tf-seg button").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      state.tf = b.dataset.tf;
      if (state.candles.length) renderChart();
    }));
    $$("#ind-seg button").forEach(b => b.addEventListener("click", () => {
      if (!state.chart) {
        // chart not ready yet — still flip visual so state is remembered, re-sync later
        b.classList.toggle("on");
        return;
      }
      const name = b.dataset.ind;
      const subs = ["RSI", "MACD", "KD"];
      if (subs.includes(name)) {
        $$("#ind-seg button").forEach(x => { if (subs.includes(x.dataset.ind)) x.classList.remove("on"); });
        if (state.chart.subMode !== name) b.classList.add("on"); else b.classList.remove("on");
        state.chart.toggleInd(name);
      } else {
        b.classList.toggle("on");
        state.chart.toggleInd(name);
      }
    }));
    $("#news-refresh").addEventListener("click", renderNews);
    $("#scan-btn").addEventListener("click", runScanner);

    // sources modal
    const modal = $("#sources-modal");
    const openModal = () => modal.classList.remove("hidden");
    const closeModal = () => modal.classList.add("hidden");
    $("#sources-btn").addEventListener("click", openModal);
    $("#sources-close").addEventListener("click", closeModal);
    modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { closeModal(); closeHunter(); }
    });

    // hunter modal
    const hmodal = $("#hunter-modal");
    const openHunter = () => {
      hmodal.classList.remove("hidden");
      renderHunter();
    };
    const closeHunter = () => hmodal.classList.add("hidden");
    $("#hunter-btn").addEventListener("click", openHunter);
    $("#hunter-close").addEventListener("click", closeHunter);
    hmodal.querySelector(".modal-backdrop").addEventListener("click", closeHunter);
    $("#hunter-toggle").addEventListener("click", toggleHunter);
    $("#hunter-clear").addEventListener("click", () => {
      if (confirm("確定清空所有獵手歷史訊號？(無法復原)")) { Hunter.clearHistory(); renderHunter(); }
    });
    $("#hunter-export").addEventListener("click", exportHunterCSV);
    Hunter.subscribe(() => renderHunter());
  }

  // --------- hunter ---------
  async function toggleHunter() {
    if (Hunter.running) {
      Hunter.stop();
    } else {
      await Hunter.requestNotifyPerm();
      Hunter.start({ minComposite: 60, freq: 180_000 });
    }
    renderHunter();
  }

  function renderHunter() {
    if ($("#hunter-modal")?.classList.contains("hidden")) {
      renderHunterBadge();   // still update badge when modal closed
      return;
    }
    const signals = Hunter.signals;
    const stats = Hunter.getStats();
    const open = signals.filter(s => s.status === "open");
    const closed = signals.filter(s => s.status !== "open");

    // toolbar
    $("#hunter-toggle").textContent = Hunter.running ? "⏸ 停止獵盤" : "▶ 開始獵盤";
    $("#hunter-toggle").classList.toggle("on", Hunter.running);
    const dot = $("#hunter-status-dot");
    dot.classList.remove("running", "scanning");
    if (Hunter.scanning) dot.classList.add("scanning");
    else if (Hunter.running) dot.classList.add("running");
    $("#hunter-status-text").textContent =
      Hunter.scanning ? "掃描中…" :
      Hunter.running  ? (API.isMarketOpen() ? "監控中（盤中）" : "待命中（盤後，只更新結果）") :
                        "閒置";
    $("#hunter-universe-n").textContent = Hunter.universe.length || "--";
    $("#hunter-min-score").textContent = Hunter.config.minComposite;
    $("#hunter-last-scan").textContent = Hunter.lastScan ?
      new Date(Hunter.lastScan).toLocaleTimeString("zh-Hant", { hour12: false }) : "--";

    // open signals
    $("#hunter-open-count").textContent = open.length;
    const list = $("#hunter-open-list");
    if (!open.length) {
      list.innerHTML = `<div class="muted" style="padding:14px">
        ${Hunter.running ? "監控中，等待訊號…盤中約每 3 分鐘掃描一次。" : "尚無訊號。按「開始獵盤」啟動。"}
      </div>`;
    } else {
      list.innerHTML = open.slice(0, 30).map(renderSigCard).join("");
      list.querySelectorAll(".hunter-sig-card").forEach((el, i) => {
        el.addEventListener("click", () => el.classList.toggle("expanded"));
        const code = el.dataset.code;
        el.querySelectorAll(".goto").forEach(btn => btn.addEventListener("click", e => {
          e.stopPropagation();
          if (!state.watch.find(w => w.code === code)) {
            state.watch.push({ code, name: open[i].name || code });
            saveLocal("watch", state.watch);
            renderWatchShell();
          }
          selectStock(code);
          $("#hunter-modal").classList.add("hidden");
        }));
      });
    }

    // stats panel
    renderStatsPanel(stats);

    // history table
    renderHunterHistory(closed);
    $("#hunter-history-count").textContent = closed.length;

    // badge
    renderHunterBadge();
  }

  function renderSigCard(s) {
    const now = s.lastPrice ?? s.entry;
    const pnl = ((now - s.entry) / s.entry) * 100;
    const cls = pnl > 0 ? "up" : pnl < 0 ? "dn" : "flat";
    // progress visualization: stop(-100%)---entry(0)---target(+100%)
    const range = Math.max(s.target - s.entry, s.entry - s.stopLoss, 0.001);
    let offset;
    if (now >= s.entry) offset = Math.min(50 + (now - s.entry) / (s.target - s.entry) * 50, 100);
    else offset = Math.max(50 - (s.entry - now) / (s.entry - s.stopLoss) * 50, 0);
    const barColor = pnl > 0 ? "var(--up)" : "var(--dn)";
    const barW = Math.abs(offset - 50);
    const barL = Math.min(offset, 50);
    return `
      <div class="hunter-sig-card" data-code="${esc(s.code)}">
        <div class="sig-top">
          <div>
            <span class="sig-code">${esc(s.code)}</span>
            <span class="sig-name">${esc(s.name || "")}</span>
            <span class="sig-trigger">${esc(s.trigger)}</span>
          </div>
          <div class="sig-score">${s.composite}</div>
        </div>
        <div class="sig-grid">
          <div><span>進場</span><b>${s.entry.toFixed(2)}</b></div>
          <div><span>停損</span><b class="dn">${s.stopLoss.toFixed(2)}</b></div>
          <div><span>目標</span><b class="up">${s.target.toFixed(2)}</b></div>
          <div><span>R:R</span><b>${s.rr.toFixed(2)}</b></div>
          <div><span>現價</span><b class="${cls}">${now.toFixed(2)}</b></div>
          <div><span>P&L</span><b class="${cls}">${pnl>0?"+":""}${pnl.toFixed(2)}%</b></div>
          <div><span>觸發</span><b>${new Date(s.firedAt).toLocaleTimeString("zh-Hant",{hour12:false,hour:"2-digit",minute:"2-digit"})}</b></div>
          <div><span>評級</span><b>${esc(s.verdict)}</b></div>
        </div>
        <div class="sig-progress">
          <div class="fill" style="left:${barL}%;width:${barW}%;background:${barColor}"></div>
        </div>
        <div class="sig-sources">
          <div style="color:var(--muted);margin-bottom:4px">資料來源（每筆訊號可溯源）：</div>
          ${s.sources.filter(src => src.url).map(src =>
            `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)} →</a>`
          ).join("")}
          <div style="color:var(--muted);margin-top:4px">MIS 快照時間: ${esc(s.sources.find(x=>x.type==="snapshot-time")?.ts||"-")}</div>
          <div style="margin-top:6px;font-size:11px">
            所有訊號: ${s.allSignals.map(m => `<span style="background:rgba(76,201,240,.1);padding:1px 6px;border-radius:4px;margin-right:3px">${esc(m)}</span>`).join("")}
          </div>
          <div style="margin-top:6px"><button class="btn-sm goto">開啟主圖分析 →</button></div>
        </div>
      </div>`;
  }

  function renderStatsPanel(stats) {
    const box = $("#hunter-stats-grid");
    const lbl = $("#hunter-sample-label");
    lbl.textContent = `${stats.decisive} 筆決勝 · ${stats.confidence}`;

    const wr = stats.winRate != null ? (stats.winRate*100).toFixed(1) + "%" : "—";
    const ar = stats.avgReturnClosed != null ? (stats.avgReturnClosed*100).toFixed(2)+"%" : "—";
    const ex = stats.expectancy != null ? (stats.expectancy*100).toFixed(2)+"%" : "—";
    const aw = stats.avgWin != null ? "+"+(stats.avgWin*100).toFixed(2)+"%" : "—";
    const al = stats.avgLoss != null ? (stats.avgLoss*100).toFixed(2)+"%" : "—";

    box.innerHTML = `
      <div class="stat big"><div class="label">總勝率</div><div class="value">${wr}</div>
        <div class="sub">目標達成 / (目標+停損)</div></div>
      <div class="stat"><div class="label">累計訊號</div><div class="value">${stats.total}</div></div>
      <div class="stat"><div class="label">進行中</div><div class="value">${stats.open}</div></div>
      <div class="stat"><div class="label">碰到目標</div><div class="value up">${stats.wins}</div></div>
      <div class="stat"><div class="label">碰到停損</div><div class="value dn">${stats.stops}</div></div>
      <div class="stat"><div class="label">平均獲利</div><div class="value up">${aw}</div></div>
      <div class="stat"><div class="label">平均虧損</div><div class="value dn">${al}</div></div>
      <div class="stat big"><div class="label">期望值（每筆預期報酬）</div><div class="value">${ex}</div>
        <div class="sub">${stats.decisive < 30 ? "⚠ 樣本 < 30 筆，此數字尚不可信賴" : "樣本夠，可作為決策參考"}</div></div>
    `;
  }

  function renderHunterHistory(closed) {
    const body = $("#hunter-history-body");
    const rows = closed.slice(0, 30);
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="11" class="muted" style="padding:14px;text-align:center">尚無結束訊號</td></tr>`;
      return;
    }
    const stMap = { win:"碰目標 ✓", stop:"碰停損 ✗", expired:"逾期 ○" };
    body.innerHTML = rows.map(s => {
      const pnl = (s.outcomePct || 0) * 100;
      const cls = pnl > 0 ? "up" : pnl < 0 ? "dn" : "";
      return `<tr>
        <td>${new Date(s.firedAt).toLocaleDateString("zh-Hant",{month:"2-digit",day:"2-digit"})} ${new Date(s.firedAt).toLocaleTimeString("zh-Hant",{hour12:false,hour:"2-digit",minute:"2-digit"})}</td>
        <td>${esc(s.code)}</td>
        <td>${esc(s.name||"")}</td>
        <td>${esc(s.trigger)}</td>
        <td>${s.entry.toFixed(2)}</td>
        <td>${s.stopLoss.toFixed(2)}</td>
        <td>${s.target.toFixed(2)}</td>
        <td>${s.rr.toFixed(2)}</td>
        <td>${s.composite}</td>
        <td class="status-${s.status}">${stMap[s.status] || s.status}</td>
        <td class="${cls}">${pnl>0?"+":""}${pnl.toFixed(2)}%</td>
      </tr>`;
    }).join("");
  }

  function renderHunterBadge() {
    const open = Hunter.signals.filter(s => s.status === "open").length;
    const badge = $("#hunter-badge");
    if (open > 0) {
      badge.textContent = open;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function exportHunterCSV() {
    const rows = [
      ["firedAt","code","name","trigger","entry","stopLoss","target","rr","composite","verdict","status","outcomePct","lastPrice","closedAt"]
    ];
    Hunter.signals.forEach(s => rows.push([
      new Date(s.firedAt).toISOString(),
      s.code, s.name, s.trigger, s.entry, s.stopLoss, s.target, s.rr, s.composite, s.verdict,
      s.status, s.outcomePct ?? "", s.lastPrice ?? "", s.closedAt ? new Date(s.closedAt).toISOString() : ""
    ]));
    const csv = rows.map(r => r.map(v => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    }).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `liumai-hunter-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --------- boot ---------
  async function boot() {
    // install global error handlers so we surface any stray problems
    window.addEventListener("error", e => console.error("GlobalError:", e.message, e.filename, e.lineno));
    window.addEventListener("unhandledrejection", e => console.error("UnhandledPromise:", e.reason));

    bindWatchAdd();
    bindToolbars();
    startClock();

    // Probe proxy availability; warn if totally offline
    try {
      const probe = await API.misSnapshotSmart(["2330"]);
      if (!probe.length) toast("資料代理連線不穩，請確認 server.py 是否啟動");
    } catch (e) {
      console.error(e);
      toast("⚠ 無法取得即時資料。請執行 python server.py 或雙擊 啟動.bat");
    }

    renderIndices().catch(console.warn);
    await renderWatch();
    await selectStock(state.selected);
    renderMovers().catch(console.warn);
    renderSectors().catch(console.warn);
    startAutoRefresh();

    // slow refresh: movers/sectors/news
    setInterval(() => { renderMovers().catch(()=>{}); renderSectors().catch(()=>{}); }, 120_000);
    setInterval(() => { renderNews().catch(()=>{}); }, 300_000);
    setInterval(() => { renderIndices().catch(()=>{}); }, 15_000);
  }

  document.addEventListener("DOMContentLoaded", boot);
  return { state, selectStock };
})();
