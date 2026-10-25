// Copy-trades the channel: replays every parsed instruction on 1m candles.
// Sizing: each entry message commits 1 "unit" of notional (split by its
// ladder weights). Account equity is 100; one unit = `unitPct`% of equity in
// notional, so at 20x leverage unitPct=100 uses 5% margin per unit.
const { db } = require('./db');
const { parse } = require('./parser');
const { candles } = require('./market');

// The three strategies the dashboard compares, plus lab variants.
//   chento:  how the trader himself executes (front-runs ~$100, manages by feel)
//   discord: what a follower gets by executing the posts literally
//   desk:    the channel's levels with our mechanical exits
// mechanical: ignore the channel's take/BE/SL messages and manage each fill
// with fixed rules.
const VARIANTS = {
  chento:  { name: 'Chento', role: 'strategy', frontrun: 100, hardStopPct: null, skipHedges: false },
  discord: { name: 'Segnale Discord', role: 'strategy', frontrun: 0, hardStopPct: null, skipHedges: false },
  lab_stop:    { name: 'Chento + stop 1.2%', role: 'lab', frontrun: 100, hardStopPct: 1.2, skipHedges: false },
  lab_nohedge: { name: 'Chento + stop 1.2% senza hedge', role: 'lab', frontrun: 100, hardStopPct: 1.2, skipHedges: true },
};

const MECH_DEFAULTS = { mechanical: true, beAtPct: 0.4, tp1Pct: 0.8, tp1Frac: 0.5, tp2Pct: 1.6, maxHoldH: 72 };

// Picked from optimizeMechanical's top list using the whole history (the
// first-half winner used a 1.8% stop, which lost in the second half). n is
// small (8 filled campaigns): the live forward test is the real validation.
VARIANTS.desk = { name: 'Desk', role: 'strategy', ...MECH_DEFAULTS, frontrun: 150, hardStopPct: 2.5, beAtPct: 0.8, tp1Pct: 0.8, tp1Frac: 0.5, tp2Pct: 1.5, skipHedges: false };
// Trailing 0.7% after TP1 beat the fixed 1.5% TP2 in both halves of the
// history (+10.9% vs +10.0% total, DD 3.3% vs 3.1%): the paper bot uses it.
VARIANTS.lab_trail = { ...VARIANTS.desk, name: 'Desk + trailing 0.7%', role: 'lab', trailPct: 0.7 };

const BASE = {
  symbol: 'BTCUSDT',
  leverage: 20,
  maintMargin: 0.005,
  unitPct: 100,
  orderTTLh: 72,
  makerFee: 0.0002,
  takerFee: 0.0005,
};

async function loadEvents(fromTs) {
  const rows = db.prepare('SELECT id, ts, content FROM messages WHERE ts >= ? ORDER BY ts').all(fromTs || '');
  const out = [];
  for (const r of rows) {
    const t = Date.parse(r.ts);
    const k = await candles(BASE.symbol, '1m', t - 60e3, t + 60e3);
    const ref = k.length ? k[k.length > 1 ? 1 : 0].o : null;
    for (const e of parse(r.content, ref)) if (e.type !== 'info') out.push({ ...e, t, ref, msgId: r.id, text: r.content });
  }
  return out;
}

async function simulate(events, cfg = {}) {
  const c = { ...BASE, ...VARIANTS.discord, ...cfg };
  if (!events.length) return { config: c, campaigns: [], curve: [], stats: {} };
  const start = events[0].t - 60e3;
  const bars = await candles(c.symbol, '1m', start, Math.min(Date.now(), events[events.length - 1].t + 7 * 86400e3));

  let equity = 100;
  const curve = [{ t: start, eq: equity }];
  const campaigns = [];
  const st = { LONG: null, SHORT: null }; // active campaign per side
  let lastSide = null;
  const dirOf = (s) => (s === 'LONG' ? 1 : -1);

  const camp = (side, t, msgId) => {
    if (!st[side]) {
      st[side] = { id: campaigns.length + 1, msgId, side, openedAt: t, orders: [], qty: 0, avg: 0, maxQty: 0, stop: null,
        fills: [], exits: [], pnl: 0, fees: 0, mae: 0, hedge: false, status: 'pending' };
      campaigns.push(st[side]);
    }
    return st[side];
  };
  const unitNotional = () => equity * c.unitPct / 100;

  function fill(cp, px, units, t, fee) {
    const notional = units * unitNotional();
    cp.avg = (cp.avg * cp.qty + px * notional) / (cp.qty + notional);
    cp.qty += notional;
    cp.maxQty = Math.max(cp.maxQty, cp.qty);
    const f = notional * fee;
    cp.fees += f; equity -= f;
    cp.fills.push({ t, px, notional: +notional.toFixed(2) });
    cp.status = 'open';
    if (c.hardStopPct) cp.stop = cp.side === 'LONG' ? cp.avg * (1 - c.hardStopPct / 100) : cp.avg * (1 + c.hardStopPct / 100);
    if (cp.be) cp.stop = cp.avg;
  }
  function exit(cp, px, frac, t, reason) {
    if (cp.qty <= 0) return;
    const q = cp.qty * Math.min(frac, 1);
    const pnl = q * (px - cp.avg) / cp.avg * dirOf(cp.side);
    const f = q * c.takerFee;
    cp.pnl += pnl - f; cp.fees += f; equity += pnl - f;
    cp.qty -= q;
    cp.exits.push({ t, px, frac: +frac.toFixed(3), reason, pnl: +(pnl - f).toFixed(3) });
    if (cp.qty < cp.maxQty * 0.02) closeCamp(cp, t, px, reason);
  }
  function closeCamp(cp, t, px, reason) {
    if (cp.qty > 0) { // dust
      const pnl = cp.qty * (px - cp.avg) / cp.avg * dirOf(cp.side);
      cp.pnl += pnl; equity += pnl; cp.qty = 0;
    }
    cp.status = cp.fills.length ? 'closed' : 'expired';
    cp.closedAt = t; cp.closeReason = reason; cp.orders = [];
    st[cp.side] = null;
  }

  let ei = 0;
  for (const b of bars) {
    // 1) apply messages posted up to this bar's open
    while (ei < events.length && events[ei].t <= b.t) {
      const e = events[ei++];
      if (e.type === 'entry') {
        if (c.skipHedges && (e.hedge || (st[e.side === 'LONG' ? 'SHORT' : 'LONG']?.qty > 0))) continue;
        const cp = camp(e.side, e.t, e.msgId);
        if (e.hedge) cp.hedge = true;
        if (e.modify) cp.orders = [];
        for (const o of e.orders) {
          if (o.market) fill(cp, e.ref, o.weight, e.t, c.takerFee);
          else cp.orders.push({ price: o.price + c.frontrun * dirOf(e.side), units: o.weight, t: e.t, posted: o.price });
        }
        lastSide = e.side;
      } else if (c.mechanical) {
        continue;
      } else if (e.type === 'take') {
        let sides = e.sides.length ? e.sides : ['LONG', 'SHORT'].filter((s) => st[s]?.qty > 0);
        if (!e.sides.length && sides.length > 1 && lastSide) sides = [lastSide];
        for (const s of sides) if (st[s]?.qty > 0) exit(st[s], b.o, e.pct / 100, e.t, `take ${e.pct}%`);
      } else if (e.type === 'be') {
        const sides = e.sides.length ? e.sides : ['LONG', 'SHORT'].filter((s) => st[s]?.qty > 0);
        for (const s of sides) if (st[s]) { st[s].be = true; if (st[s].qty > 0) st[s].stop = st[s].avg; }
      } else if (e.type === 'sl') {
        const cp = st[e.side];
        if (cp) cp.stop = e.price;
      }
    }

    // 2) intrabar: stops/liquidation first (conservative), then limit fills
    for (const side of ['LONG', 'SHORT']) {
      const cp = st[side];
      if (!cp) continue;
      const d = dirOf(side);
      if (cp.qty > 0) {
        const adverse = side === 'LONG' ? b.l : b.h;
        cp.mae = Math.max(cp.mae, ((cp.avg - adverse) / cp.avg) * d * 100);
        const liqPx = cp.avg * (1 - d * (1 / c.leverage - c.maintMargin));
        if (side === 'LONG' ? b.l <= liqPx : b.h >= liqPx) { exit(cp, liqPx, 1, b.t, 'liquidation'); continue; }
        if (cp.stop && (side === 'LONG' ? b.l <= cp.stop : b.h >= cp.stop)) {
          const px = side === 'LONG' ? Math.min(cp.stop, b.o) : Math.max(cp.stop, b.o);
          exit(cp, px, 1, b.t, cp.tp1 && c.trailPct ? 'trailing' : Math.abs(cp.stop - cp.avg) < 1 ? 'breakeven' : 'stop');
          continue;
        }
      }
      if (c.mechanical && cp.qty > 0) {
        const fav = side === 'LONG' ? b.h : b.l;
        const movePct = ((fav - cp.avg) / cp.avg) * d * 100;
        if (!cp.be && movePct >= c.beAtPct) { cp.be = true; cp.stop = cp.avg; }
        if (!cp.tp1 && movePct >= c.tp1Pct) { cp.tp1 = true; exit(cp, cp.avg * (1 + d * c.tp1Pct / 100), c.tp1Frac, b.t, 'tp1'); cp.orders = []; }
        if (c.trailPct && cp.tp1) {
          // After TP1 the runner trails the best price instead of a fixed TP2.
          cp.peak = side === 'LONG' ? Math.max(cp.peak ?? fav, b.h) : Math.min(cp.peak ?? fav, b.l);
          const trail = cp.peak * (1 - d * c.trailPct / 100);
          if ((trail - cp.stop) * d > 0) cp.stop = trail;
        } else if (st[side] && cp.qty > 0 && movePct >= c.tp2Pct) { exit(cp, cp.avg * (1 + d * c.tp2Pct / 100), 1, b.t, 'tp2'); continue; }
        if (st[side] && cp.qty > 0 && cp.fills.length && b.t - cp.fills[0].t > c.maxHoldH * 3600e3) { exit(cp, b.c, 1, b.t, 'time'); continue; }
        if (!st[side]) continue;
      }
      cp.orders = cp.orders.filter((o) => {
        if (b.t - o.t > c.orderTTLh * 3600e3) return false;
        const touched = side === 'LONG' ? b.l <= o.price : b.h >= o.price;
        if (!touched) return true;
        fill(cp, side === 'LONG' ? Math.min(o.price, b.o) : Math.max(o.price, b.o), o.units, b.t, c.makerFee);
        return false;
      });
      if (!cp.orders.length && cp.qty <= 0 && b.t - cp.openedAt > c.orderTTLh * 3600e3) closeCamp(cp, b.t, b.c, 'expired');
    }

    if (b.t % 3600e3 === 0) {
      let mtm = equity;
      for (const s of ['LONG', 'SHORT']) if (st[s]?.qty > 0) mtm += st[s].qty * (b.c - st[s].avg) / st[s].avg * dirOf(s);
      curve.push({ t: b.t, eq: +mtm.toFixed(3) });
    }
  }
  const last = bars[bars.length - 1];
  for (const s of ['LONG', 'SHORT']) {
    const cp = st[s];
    if (cp && cp.qty > 0) { cp.unrealized = +(cp.qty * (last.c - cp.avg) / cp.avg * dirOf(s)).toFixed(3); cp.status = 'open'; }
  }
  return { config: c, campaigns, curve, stats: summarize(campaigns, curve, equity) };
}

function summarize(campaigns, curve, equity) {
  const done = campaigns.filter((x) => x.status === 'closed');
  const wins = done.filter((x) => x.pnl > 0);
  const losses = done.filter((x) => x.pnl <= 0);
  const sum = (a) => a.reduce((s, x) => s + x.pnl, 0);
  let peak = -Infinity, maxDd = 0;
  for (const p of curve) { peak = Math.max(peak, p.eq); maxDd = Math.max(maxDd, (peak - p.eq) / peak * 100); }
  const open = campaigns.filter((x) => x.status === 'open');
  const finalEq = equity + open.reduce((s, x) => s + (x.unrealized || 0), 0);
  return {
    campaigns: campaigns.length,
    filled: campaigns.filter((x) => x.fills.length).length,
    closed: done.length,
    open: open.length,
    unfilled: campaigns.filter((x) => x.status === 'expired').length,
    liquidations: done.filter((x) => x.closeReason === 'liquidation').length,
    winRate: done.length ? +(wins.length / done.length * 100).toFixed(1) : 0,
    profitFactor: losses.length ? +(sum(wins) / Math.max(1e-9, -sum(losses))).toFixed(2) : null,
    returnPct: +(finalEq - 100).toFixed(2),
    maxDrawdownPct: +maxDd.toFixed(2),
    avgMaePct: done.length ? +(done.reduce((s, x) => s + x.mae, 0) / done.length).toFixed(2) : 0,
  };
}

async function runAll() {
  const events = await loadEvents();
  const out = {};
  for (const [k, v] of Object.entries(VARIANTS)) out[k] = await simulate(events, v);
  return { events, variants: out };
}

// Grid search on the mechanical exits over the channel's own entries.
async function optimizeMechanical(events) {
  const grid = [];
  for (const frontrun of [0, 50, 100, 150])
    for (const hardStopPct of [0.8, 1.2, 1.8, 2.5])
      for (const beAtPct of [0.3, 0.5, 0.8])
        for (const tp1Pct of [0.5, 0.8, 1.2])
          for (const tp2Pct of [1.5, 2.5, 4])
            for (const skipHedges of [false, true]) grid.push({ ...MECH_DEFAULTS, frontrun, hardStopPct, beAtPct, tp1Pct, tp2Pct, skipHedges });
  const half = events[Math.floor(events.length / 2)].t;
  const first = events.filter((e) => e.t < half);
  const runs = [];
  for (const g of grid) {
    const a = await simulate(first, g);
    runs.push({ cfg: g, firstHalf: a.stats });
  }
  const sc = (s) => s.returnPct / Math.max(1, s.maxDrawdownPct);
  runs.sort((x, y) => sc(y.firstHalf) - sc(x.firstHalf));
  const top = [];
  for (const r of runs.slice(0, 10)) top.push({ ...r, full: (await simulate(events, r.cfg)).stats, secondHalf: (await simulate(events.filter((e) => e.t >= half), r.cfg)).stats });
  return { half, tried: grid.length, top };
}

module.exports = { loadEvents, simulate, runAll, optimizeMechanical, VARIANTS, MECH_DEFAULTS, BASE };
