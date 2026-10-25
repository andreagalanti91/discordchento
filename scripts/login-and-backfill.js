// One-off: opens Chrome, waits for your Discord login, downloads the full channel history.
const { start } = require('../src/collector');
const { db } = require('../src/db');

(async () => {
  const { ctx } = await start({ headless: false, doBackfill: true });
  const n = db.prepare('SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last FROM messages').get();
  console.log(`\nStored ${n.n} messages (${n.first} → ${n.last}).`);
  await ctx.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
