// Recomputes every backtest and writes data/research.json for the dashboard.
const fs = require('fs');
const path = require('path');
const { DATA_DIR, kvGet, kvSet } = require('./db');
const R = require('./replica');
const { optimize } = require('./optimize');
const { candles } = require('./market');
const { PaperBot } = require('./bot');

const OUT = path.join(DATA_DIR, 'research.json');

const lite = (c) => ({
  id: c.id, msgId: c.msgId, side: c.side, openedAt: c.openedAt, closedAt: c.closedAt || null, status: c.status,
  closeReason: c.closeReason || null, avg: +c.avg.toFixed(1), fills: c.fills, exits: c.exits,
  pnl: +c.pnl.toFixed(3), unrealized: c.unrealized ?? null, mae: +c.mae.toFixed(2), hedge: c.hedge,
});

async function windowRun(events, from) {
  const ev = events.filter((e) => e.t >= from);
  const variants = {};
  for (const [k, v] of Object.entries(R.VARIANTS)) {
    const r = await R.simulate(ev, v);
    variants[k] = { name: v.name, role: v.role, config: v, stats: r.stats, curve: r.curve, campaigns: r.campaigns.map(lite) };
  }
  const bh = await candles('BTCUSDT', '1h', from, Date.now());
  const buyHold = bh.length ? bh.map((k) => ({ t: k.t, eq: +(100 * k.c / bh[0].o).toFixed(3) })) : [];
  return { from, entries: ev.filter((e) => e.type === 'entry').length, variants, buyHold };
}

// The forward test starts the first time this version runs and never moves,
// so every strategy is judged on messages none of them was tuned on.
function forwardStart() {
  let t = Number(kvGet('forward_start'));
  if (!t) { t = Date.now(); kvSet('forward_start', t); }
  return t;
}

async function replicaOnly() {
  const events = await R.loadEvents();
  const history = await windowRun(events, events[0]?.t ?? Date.now());
  const fwd = forwardStart();
  const forward = await windowRun(events, fwd);
  const messages = Object.fromEntries(events.filter((e) => e.type === 'entry').map((e) => [e.msgId, { t: e.t, text: (e.text || '').replace(/<@&?\d+>/g, '').trim().slice(0, 140) }]));
  return { events: events.map(({ text, ...e }) => e), history, forward, messages, ...history };
}

// The paper bot replayed over the whole history (same code as the live bot).
async function botReplay(events, cfg) {
  if (!events.length) return null;
  const start = events[0].t - 60e3;
  const bars = await candles('BTCUSDT', '1m', start, Date.now());
  const bot = new PaperBot(cfg, null, start);
  let i = 0;
  for (const b of bars) {
    while (i < events.length && events[i].t <= b.t) { const e = events[i++]; bot.onEvent(e, e.ref); }
    bot.onBar(b);
  }
  bot.drain();
  return { from: start, summary: bot.summary(bars[bars.length - 1].c), trades: bot.s.trades, curve: bot.s.curve };
}

async function run({ full = true } = {}) {
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const out = { ...prev, updatedAt: new Date().toISOString() };
  out.replica = await replicaOnly();
  const { botConfig } = require('./bot-runner');
  out.botReplay = await botReplay(await R.loadEvents(), botConfig());
  if (full) {
    const events = await R.loadEvents();
    const mech = await R.optimizeMechanical(events);
    out.mechanical = { half: mech.half, tried: mech.tried, top: mech.top.slice(0, 8) };
    const opt = await optimize({});
    out.levels = {
      windows: opt.windows,
      samples: opt.samples,
      best: { config: opt.best.config, train: opt.best.train, validation: opt.best.validation, test: opt.best.test, full: opt.best.full, curve: opt.best.curve, trades: opt.best.trades.slice(-200) },
      baseline: { config: opt.baseline.config, train: opt.baseline.train, validation: opt.baseline.validation, test: opt.baseline.test, full: opt.baseline.full, curve: opt.baseline.curve },
      top: opt.top,
    };
    out.researchAt = new Date().toISOString();
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  return out;
}

const read = () => (fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null);

if (require.main === module) {
  run({ full: !process.argv.includes('--quick') }).then((o) => {
    for (const [k, v] of Object.entries(o.replica.history.variants)) console.log(k.padEnd(12), JSON.stringify(v.stats));
    console.log('forward from', new Date(o.replica.forward.from).toISOString(), 'entries', o.replica.forward.entries);
    if (o.levels) console.log('levels test', JSON.stringify(o.levels.best.test));
  });
}

module.exports = { run, read };
