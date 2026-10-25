// Pushes dashboard snapshots from the Mac to the Cloudflare copy.
// Off unless CLOUD_URL and CLOUD_INGEST_SECRET are set in .env. Screenshots
// are never uploaded: the online feed shows text and analysis only.
const config = require('./config');
const research = require('./research');
const { candles } = require('./market');

const log = (...a) => console.log(new Date().toISOString(), '[cloud]', ...a);

async function push(kind, data) {
  const r = await fetch(`${config.cloudUrl.replace(/\/$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.cloudSecret}` },
    body: JSON.stringify({ kind, data }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`${kind}: HTTP ${r.status}`);
}

function start({ server, bot }) {
  if (!config.cloudUrl || !config.cloudSecret) return null;
  let lastResearch = null;
  let lastCandles = 0;
  let failing = false;

  async function sync() {
    try {
      const feed = server.feed(80).map((m) => ({ ...m, images: [] }));
      await push('state', { status: server.status(), live: server.live, feed, declared: server.declared() });
      if (bot) await push('bot', bot.snapshot(server.live.price));
      const r = research.read();
      const stamp = r && `${r.updatedAt}|${r.researchAt}`;
      if (r && stamp !== lastResearch) { await push('research', r); lastResearch = stamp; }
      if (Date.now() - lastCandles > 10 * 60e3) {
        await push('candles', await candles('BTCUSDT', '1h', Date.now() - 12 * 86400e3, Date.now()));
        lastCandles = Date.now();
      }
      if (failing) log('sync restored');
      failing = false;
    } catch (e) {
      if (!failing) log('sync failed:', e.message);
      failing = true;
    }
  }

  log(`syncing to ${config.cloudUrl} every ${config.cloudEverySec}s`);
  sync();
  return setInterval(sync, config.cloudEverySec * 1000);
}

module.exports = { start, push };
