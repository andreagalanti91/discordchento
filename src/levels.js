// "Liquidity Levels" — a mechanical version of the channel's method.
// 1H pivots → clustered into zones (ATR × zoneMult) → levels ranked by touches.
// Limit ladders are rested on the nearest strong level on each side; exits are
// TP1 at tp1R (partial + stop to breakeven), TP2 at the next opposite level,
// hard stop beyond the ladder, time stop.
const { candles } = require('./market');

const DEFAULTS = {
  name: 'Liquidity Levels',
  lookbackH: 24 * 21,
  pivot: 5,
  zoneMult: 0.3,
  minTouches: 3,
  minDistATR: 0.5,     // level must be at least this far (a limit, not a chase)
  maxDistATR: 6,
  frontrunATR: 0.1,    // rest leg 1 slightly before the level
  ladderATR: 0.4,      // leg 2 this far beyond the level
  ladderWeights: [0.4, 0.6],
  slATR: 1.0,          // stop beyond the level
  tp1R: 1.0,
  beR: null,           // move stop to breakeven once price runs this many R (null = only at TP1)
  tp1Frac: 0.5,
  tp2: 'level',        // 'level' = next opposite level, or a number of R
  maxHoldH: 72,
  trendFilter: false,  // only trade with EMA(trendLen) 1H direction
  trendLen: 200,
  hedge: true,         // allow long and short at the same time
  feeMaker: 0.0002,
  feeTaker: 0.0005,
  riskPct: 1,
};

function atrSeries(h, len = 14) {
  const out = [];
  let a = null;
  for (let i = 0; i < h.length; i++) {
    const tr = i ? Math.max(h[i].h - h[i].l, Math.abs(h[i].h - h[i - 1].c), Math.abs(h[i].l - h[i - 1].c)) : h[i].h - h[i].l;
    a = a == null ? tr : (a * (len - 1) + tr) / len;
    out.push(a);
  }
  return out;
}
function emaSeries(v, len) { const k = 2 / (len + 1); let e = v[0]; return v.map((x) => (e = x * k + e * (1 - k))); }

function toHourly(m15) {
  const out = [];
  for (const k of m15) {
    const t = Math.floor(k.t / 3600e3) * 3600e3;
    const last = out[out.length - 1];
    if (!last || last.t !== t) out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c });
    else { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; }
  }
  return out;
}

// Levels visible at the close of hour i (pivots need `pivot` bars on the right).
function levelsAt(h, i, atr, c) {
  const from = Math.max(c.pivot, i - c.lookbackH);
  const piv = [];
  for (let j = from; j <= i - c.pivot; j++) {
    let hi = true, lo = true;
    for (let k = 1; k <= c.pivot; k++) {
      if (h[j - k].h >= h[j].h || h[j + k].h > h[j].h) hi = false;
      if (h[j - k].l <= h[j].l || h[j + k].l < h[j].l) lo = false;
      if (!hi && !lo) break;
    }
    if (hi) piv.push(h[j].h);
    if (lo) piv.push(h[j].l);
  }
  piv.sort((a, b) => a - b);
  const zone = atr[i] * c.zoneMult;
  const levels = [];
  for (const p of piv) {
    const L = levels[levels.length - 1];
    if (L && p - L.max <= zone) { L.sum += p; L.n++; L.max = p; L.price = L.sum / L.n; }
    else levels.push({ sum: p, n: 1, max: p, price: p });
  }
  return levels.map((l) => ({ price: l.price, touches: l.n }));
}

async function loadData(from, to) {
  const m15 = await candles('BTCUSDT', '15m', from, to);
  const h = toHourly(m15);
  return { m15, h, atr: atrSeries(h), ema: emaSeries(h.map((x) => x.c), DEFAULTS.trendLen) };
}

// Precompute levels per hour for each zoneMult (the expensive part of a grid search).
function precomputeLevels(data, cfg) {
  const c = { ...DEFAULTS, ...cfg };
  const res = new Array(data.h.length);
  for (let i = c.pivot * 2 + 15; i < data.h.length; i++) res[i] = levelsAt(data.h, i, data.atr, c);
  return res;
}

function simulate(data, levelsByHour, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const { m15, h, atr, ema } = data;
  const hourIdx = new Map(h.map((x, i) => [x.t, i]));
  const trades = [];
  const pos = { LONG: null, SHORT: null };
  const orders = { LONG: [], SHORT: [] };
  let equity = 100;
  const curve = [];
  let lastHour = -1;

  const closeTrade = (side, px, t, reason, fee) => {
    const p = pos[side];
    const d = side === 'LONG' ? 1 : -1;
    const r = p.open * ((px - p.avg) * d) / p.risk;
    p.realR += r;
    p.feeR += p.open * (fee * px) / p.risk;
    p.open = 0;
    const netR = p.realR - p.feeR;
    equity *= 1 + (netR * c.riskPct) / 100;
    trades.push({ side, level: p.level, touches: p.touches, entry: +p.avg.toFixed(1), stop: +p.stop0.toFixed(1), openedAt: p.t, closedAt: t, exit: +px.toFixed(1), reason, r: +netR.toFixed(3), tp1: p.tp1Hit });
    pos[side] = null;
  };

  for (const b of m15) {
    const hourT = Math.floor(b.t / 3600e3) * 3600e3 - 3600e3; // last closed hour
    const hi = hourIdx.get(hourT);
    if (hi != null && hi !== lastHour && levelsByHour[hi]) {
      lastHour = hi;
      const px = h[hi].c;
      const A = atr[hi];
      const lv = levelsByHour[hi].filter((l) => l.touches >= c.minTouches);
      for (const side of ['LONG', 'SHORT']) {
        if (pos[side]) continue;
        if (!c.hedge && pos[side === 'LONG' ? 'SHORT' : 'LONG']) { orders[side] = []; continue; }
        if (c.trendFilter && (side === 'LONG' ? px < ema[hi] : px > ema[hi])) { orders[side] = []; continue; }
        const cands = lv.filter((l) => side === 'LONG'
          ? l.price < px - c.minDistATR * A && l.price > px - c.maxDistATR * A
          : l.price > px + c.minDistATR * A && l.price < px + c.maxDistATR * A);
        cands.sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px));
        const L = cands[0];
        if (!L) { orders[side] = []; continue; }
        const d = side === 'LONG' ? 1 : -1;
        const opp = lv.filter((l) => (l.price - px) * d > c.minDistATR * A).sort((a, b) => (a.price - b.price) * d)[0];
        orders[side] = [
          { price: L.price + d * c.frontrunATR * A, w: c.ladderWeights[0] },
          { price: L.price - d * c.ladderATR * A, w: c.ladderWeights[1] },
        ].map((o) => ({ ...o, level: L.price, touches: L.touches, stop: L.price - d * c.slATR * A, target: opp ? opp.price : null }));
      }
    }

    for (const side of ['LONG', 'SHORT']) {
      const d = side === 'LONG' ? 1 : -1;
      let p = pos[side];
      // stops first (conservative)
      if (p) {
        if (side === 'LONG' ? b.l <= p.stop : b.h >= p.stop) { closeTrade(side, side === 'LONG' ? Math.min(p.stop, b.o) : Math.max(p.stop, b.o), b.t, p.tp1Hit ? 'breakeven' : p.beSet ? 'breakeven' : 'stop', c.feeTaker); continue; }
      }
      // fills
      let filledNow = false;
      for (const o of [...orders[side]]) {
        if (side === 'LONG' ? b.l > o.price : b.h < o.price) continue;
        const fillPx = side === 'LONG' ? Math.min(o.price, b.o) : Math.max(o.price, b.o);
        if (!p) {
          p = pos[side] = { t: b.t, avg: fillPx, size: 0, open: 0, realR: 0, feeR: 0, tp1Hit: false, level: o.level, touches: o.touches, stop: o.stop, stop0: o.stop, target: o.target };
        }
        p.avg = (p.avg * p.size + fillPx * o.w) / (p.size + o.w);
        p.size += o.w; p.open += o.w;
        p.feeR = 0; // recomputed on risk below
        orders[side] = orders[side].filter((x) => x !== o);
        filledNow = true;
      }
      if (p) {
        p.risk = Math.abs(p.avg - p.stop0);
        // Fill bar: we can't know the intrabar order, so a touched stop wins
        // and no target is credited on the same bar.
        if (filledNow) {
          if (side === 'LONG' ? b.l <= p.stop : b.h >= p.stop) { if (!p.feeR) p.feeR = p.size * (c.feeMaker * p.avg) / p.risk; closeTrade(side, p.stop, b.t, 'stop', c.feeTaker); }
          continue;
        }
        if (p.open > 0 && p.feeR === 0) p.feeR = p.size * (c.feeMaker * p.avg) / p.risk;
        const tp1 = p.avg + d * c.tp1R * p.risk;
        const tp2 = c.tp2 === 'level' ? (p.target && (p.target - p.avg) * d > c.tp1R * p.risk ? p.target : p.avg + d * 2 * c.tp1R * p.risk) : p.avg + d * c.tp2 * p.risk;
        if (c.beR && !p.beSet && (side === 'LONG' ? b.h >= p.avg + c.beR * p.risk : b.l <= p.avg - c.beR * p.risk)) {
          p.beSet = true; p.stop = p.avg + d * 0.05 * p.risk; orders[side] = [];
        }
        if (!p.tp1Hit && (side === 'LONG' ? b.h >= tp1 : b.l <= tp1)) {
          const part = p.open * c.tp1Frac;
          p.realR += part * ((tp1 - p.avg) * d) / p.risk;
          p.open -= part; p.tp1Hit = true; p.stop = p.avg;
          orders[side] = []; // no more adds once in profit
        }
        if (p.tp1Hit && (side === 'LONG' ? b.h >= tp2 : b.l <= tp2)) { closeTrade(side, tp2, b.t, 'tp2', c.feeMaker); continue; }
        if (b.t - p.t > c.maxHoldH * 3600e3) { closeTrade(side, b.c, b.t, 'time', c.feeTaker); continue; }
      }
    }
    if (b.t % (4 * 3600e3) === 0) curve.push({ t: b.t, eq: +equity.toFixed(3) });
  }
  return { config: c, trades, curve, stats: stats(trades, curve, equity) };
}

function stats(trades, curve, equity) {
  const rs = trades.map((t) => t.r);
  const w = rs.filter((r) => r > 0), l = rs.filter((r) => r <= 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  let peak = -Infinity, dd = 0;
  for (const p of curve) { peak = Math.max(peak, p.eq); dd = Math.max(dd, (peak - p.eq) / peak * 100); }
  return {
    trades: trades.length,
    winRate: trades.length ? +(w.length / trades.length * 100).toFixed(1) : 0,
    avgR: trades.length ? +(sum(rs) / trades.length).toFixed(3) : 0,
    totalR: +sum(rs).toFixed(2),
    profitFactor: l.length ? +(sum(w) / Math.max(1e-9, -sum(l))).toFixed(2) : null,
    returnPct: +(equity - 100).toFixed(2),
    maxDrawdownPct: +dd.toFixed(2),
  };
}

// Equity/stats restricted to a time window (for train/test and the channel window).
function slice(result, from, to) {
  const tr = result.trades.filter((t) => t.openedAt >= from && t.openedAt < to);
  let eq = 100;
  const curve = [{ t: from, eq }];
  for (const t of tr.sort((a, b) => a.closedAt - b.closedAt)) { eq *= 1 + (t.r * result.config.riskPct) / 100; curve.push({ t: t.closedAt, eq: +eq.toFixed(3) }); }
  return { trades: tr, curve, stats: stats(tr, curve, eq) };
}

module.exports = { DEFAULTS, loadData, precomputeLevels, simulate, slice, levelsAt, atrSeries, toHourly };
