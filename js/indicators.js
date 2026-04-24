/* =========================================================
   Technical indicators — pure-JS, zero deps.
   All functions accept an array of numbers (or candle objects
   with .close/.high/.low/.volume) and return an aligned array.
   ========================================================= */

const TA = (() => {

  const closes = arr => arr.map(x => typeof x === "number" ? x : x.close);
  const highs  = arr => arr.map(x => x.high);
  const lows   = arr => arr.map(x => x.low);

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      prev = (prev == null) ? v : (v - prev) * k + prev;
      if (i >= period - 1) out[i] = prev;
    }
    return out;
  }

  function stdev(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      const slice = values.slice(i - period + 1, i + 1);
      const m = slice.reduce((s, x) => s + x, 0) / period;
      const v = slice.reduce((s, x) => s + (x - m) ** 2, 0) / period;
      out[i] = Math.sqrt(v);
    }
    return out;
  }

  function bollinger(candles, period = 20, mult = 2) {
    const c = closes(candles);
    const mid = sma(c, period);
    const sd = stdev(c, period);
    return {
      mid,
      upper: mid.map((m, i) => m == null ? null : m + mult * sd[i]),
      lower: mid.map((m, i) => m == null ? null : m - mult * sd[i]),
      bandwidth: mid.map((m, i) => m == null ? null : (2 * mult * sd[i]) / m),
    };
  }

  function rsi(candles, period = 14) {
    const c = closes(candles);
    const out = new Array(c.length).fill(null);
    let avgG = 0, avgL = 0;
    for (let i = 1; i < c.length; i++) {
      const ch = c[i] - c[i - 1];
      const g = ch > 0 ? ch : 0;
      const l = ch < 0 ? -ch : 0;
      if (i <= period) { avgG += g; avgL += l;
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
  }

  function macd(candles, fast = 12, slow = 26, signal = 9) {
    const c = closes(candles);
    const ef = ema(c, fast);
    const es = ema(c, slow);
    const dif = c.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    const difClean = dif.map(x => x == null ? 0 : x);
    const dea = ema(difClean, signal).map((v, i) => dif[i] == null ? null : v);
    const osc = dif.map((d, i) => (d != null && dea[i] != null) ? (d - dea[i]) * 2 : null);
    return { dif, dea, osc };
  }

  // Taiwan-style KD (9,3,3) using modified Stochastic
  function kd(candles, period = 9) {
    const n = candles.length;
    const out = { K: new Array(n).fill(null), D: new Array(n).fill(null), RSV: new Array(n).fill(null) };
    let K = 50, D = 50;
    for (let i = 0; i < n; i++) {
      if (i < period - 1) continue;
      const slice = candles.slice(i - period + 1, i + 1);
      const hi = Math.max(...slice.map(x => x.high));
      const lo = Math.min(...slice.map(x => x.low));
      const rsv = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
      K = (2 / 3) * K + (1 / 3) * rsv;
      D = (2 / 3) * D + (1 / 3) * K;
      out.RSV[i] = rsv; out.K[i] = K; out.D[i] = D;
    }
    return out;
  }

  function atr(candles, period = 14) {
    const n = candles.length;
    const tr = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    const trFill = tr.map(x => x == null ? 0 : x);
    return ema(trFill, period);
  }

  // On Balance Volume
  function obv(candles) {
    const out = new Array(candles.length).fill(0);
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1].close;
      const cur  = candles[i].close;
      const v    = candles[i].volume || 0;
      out[i] = out[i - 1] + (cur > prev ? v : cur < prev ? -v : 0);
    }
    return out;
  }

  // Williams %R
  function willR(candles, period = 14) {
    const n = candles.length;
    const out = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      const slice = candles.slice(i - period + 1, i + 1);
      const hi = Math.max(...slice.map(x => x.high));
      const lo = Math.min(...slice.map(x => x.low));
      out[i] = hi === lo ? -50 : ((hi - candles[i].close) / (hi - lo)) * -100;
    }
    return out;
  }

  // support/resistance: pivot highs/lows
  function pivots(candles, lookback = 5) {
    const out = { supports: [], resistances: [] };
    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low  <= candles[i].low)  isLow = false;
      }
      if (isHigh) out.resistances.push({ i, price: candles[i].high });
      if (isLow)  out.supports.push({ i, price: candles[i].low });
    }
    return out;
  }

  // % position within recent N-day range
  function rangePct(candles, period = 20) {
    const last = candles.at(-1);
    if (!last || candles.length < period) return 0.5;
    const slice = candles.slice(-period);
    const hi = Math.max(...slice.map(x => x.high));
    const lo = Math.min(...slice.map(x => x.low));
    if (hi === lo) return 0.5;
    return (last.close - lo) / (hi - lo);
  }

  // volume ratio vs N-day average
  function volRatio(candles, period = 20) {
    const last = candles.at(-1);
    if (!last) return 1;
    const avg = candles.slice(-period - 1, -1).reduce((s, x) => s + (x.volume || 0), 0) / period;
    return avg === 0 ? 1 : (last.volume || 0) / avg;
  }

  return { sma, ema, stdev, bollinger, rsi, macd, kd, atr, obv, willR, pivots, rangePct, volRatio };
})();
