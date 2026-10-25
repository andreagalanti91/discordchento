// Reads a Discord channel through a local Chrome profile you log into once.
// Read-only: it captures the messages the Discord web client itself loads
// (REST responses for history, DOM observer for live messages). No token is
// extracted or stored.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { saveMessage, kvSet, DATA_DIR } = require('./db');
const config = require('./config');

const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
const IMG_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });

const events = new EventEmitter();
const log = (...a) => console.log(new Date().toISOString(), '[collector]', ...a);

function fromApi(m) {
  return {
    id: m.id,
    channel_id: m.channel_id,
    author: m.author?.global_name || m.author?.username,
    author_id: m.author?.id,
    content: m.content,
    ts: m.timestamp,
    edited_ts: m.edited_timestamp,
    attachments: (m.attachments || []).map((a) => ({ url: a.url, filename: a.filename, type: a.content_type })),
    embeds: (m.embeds || []).map((e) => ({
      title: e.title, description: e.description, url: e.url,
      fields: e.fields, image: e.image?.url || e.thumbnail?.url,
    })),
    reply_to: m.message_reference?.message_id,
    source: 'api',
  };
}

async function downloadImages(ctx, msg) {
  const out = [];
  for (const [i, a] of (msg.attachments || []).entries()) {
    const isImg = /image\//.test(a.type || '') || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(a.url);
    if (!isImg) { out.push(a); continue; }
    const ext = (a.url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i) || [, 'png'])[1];
    const local = path.join(IMG_DIR, `${msg.id}_${i}.${ext}`);
    if (!fs.existsSync(local)) {
      try {
        const r = await ctx.request.get(a.url);
        if (r.ok()) fs.writeFileSync(local, await r.body());
      } catch (e) { log('image download failed', msg.id, e.message); }
    }
    out.push({ ...a, local: fs.existsSync(local) ? path.relative(DATA_DIR, local) : null });
  }
  msg.attachments = out;
}

async function ingest(ctx, msg) {
  if (msg.channel_id !== config.channelId) return;
  await downloadImages(ctx, msg);
  const change = saveMessage(msg);
  if (change === 'new') events.emit('message', msg.id);
  else if (change === 'edited') events.emit('edit', msg.id);
}

// Runs inside the page: watches the chat list and reports rendered messages.
function domObserver(channelId) {
  const seen = new Set();
  let lastAuthor = null;
  const read = (li) => {
    const m = li.id.match(/^chat-messages-(\d+)-(\d+)$/);
    if (!m || m[1] !== channelId) return;
    const id = m[2];
    const author = li.querySelector('[id^="message-username-"]')?.innerText?.trim();
    if (author) lastAuthor = author;
    const content = li.querySelector(`[id="message-content-${id}"]`)?.innerText || '';
    const ts = li.querySelector('time[datetime]')?.getAttribute('datetime');
    const imgs = [...li.querySelectorAll('a[href*="/attachments/"], img[src*="/attachments/"]')]
      .map((el) => el.href || el.src).filter(Boolean);
    const key = id + '|' + content.length + '|' + imgs.length;
    if (seen.has(key) || !ts) return;
    seen.add(key);
    window.__deskMsg({
      id, channel_id: channelId, author: author || lastAuthor, content, ts,
      attachments: [...new Set(imgs.map((u) => u.split('?')[0]))].map((u, i) => ({ url: imgs.find((x) => x.startsWith(u)) || u, filename: `img${i}` })),
      source: 'dom',
    });
  };
  const scan = () => document.querySelectorAll('li[id^="chat-messages-"]').forEach(read);
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
  scan();
}

async function scrollToTop(page) {
  return page.evaluate(() => {
    const list = document.querySelector('ol[data-list-id="chat-messages"]');
    let el = list;
    while (el && el.scrollHeight <= el.clientHeight + 5) el = el.parentElement;
    if (!el) return null;
    el.scrollTop = 0;
    return el.scrollHeight;
  });
}

async function backfill(page, maxRounds = 4000) {
  log('backfill: loading channel history…');
  let idle = 0;
  let count = 0;
  const onNew = () => { count++; };
  events.on('message', onNew);
  for (let i = 0; i < maxRounds && idle < 8; i++) {
    const before = count;
    await scrollToTop(page);
    await page.waitForTimeout(1200);
    idle = count === before ? idle + 1 : 0;
    if (i % 10 === 0) log(`backfill: ${count} new messages so far`);
  }
  events.off('message', onNew);
  log(`backfill done: ${count} new messages`);
  kvSet('backfill_done_at', new Date().toISOString());
}

async function start({ headless = config.headless, doBackfill = false } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  page.on('response', async (res) => {
    const u = res.url();
    if (res.request().method() !== 'GET' || !/\/api\/v\d+\/channels\/\d+\/messages(\?|$)/.test(u)) return;
    try {
      const arr = await res.json();
      if (Array.isArray(arr)) for (const m of arr) await ingest(ctx, fromApi(m));
    } catch {}
  });
  await page.exposeFunction('__deskMsg', (m) => ingest(ctx, m).catch((e) => log('dom ingest', e.message)));

  const url = `https://discord.com/channels/${config.guildId}/${config.channelId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // First run: wait (up to 10 min) for the user to log in inside the window.
  const chatOpen = () => page.$('ol[data-list-id="chat-messages"]').catch(() => null);
  for (let i = 0; !(await chatOpen()); i++) {
    if (i === 5) log('Waiting for Discord login in the Chrome window (QR code works)…');
    if (i > 900) throw new Error('login timeout');
    if (i % 30 === 29 && /\/channels\/@me|\/app$/.test(page.url())) await page.goto(url);
    await page.waitForTimeout(1000);
  }
  log('channel open');
  kvSet('collector_status', 'online');

  await page.evaluate(domObserver, config.channelId);
  if (doBackfill) await backfill(page);

  // Heartbeat + periodic reload so REST data reconciles anything the DOM missed
  // (edits, full attachment URLs) and the session never goes stale.
  setInterval(() => kvSet('collector_heartbeat', new Date().toISOString()), 15000);
  setInterval(async () => {
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('ol[data-list-id="chat-messages"]', { timeout: 60000 });
      await page.evaluate(domObserver, config.channelId);
    } catch (e) { log('reload failed', e.message); kvSet('collector_status', 'degraded'); }
  }, config.reloadMinutes * 60000);
  kvSet('collector_heartbeat', new Date().toISOString());

  // An unexpected browser exit kills the process so launchd restarts it cleanly.
  ctx.on('close', () => { kvSet('collector_status', 'offline'); log('browser closed'); if (!ctx.__closing) process.exit(1); });
  const close = ctx.close.bind(ctx);
  ctx.close = () => { ctx.__closing = true; return close(); };
  return { ctx, page };
}

module.exports = { start, events };
