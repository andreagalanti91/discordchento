// Local HTTP server: dashboard, JSON API and a Server-Sent Events stream.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, kvGet, DATA_DIR } = require('./db');
const research = require('./research');
const config = require('./config');
const { candles } = require('./market');

const DASH = path.join(__dirname, '..', 'dashboard');
const clients = new Set();
let bot = null;
const setBot = (b) => { bot = b; };
const live = { price: null, ctx: null };

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function feed(limit = 200) {
  return db.prepare(`
    SELECT m.id, m.ts, m.author, m.content, m.attachments, a.summary, a.verdict
    FROM messages m LEFT JOIN analyses a ON a.message_id = m.id
    ORDER BY m.ts DESC LIMIT ?`).all(limit).map((r) => ({
    id: r.id, ts: r.ts, author: (r.author || '').split('\n')[0], content: r.content,
    images: JSON.parse(r.attachments || '[]').filter((a) => a.local).map((a) => '/' + a.local),
    summary: r.summary, verdict: r.verdict ? JSON.parse(r.verdict) : null,
  }));
}

function status() {
  const c = db.prepare('SELECT COUNT(*) n, MAX(ts) last FROM messages').get();
  const hb = kvGet('collector_heartbeat');
  const online = hb && Date.now() - Date.parse(hb) < 60e3;
  return {
    collector: online ? 'online' : kvGet('collector_status') === 'degraded' ? 'degraded' : 'offline',
    heartbeat: hb, messages: c.n, lastMessageAt: c.last,
    ai: !!config.anthropicKey, model: config.anthropicKey ? config.model : null,
    channel: `https://discord.com/channels/${config.guildId}/${config.channelId}`,
  };
}

function declared() {
  const f = path.join(DATA_DIR, 'declared.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': file.includes('/images/') ? 'max-age=31536000' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function start({ onResearch } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/') return serveFile(res, path.join(DASH, 'index.html'));
      if (p === '/api/state') return json(res, { status: status(), live, feed: feed(), research: research.read(), declared: declared() });
      if (p === '/api/feed') return json(res, feed(Number(url.searchParams.get('limit') || 200)));
      if (p === '/api/candles') {
        const interval = ['15m', '1h', '4h'].includes(url.searchParams.get('interval')) ? url.searchParams.get('interval') : '1h';
        const from = Number(url.searchParams.get('from')) || Date.now() - 10 * 86400e3;
        return json(res, await candles('BTCUSDT', interval, from, Date.now()));
      }
      if (p === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/bot') return bot ? json(res, bot.snapshot(live.price)) : json(res, { disabled: true });
      if (bot && req.method === 'POST' && ['/api/bot/pause', '/api/bot/resume', '/api/bot/test-notify'].includes(p)) {
        if (p.endsWith('pause')) await bot.pause();
        if (p.endsWith('resume')) await bot.resume();
        if (p.endsWith('test-notify')) return json(res, { sent: await bot.testNotify() });
        return json(res, bot.snapshot(live.price));
      }
      if (p === '/api/research' && req.method === 'POST') {
        json(res, { started: true });
        onResearch?.();
        return;
      }
      if (p.startsWith('/images/')) return serveFile(res, path.join(DATA_DIR, 'images', path.basename(p)));
      if (p.startsWith('/assets/')) return serveFile(res, path.join(DASH, path.basename(p)));
      if (/^\/(manifest\.webmanifest|apple-touch-icon\.png|icon-[\w-]+\.png)$/.test(p)) return serveFile(res, path.join(DASH, p.slice(1)));
      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end(e.message);
    }
  });
  server.listen(config.port, '127.0.0.1', () => console.log(`[server] dashboard on http://localhost:${config.port}`));
  setInterval(() => broadcast('status', status()), 15000);
  return { broadcast, live };
}

module.exports = { start, broadcast, live, feed, status, setBot, declared };
