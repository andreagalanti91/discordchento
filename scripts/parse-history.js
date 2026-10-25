// Parses every stored message and prints the extracted events (for review).
const { db } = require('../src/db');
const { parse } = require('../src/parser');
const { candles } = require('../src/market');
(async () => {
  const rows = db.prepare('SELECT id, ts, content FROM messages ORDER BY ts').all();
  for (const r of rows) {
    const t = Date.parse(r.ts);
    const k = await candles('BTCUSDT', '1m', t - 60e3, t + 60e3);
    const ref = k.length ? k[0].c : null;
    const ev = parse(r.content, ref).filter((e) => e.type !== 'info');
    if (ev.length || process.argv[2] === 'all') console.log(r.ts.slice(5, 16), ref, '|', (r.content || '').replace(/\n/g, ' ⏎ ').slice(0, 90), '\n   →', JSON.stringify(ev));
  }
})();
