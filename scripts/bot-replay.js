// Replays the whole channel history through the paper bot (same code as live)
// and prints trades, notifications and the final account.
// Usage: node scripts/bot-replay.js [--log]
const R = require('../src/replica');
const { candles } = require('../src/market');
const { PaperBot } = require('../src/bot');
const { botConfig } = require('../src/bot-runner');

(async () => {
  const events = await R.loadEvents();
  const start = events[0].t - 60e3;
  const bars = await candles('BTCUSDT', '1m', start, Date.now());
  const bot = new PaperBot(botConfig(), null, start);
  let ei = 0;
  for (const b of bars) {
    while (ei < events.length && events[ei].t <= b.t) { const e = events[ei++]; bot.onEvent(e, e.ref); }
    bot.onBar(b);
  }
  const notes = bot.drain();
  if (process.argv.includes('--log')) for (const n of notes) console.log(new Date(n.t).toISOString().slice(5, 16), n.kind.padEnd(7), n.title, '|', n.body.replace(/\n/g, ' · '));
  console.log('\nTrades:');
  for (const t of bot.s.trades) console.log(` #${t.id} ${t.side.padEnd(5)} ${new Date(t.openedAt).toISOString().slice(5, 16)} avg ${t.avg} → ${t.exit} (${t.reason}) ${t.pnl >= 0 ? '+' : ''}${t.pnl} $`);
  for (const c of Object.values(bot.s.campaigns)) if (c) console.log(` open ${c.side} qty ${c.qty.toFixed(4)} avg ${c.avg.toFixed(1)} orders ${c.orders.length}`);
  console.log('\nSummary:', JSON.stringify(bot.summary(bars[bars.length - 1].c)));
  console.log('Notifications:', notes.length);
})();
