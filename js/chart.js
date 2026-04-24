/* =========================================================
   Canvas K-line chart — zero dep.
   Supports: candles, MA, BB, volume, RSI/MACD/KD (sub panel),
   intraday line mode, crosshair + tooltip.
   ========================================================= */

class KChart {
  constructor(mainCanvas, subCanvas, meta) {
    this.cv = mainCanvas;
    this.sub = subCanvas;
    this.meta = meta || {};
    this.ctx = mainCanvas.getContext("2d");
    this.sctx = subCanvas.getContext("2d");
    this.data = [];
    this.mode = "candle";            // "candle" | "line"
    this.inds = { MA: true, BB: true, VOL: true, RSI: false, MACD: false, KD: false };
    this.subMode = null;             // "RSI" | "MACD" | "KD" | null
    this.hover = null;
    this.theme = {
      bg: "transparent",
      grid: "rgba(120,140,180,0.08)",
      axis: "#7b8697",
      up: "#ff5a6a", dn: "#3ed598", flat: "#9aa3b2",
      ma5: "#ffb547", ma10: "#4cc9f0", ma20: "#7c4dff", ma60: "#ff5ab5",
      bbUp: "rgba(124,77,255,.7)", bbMid: "rgba(124,77,255,.35)", bbLo: "rgba(124,77,255,.7)",
      bbFill: "rgba(124,77,255,.08)",
      vol: "rgba(120,140,180,.35)",
      cross: "rgba(230,240,255,.35)",
    };
    this._setupEvents();
    this._setupResize();
  }

  _setupResize() {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; this.render(); });
    });
    ro.observe(this.cv);
  }

  _dpr() { return window.devicePixelRatio || 1; }

  _fit(canvas) {
    const dpr = this._dpr();
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.floor(rect.width  * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: rect.width, h: rect.height, ctx };
  }

  setData(data, mode = "candle") {
    this.data = data;
    this.mode = mode;
    this.hover = null;
    this.render();
  }

  toggleInd(name) {
    if (["RSI", "MACD", "KD"].includes(name)) {
      this.subMode = this.subMode === name ? null : name;
    } else {
      this.inds[name] = !this.inds[name];
    }
    this.render();
  }

  _setupEvents() {
    this.cv.addEventListener("mousemove", e => {
      const rect = this.cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this.hover = this._xToIndex(x, rect.width);
      this.render();
    });
    this.cv.addEventListener("mouseleave", () => { this.hover = null; this.render(); });
  }

  _xToIndex(x, w) {
    const padL = 10, padR = 60;
    const n = this.data.length;
    if (!n) return null;
    const step = (w - padL - padR) / n;
    const i = Math.floor((x - padL) / step);
    return Math.max(0, Math.min(n - 1, i));
  }

  render() {
    if (!this.data.length) { this._clear(); return; }

    const { w, h, ctx } = this._fit(this.cv);
    ctx.clearRect(0, 0, w, h);

    const padL = 10, padR = 60, padT = 12;
    const showVol = this.inds.VOL;
    const mainH = showVol ? h * 0.75 : h - 20;
    const volH  = showVol ? h - mainH - 20 : 0;

    // --- y-scale for main ---
    const data = this.data;
    let lo = Infinity, hi = -Infinity;
    for (const c of data) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (this.inds.BB) {
      const bb = TA.bollinger(data, 20, 2);
      for (let i = 0; i < bb.upper.length; i++) {
        if (bb.upper[i] != null) hi = Math.max(hi, bb.upper[i]);
        if (bb.lower[i] != null) lo = Math.min(lo, bb.lower[i]);
      }
    }
    const range = hi - lo || 1;
    const pad = range * 0.05;
    lo -= pad; hi += pad;

    const x = i => padL + (i + 0.5) * (w - padL - padR) / data.length;
    const y = p => padT + (hi - p) * (mainH - padT * 2) / (hi - lo);
    const step = (w - padL - padR) / data.length;
    const cw = Math.max(1, step * 0.7);

    // grid
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    const gridN = 5;
    ctx.font = "10px Inter, sans-serif";
    ctx.fillStyle = this.theme.axis;
    ctx.textAlign = "right";
    for (let k = 0; k <= gridN; k++) {
      const gy = padT + (mainH - padT * 2) * k / gridN;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
      const v = hi - (hi - lo) * k / gridN;
      ctx.fillText(v.toFixed(2), w - padR + 4, gy + 3);
    }

    // candles or line
    if (this.mode === "line") {
      ctx.lineWidth = 1.5;
      const first = data[0]?.close;
      const last = data.at(-1)?.close;
      ctx.strokeStyle = last >= first ? this.theme.up : this.theme.dn;
      ctx.beginPath();
      data.forEach((c, i) => {
        const px = x(i), py = y(c.close);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      // fill under
      ctx.lineTo(x(data.length - 1), padT + mainH - padT);
      ctx.lineTo(x(0), padT + mainH - padT);
      ctx.closePath();
      ctx.fillStyle = last >= first ? "rgba(255,90,106,.08)" : "rgba(62,213,152,.08)";
      ctx.fill();
      // reference line at first
      if (first != null) {
        const py = y(first);
        ctx.strokeStyle = "rgba(255,255,255,.2)";
        ctx.setLineDash([3, 3]); ctx.beginPath();
        ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      // candles
      data.forEach((c, i) => {
        const px = x(i);
        const up = c.close >= c.open;
        const color = up ? this.theme.up : this.theme.dn;
        ctx.strokeStyle = color; ctx.fillStyle = color;
        // wick
        ctx.beginPath();
        ctx.moveTo(px, y(c.high)); ctx.lineTo(px, y(c.low));
        ctx.stroke();
        // body
        const yo = y(c.open), yc = y(c.close);
        const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yo - yc));
        ctx.fillRect(px - cw / 2, top, cw, bh);
      });
    }

    // Bollinger
    if (this.inds.BB) {
      const bb = TA.bollinger(data, 20, 2);
      // fill band
      ctx.fillStyle = this.theme.bbFill;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (bb.upper[i] == null) continue;
        const px = x(i), py = y(bb.upper[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      for (let i = data.length - 1; i >= 0; i--) {
        if (bb.lower[i] == null) continue;
        ctx.lineTo(x(i), y(bb.lower[i]));
      }
      ctx.closePath(); ctx.fill();
      this._drawLine(ctx, bb.upper, x, y, this.theme.bbUp, 1);
      this._drawLine(ctx, bb.mid,   x, y, this.theme.bbMid, 1);
      this._drawLine(ctx, bb.lower, x, y, this.theme.bbLo, 1);
    }

    // MA
    if (this.inds.MA) {
      const c = data.map(d => d.close);
      this._drawLine(ctx, TA.sma(c, 5),  x, y, this.theme.ma5,  1.4);
      this._drawLine(ctx, TA.sma(c, 10), x, y, this.theme.ma10, 1.4);
      this._drawLine(ctx, TA.sma(c, 20), x, y, this.theme.ma20, 1.4);
      this._drawLine(ctx, TA.sma(c, 60), x, y, this.theme.ma60, 1.4);
    }

    // MA legend
    ctx.textAlign = "left";
    ctx.font = "11px Inter, sans-serif";
    const last = data.at(-1);
    if (this.inds.MA && last) {
      const maNames = [["MA5", 5, this.theme.ma5], ["MA10", 10, this.theme.ma10], ["MA20", 20, this.theme.ma20], ["MA60", 60, this.theme.ma60]];
      let lx = 12;
      maNames.forEach(([lbl, p, col]) => {
        const v = TA.sma(data.map(d => d.close), p).at(-1);
        if (v == null) return;
        const text = `${lbl} ${v.toFixed(2)}`;
        ctx.fillStyle = col;
        ctx.fillText(text, lx, 14);
        lx += ctx.measureText(text).width + 10;
      });
    }

    // volume panel
    if (showVol) {
      const vMax = Math.max(...data.map(d => d.volume || 0)) || 1;
      const vy = p => (mainH + 10) + (volH - 10) * (1 - p / vMax);
      ctx.strokeStyle = this.theme.grid;
      ctx.beginPath(); ctx.moveTo(padL, mainH + 10); ctx.lineTo(w - padR, mainH + 10); ctx.stroke();
      data.forEach((c, i) => {
        const px = x(i);
        const up = c.close >= c.open;
        ctx.fillStyle = up ? "rgba(255,90,106,.55)" : "rgba(62,213,152,.55)";
        const vh = (volH - 10) * ((c.volume || 0) / vMax);
        ctx.fillRect(px - cw / 2, (mainH + volH) - vh, cw, vh);
      });
      ctx.fillStyle = this.theme.axis;
      ctx.textAlign = "right";
      ctx.fillText(`Vol ${fmtNum(vMax)}`, w - padR + 4, mainH + 20);
    }

    // crosshair + tooltip
    if (this.hover != null) {
      const i = this.hover;
      const c = data[i];
      if (c) {
        const px = x(i);
        ctx.strokeStyle = this.theme.cross;
        ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, mainH + (showVol ? volH : 0));
        ctx.moveTo(padL, y(c.close)); ctx.lineTo(w - padR, y(c.close));
        ctx.stroke(); ctx.setLineDash([]);

        // price tag
        ctx.fillStyle = "#1a2238";
        ctx.fillRect(w - padR + 1, y(c.close) - 8, padR - 2, 16);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(c.close.toFixed(2), w - padR / 2, y(c.close) + 3);

        // date tag
        const label = (c.date || c.time || "").toString();
        if (label) {
          const tw = ctx.measureText(label).width + 12;
          ctx.fillStyle = "#1a2238";
          ctx.fillRect(px - tw / 2, mainH + (showVol ? volH : 0) - 2, tw, 14);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, px, mainH + (showVol ? volH : 0) + 9);
        }

        if (this.meta && this.meta.onHover) this.meta.onHover(c, i);
      }
    } else if (this.meta && this.meta.onHover && data.length) {
      this.meta.onHover(data.at(-1), data.length - 1);
    }

    // --- sub panel (RSI / MACD / KD) ---
    this._renderSub();
  }

  _renderSub() {
    const { w, h, ctx } = this._fit(this.sub);
    ctx.clearRect(0, 0, w, h);
    if (!this.subMode || !this.data.length) return;

    const padL = 10, padR = 60, padT = 8;
    const data = this.data;
    const step = (w - padL - padR) / data.length;
    const x = i => padL + (i + 0.5) * step;

    if (this.subMode === "RSI") {
      const r = TA.rsi(data, 14);
      const y = v => padT + (100 - v) * (h - padT * 2) / 100;
      // bg bands
      ctx.fillStyle = "rgba(255,90,106,.08)"; ctx.fillRect(padL, y(100), w - padL - padR, y(70) - y(100));
      ctx.fillStyle = "rgba(62,213,152,.08)"; ctx.fillRect(padL, y(30), w - padL - padR, y(0) - y(30));
      // lines at 30/50/70
      ctx.strokeStyle = "rgba(120,140,180,.25)"; ctx.setLineDash([2, 3]);
      [30, 50, 70].forEach(v => {
        ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(w - padR, y(v)); ctx.stroke();
      });
      ctx.setLineDash([]);
      this._drawLine(ctx, r, x, y, "#4cc9f0", 1.5);

      // labels
      ctx.fillStyle = "#7b8697"; ctx.font = "10px Inter"; ctx.textAlign = "right";
      ctx.fillText("70", w - padR + 4, y(70) + 3);
      ctx.fillText("30", w - padR + 4, y(30) + 3);
      ctx.textAlign = "left"; ctx.fillStyle = "#4cc9f0";
      ctx.fillText(`RSI(14) ${r.at(-1)?.toFixed(2) ?? "-"}`, 12, 14);
    }

    if (this.subMode === "MACD") {
      const m = TA.macd(data);
      const vals = [...m.dif, ...m.dea, ...m.osc].filter(v => v != null);
      const mx = Math.max(...vals.map(Math.abs)) || 1;
      const y = v => padT + (mx - v) * (h - padT * 2) / (mx * 2);

      ctx.strokeStyle = "rgba(120,140,180,.25)";
      ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke();

      // histogram
      data.forEach((_, i) => {
        const v = m.osc[i]; if (v == null) return;
        ctx.fillStyle = v >= 0 ? "rgba(255,90,106,.7)" : "rgba(62,213,152,.7)";
        const y0 = y(0), yv = y(v);
        ctx.fillRect(x(i) - step * 0.3, Math.min(y0, yv), step * 0.6, Math.abs(yv - y0));
      });
      this._drawLine(ctx, m.dif, x, y, "#ffb547", 1.3);
      this._drawLine(ctx, m.dea, x, y, "#4cc9f0", 1.3);
      ctx.fillStyle = "#ffb547"; ctx.font = "10px Inter"; ctx.textAlign = "left";
      ctx.fillText(`MACD  DIF ${m.dif.at(-1)?.toFixed(3) ?? "-"}  DEA ${m.dea.at(-1)?.toFixed(3) ?? "-"}`, 12, 14);
    }

    if (this.subMode === "KD") {
      const k = TA.kd(data, 9);
      const y = v => padT + (100 - v) * (h - padT * 2) / 100;
      ctx.strokeStyle = "rgba(120,140,180,.25)"; ctx.setLineDash([2, 3]);
      [20, 50, 80].forEach(v => {
        ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(w - padR, y(v)); ctx.stroke();
      });
      ctx.setLineDash([]);
      this._drawLine(ctx, k.K, x, y, "#ffb547", 1.4);
      this._drawLine(ctx, k.D, x, y, "#4cc9f0", 1.4);
      ctx.fillStyle = "#ffb547"; ctx.font = "10px Inter"; ctx.textAlign = "left";
      ctx.fillText(`KD(9)  K ${k.K.at(-1)?.toFixed(2) ?? "-"}  D ${k.D.at(-1)?.toFixed(2) ?? "-"}`, 12, 14);
    }
  }

  _drawLine(ctx, arr, x, y, color, lw = 1) {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]; if (v == null) continue;
      const px = x(i), py = y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  _clear() {
    const { w, h, ctx } = this._fit(this.cv);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#7b8697"; ctx.font = "12px Inter"; ctx.textAlign = "center";
    ctx.fillText("無資料", w / 2, h / 2);
    const s = this._fit(this.sub);
    s.ctx.clearRect(0, 0, s.w, s.h);
  }
}

function fmtNum(v) {
  if (v == null) return "-";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "億";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "萬";
  return v.toString();
}
