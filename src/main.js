// 24/7 entry point: collector → analyzer → dashboard (SSE), plus periodic research.
const { execFile } = require('child_process');
const config = require('./config');
const server = require('./server');
const { analyze, analyzePending, marketContext } = require('./analyzer');
const research = require('./research');
const { lastPrice } = require('./market');
const { db } = require('./db');
const { BotRunner } = require('./bot-runner');
const telegram = require('./telegram');

const log = (...a) => console.log(new Date().toISOString(), '[main]', ...a);
const noCollector = process.argv.includes('--no-collector');

function notify(title, body) {
  if (process.platform !== 'darwin' || process.env.NOTIFY === '0') return;
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&').slice(0, 220);
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

let researchRunning = false;
async function runResearch(full) {
  if (researchRunning) return;
  researchRunning = true;
  try {
    const out = await research.run({ full });
    srv.broadcast('research', out);
    log(`research updated (${full ? 'full' : 'quick'})`);
  } catch (e) { log('research failed', e.message); }
  researchRunning = false;
}

let quickTimer = null;
const scheduleQuick = () => { clearTimeout(quickTimer); quickTimer = setTimeout(() => runResearch(false), 20000); };

const srv = server.start({ onResearch: () => runResearch(true) });

const bot = config.botEnabled ? new BotRunner({ onUpdate: (snap) => srv.broadcast('bot', snap) }) : null;
server.setBot(bot);

// Entry signals from the last day, so a freshly started bot still
// rests orders on levels the channel posted just before.
function recentEntries(hours) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  return db.prepare('SELECT message_id, verdict FROM analyses WHERE ts >= ? ORDER BY ts').all(since)
    .map((r) => ({ msgId: r.message_id, ...JSON.parse(r.verdict) }))
    .filter((v) => v.rule?.kind === 'entry');
}

async function onMessage(id, { edited = false } = {}) {
  const a = await analyze(id).catch((e) => log('analyze failed', e.message));
  if (!a) return;
  srv.broadcast('message', { id: a.message.id, ts: a.message.ts, summary: a.summary, verdict: a.verdict });
  // Edits are re-analysed for the feed but never re-traded (no double orders).
  if (bot && !edited) bot.onSignal(a.verdict.events, a.verdict.ref, Date.now(), a.message.id);
  const kind = a.verdict.rule.kind;
  if (kind !== 'info') {
    const plan = a.verdict.rule.plans[0];
    notify(kind === 'entry' ? `Nuova entry ${plan?.side || ''}` : 'Gestione posizione', a.message.content?.slice(0, 120) || a.summary);
    scheduleQuick();
  }
}

async function tick() {
  try {
    srv.live.price = await lastPrice('BTCUSDT');
    srv.broadcast('price', { price: srv.live.price, t: Date.now() });
  } catch {}
}
async function refreshContext() {
  try { srv.live.ctx = await marketContext(Date.now()); srv.broadcast('ctx', srv.live.ctx); } catch (e) { log('ctx', e.message); }
}

(async () => {
  await tick();
  await refreshContext();
  setInterval(tick, 10000);
  setInterval(refreshContext, 5 * 60e3);
  const n = await analyzePending();
  if (n) log(`analyzed ${n} pending messages`);
  if (!research.read()) runResearch(true);
  setInterval(() => runResearch(true), 24 * 3600e3);

  if (bot) {
    await bot.seed(recentEntries(24));
    await bot.tick();
    setInterval(() => bot.tick(), 20000);
    log(`paper bot running · equity ${bot.bot.summary(srv.live.price || 0).equity} $`);
    if (telegram.enabled()) {
      const lastSignal = () => db.prepare(`SELECT m.ts, m.content, a.summary FROM messages m JOIN analyses a ON a.message_id = m.id
        WHERE json_extract(a.verdict, '$.rule.kind') != 'info' ORDER BY m.ts DESC LIMIT 1`).get();
      telegram.start({ bot, price: () => srv.live.price, lastSignal });
    }
  }

  if (!noCollector) {
    const collector = require('./collector');
    collector.events.on('message', onMessage);
    collector.events.on('edit', (id) => onMessage(id, { edited: true }));
    await collector.start({ headless: config.headless });
    log('collector running');
  }
})().catch((e) => { log('fatal', e.stack || e.message); process.exit(1); });

process.on('unhandledRejection', (e) => log('unhandled', e?.message || e));
