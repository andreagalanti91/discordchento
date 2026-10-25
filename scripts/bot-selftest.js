// Scenario tests for the paper bot on synthetic candles. Run: node scripts/bot-selftest.js
const assert = require('assert');
const { PaperBot } = require('../src/bot');

const T0 = Date.UTC(2026, 9, 1, 10, 0);
const M = 60e3;
const bar = (i, o, h, l, c) => ({ t: T0 + i * M, o, h, l, c });
const entry = (side, prices, t = T0, extra = {}) => ({ type: 'entry', side, t, msgId: 'm' + t, orders: prices.map((p) => ({ price: p, weight: 1 / prices.length })), ...extra });
const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok  ', name]); } catch (e) { results.push(['FAIL', name + ' → ' + e.message]); } };

test('long: fill, breakeven, TP1, trailing exit in profit', () => {
  const b = new PaperBot({}, null, T0);
  b.onEvent(entry('LONG', [80000]), 81000);
  b.onBar(bar(1, 80500, 80500, 80100, 80200));          // limit 80150 fills
  assert.ok(b.s.campaigns.LONG.qty > 0, 'filled');
  b.onBar(bar(2, 80200, 80900, 80200, 80850));          // +0.8% → BE + TP1
  const c = b.s.campaigns.LONG;
  assert.ok(c.be && c.tp1, 'BE and TP1');
  b.onBar(bar(3, 80850, 81500, 80850, 81400));          // runs, trail follows
  b.onBar(bar(4, 81400, 81400, 80700, 80800));          // pulls back through trail
  assert.strictEqual(b.s.campaigns.LONG, null, 'closed');
  assert.ok(b.s.trades[0].pnl > 0 && /trailing/.test(b.s.trades[0].reason), 'trailing win');
});

test('risk: a full stop loses about riskPct of equity', () => {
  const b = new PaperBot({}, null, T0);
  b.onEvent(entry('LONG', [80000]), 81000);
  b.onBar(bar(1, 80300, 80300, 80100, 80150));
  b.onBar(bar(2, 80150, 80150, 77000, 77500));          // through the 2.5% stop
  const loss = 10000 - b.s.equity;
  assert.ok(loss > 95 && loss < 115, `loss ${loss.toFixed(2)}`);
});

test('fill candle that also crosses the stop counts as stopped', () => {
  const b = new PaperBot({}, null, T0);
  b.onEvent(entry('LONG', [80000]), 81000);
  b.onBar(bar(1, 80500, 80500, 77000, 77200));
  assert.strictEqual(b.s.campaigns.LONG, null);
  assert.strictEqual(b.s.trades[0].reason, 'stop loss');
});

test('channel "close all" closes at market; partial takes are ignored', () => {
  const b = new PaperBot({}, null, T0);
  b.onEvent(entry('SHORT', [85000]), 84000);
  b.onBar(bar(1, 84500, 84900, 84500, 84800));          // limit 84850 fills
  const q = b.s.campaigns.SHORT.qty;
  b.onEvent({ type: 'take', pct: 25, sides: [], t: T0 + 2 * M }, 84700);
  assert.strictEqual(b.s.campaigns.SHORT.qty, q, 'partial ignored');
  b.onEvent({ type: 'take', pct: 100, sides: [], t: T0 + 3 * M }, 84600);
  assert.strictEqual(b.s.campaigns.SHORT, null, 'closed');
});

test('channel "sl be" only applies when in profit', () => {
  const b = new PaperBot({}, null, T0);
  b.onEvent(entry('LONG', [80000]), 81000);
  b.onBar(bar(1, 80300, 80300, 80100, 80150));
  b.onEvent({ type: 'be', sides: [], t: T0 + 2 * M }, 80000); // under water
  assert.ok(b.s.campaigns.LONG.stop < 80000, 'not moved when losing');
  b.onEvent({ type: 'be', sides: [], t: T0 + 3 * M }, 80400);
  assert.ok(Math.abs(b.s.campaigns.LONG.stop - b.s.campaigns.LONG.avg) < 1e-6, 'moved to BE');
});

test('DCA is capped by maxEntries and campaign risk', () => {
  const b = new PaperBot({ maxEntries: 3 }, null, T0);
  b.onEvent(entry('LONG', [80000, 79500]), 81000);
  b.onEvent(entry('LONG', [79000, 78500], T0 + M), 81000);
  const c = b.s.campaigns.LONG;
  assert.strictEqual(c.orders.length, 3, 'max 3 orders');
  assert.ok(c.riskBudget <= 2, 'risk budget capped');
  b.onEvent(entry('LONG', [78000], T0 + 2 * M), 81000);
  assert.strictEqual(c.orders.length, 3, 'no more entries');
});

test('daily loss brake blocks new entries until the next UTC day', () => {
  const b = new PaperBot({ riskPct: 2, dailyLossPct: 3 }, null, T0);
  for (let k = 0; k < 2; k++) {
    const t0 = T0 + k * 10 * M;
    b.onEvent(entry('LONG', [80000], t0), 81000);
    b.onBar({ t: t0 + M, o: 80300, h: 80300, l: 80100, c: 80150 });
    b.onBar({ t: t0 + 2 * M, o: 80150, h: 80150, l: 77000, c: 77500 });
  }
  assert.ok(b.s.blockedDay, 'blocked');
  b.onEvent(entry('LONG', [76000], T0 + 30 * M), 77000);
  assert.strictEqual(b.s.campaigns.LONG, null, 'entry refused');
  b.onBar({ t: T0 + 86400e3, o: 77000, h: 77000, l: 77000, c: 77000 });
  b.onEvent(entry('LONG', [76000], T0 + 86400e3 + M), 77000);
  assert.ok(b.s.campaigns.LONG, 'allowed next day');
});

test('max drawdown pauses the bot until resumed', () => {
  const b = new PaperBot({ riskPct: 2, maxCampaignRiskPct: 2, maxDrawdownPct: 3, dailyLossPct: 50 }, null, T0);
  for (let k = 0; k < 2; k++) {
    const t0 = T0 + k * 10 * M;
    b.onEvent(entry('SHORT', [85000], t0), 84000);
    b.onBar({ t: t0 + M, o: 84700, h: 84900, l: 84700, c: 84850 });
    b.onBar({ t: t0 + 2 * M, o: 84850, h: 88000, l: 84850, c: 87500 });
  }
  assert.ok(b.s.paused, 'paused');
  b.resume(T0 + 60 * M);
  assert.ok(!b.s.paused, 'resumed');
});

test('orders expire after orderTTLh without a fill', () => {
  const b = new PaperBot({ orderTTLh: 1 }, null, T0);
  b.onEvent(entry('LONG', [70000]), 81000);
  b.onBar({ t: T0 + 2 * 3600e3, o: 81000, h: 81000, l: 80900, c: 81000 });
  assert.strictEqual(b.s.campaigns.LONG, null);
});

for (const [s, n] of results) console.log(s, n);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
