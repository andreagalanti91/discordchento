// Signal Desk online: a read-only copy of the dashboard on Cloudflare.
// The Mac pushes snapshots to /ingest (bearer secret); the dashboard reads
// them from D1 behind a password login. Nothing here talks to Discord,
// trades, or sends Telegram alerts: all of that stays on the Mac.

const KINDS = ['state', 'bot', 'research', 'candles'];
const SESSION_DAYS = 30;
const OFFLINE_AFTER_S = 180;

const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const sessionKey = (env) => `${env.SESSION_SECRET || ''}|${env.DASH_PASSWORD}`;

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  return `${exp}.${await hmac(sessionKey(env), String(exp))}`;
}

async function validSession(req, env) {
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)desk_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(sessionKey(env), exp));
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function read(env, kind) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM snapshots WHERE kind = ?').bind(kind).first();
  return row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
}

function loginPage(error = '') {
  return new Response(`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>Signal Desk</title>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
<style>
:root{--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--hair:rgba(0,0,0,.1);--accent:#0071e3;--red:#e0352b}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--muted:#a1a1a6;--hair:rgba(255,255,255,.12);--accent:#2997ff;--red:#ff453a}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:24px}
form{width:100%;max-width:340px;background:var(--card);border-radius:22px;padding:32px 24px 24px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.08);text-align:center}
i{display:block;width:56px;height:56px;margin:0 auto 16px;border-radius:14px;background:linear-gradient(140deg,#0a84ff,#5e5ce6);box-shadow:inset 0 1px 0 rgba(255,255,255,.35)}
h1{font:700 24px/1.1 -apple-system,system-ui;letter-spacing:-.02em;margin:0 0 4px}p{color:var(--muted);margin:0 0 22px;font-size:14px}
input{width:100%;font:inherit;font-size:17px;padding:13px 14px;border-radius:12px;border:1px solid var(--hair);background:transparent;color:var(--text);outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(0,113,227,.18)}
button{width:100%;margin-top:12px;font:600 17px/1 -apple-system,system-ui;padding:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer;transition:transform .1s ease-out;-webkit-tap-highlight-color:transparent}
button:active{transform:scale(.97)}.err{color:var(--red);font-size:14px;margin:12px 0 0}
</style></head><body><form method="post" action="/login"><i></i><h1>Signal Desk</h1><p>Inserisci la password per entrare</p>
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password">
<button type="submit">Entra</button>${error ? `<div class="err">${error}</div>` : ''}</form></body></html>`, { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // --- Mac → cloud -----------------------------------------------------------
    if (p === '/ingest' && req.method === 'POST') {
      const auth = req.headers.get('Authorization') || '';
      if (!env.INGEST_SECRET || !safeEqual(auth, `Bearer ${env.INGEST_SECRET}`)) return json({ error: 'unauthorized' }, 401);
      const body = await req.json().catch(() => null);
      if (!body || !KINDS.includes(body.kind)) return json({ error: 'bad request' }, 400);
      await env.DB.prepare('INSERT INTO snapshots (kind, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .bind(body.kind, JSON.stringify(body.data), Date.now()).run();
      return json({ ok: true });
    }

    // --- login -------------------------------------------------------------------
    const publicAsset = /^\/(manifest\.webmanifest|apple-touch-icon\.png|icon-[\w-]+\.png)$/.test(p);
    if (p === '/login' && req.method === 'POST') {
      const form = await req.formData().catch(() => null);
      const pw = form?.get('password') || '';
      if (!env.DASH_PASSWORD || !safeEqual(String(pw), env.DASH_PASSWORD)) {
        await new Promise((r) => setTimeout(r, 800)); // slow down guessing
        return loginPage('Password non corretta');
      }
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `desk_session=${await makeSession(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` } });
    }
    if (p === '/logout') return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': 'desk_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' } });
    if (!publicAsset && !(await validSession(req, env))) {
      if (p.startsWith('/api/')) return json({ error: 'login required' }, 401);
      return loginPage();
    }

    // --- read-only API (same shapes as the Mac server) -----------------------------
    if (p === '/api/state') {
      const [state, research] = await Promise.all([read(env, 'state'), read(env, 'research')]);
      if (!state) return json({ status: { collector: 'offline', messages: 0 }, live: {}, feed: [], research: research?.data || null, declared: null, cloud: { updatedAt: null } });
      const age = (Date.now() - state.updatedAt) / 1000;
      const s = state.data;
      return json({ ...s, status: { ...s.status, collector: age > OFFLINE_AFTER_S ? 'offline' : s.status.collector }, research: research?.data || null, cloud: { updatedAt: state.updatedAt, macOnline: age <= OFFLINE_AFTER_S } });
    }
    if (p === '/api/feed') return json((await read(env, 'state'))?.data.feed || []);
    if (p === '/api/bot') { const b = await read(env, 'bot'); return json(b ? { ...b.data, cloud: true } : { disabled: true }); }
    if (p === '/api/candles') return json((await read(env, 'candles'))?.data || []);
    if (p.startsWith('/api/')) return json({ error: 'Disponibile solo sul Mac' }, 403);

    // --- dashboard files ------------------------------------------------------------
    return env.ASSETS.fetch(req);
  },
};
