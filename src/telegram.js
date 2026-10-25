// Telegram bot: pushes the paper bot's notifications and answers commands
// from your chat only (/stato, /posizioni, /trade, /segnale, /pausa, /riattiva).
// Long polling, no webhook: nothing on the Mac is exposed to the internet.
const config = require('./config');
const { kvGet, kvSet } = require('./db');

const log = (...a) => console.log(new Date().toISOString(), '[telegram]', ...a);
const apiBase = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const enabled = () => !!(config.telegramToken && config.telegramChatId);

async function call(method, params = {}, { token = config.telegramToken, timeoutMs = 15000 } = {}) {
  const r = await fetch(`${apiBase()}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const n0 = (x) => Number(x).toLocaleString('it-IT', { maximumFractionDigits: 0 });
const n2 = (x) => Number(x).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${n2(Math.abs(x))} $`;
const pct = (x) => `${x > 0 ? '+' : ''}${n2(x)}%`;
const hhmm = (t) => new Date(t).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function sendHTML(html, { silent = false } = {}) {
  return call('sendMessage', { chat_id: config.telegramChatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: silent });
}

const ICON = { plan: '📝', fill: '✅', partial: '💰', exit: '🏁', stop: '🛡', brake: '🚨', skip: '⏸', cancel: '✖️' };

// Bot notification → message. Low-importance events arrive silently.
function notification(n) {
  const silent = ['stop', 'cancel', 'skip', 'fill'].includes(n.kind) && n.priority !== 'high';
  return sendHTML(`${ICON[n.kind] || '•'} <b>${esc(n.title)}</b>\n${esc(n.body)}`, { silent });
}

// ---- commands ---------------------------------------------------------------
const COMMANDS = [
  ['stato', 'Conto, giornata e stato del bot'],
  ['posizioni', 'Posizioni aperte e ordini in attesa'],
  ['trade', 'Ultime campagne chiuse'],
  ['segnale', "Ultima istruzione di Chento"],
  ['pausa', 'Ferma le nuove entry'],
  ['riattiva', 'Riprende le nuove entry'],
  ['aiuto', 'Elenco dei comandi'],
];

function statusText(snap) {
  const s = snap.summary;
  const st = { active: '🟢 Attivo', paused: '⏸ In pausa', blocked: '🟠 Fermo fino a domani' }[s.status];
  return [
    `<b>Bot Desk</b> · ${st}${snap.pauseReason ? ` (${esc(snap.pauseReason)})` : ''}`,
    `Capitale <b>${n2(s.equity)} $</b> (${pct(s.returnPct)})`,
    `Oggi ${pct(s.todayPct)} · Drawdown ${n2(s.drawdownPct)}% (max ${n2(s.maxDrawdownPct)}%)`,
    `Campagne chiuse ${s.trades}${s.winRate != null ? ` · vinte ${n0(s.winRate)}%` : ''}`,
    snap.price ? `BTC ${n0(snap.price)}` : '',
  ].filter(Boolean).join('\n');
}

function positionsText(snap) {
  const out = [];
  for (const side of ['LONG', 'SHORT']) {
    const c = snap.campaigns[side];
    if (!c) continue;
    const lines = [`<b>${side}</b> · campagna #${c.id}`];
    if (c.qty > 0) {
      lines.push(`${c.qty.toFixed(4)} BTC a ${n0(c.avg)} · stop ${n0(c.stop)}`);
      lines.push(`P&L aperto ${usd(c.unrealized)} · realizzato ${usd(c.realized)}`);
      lines.push(c.tp1 ? `TP1 preso, trailing dal migliore ${n0(c.peak)}` : c.be ? 'Stop a breakeven' : 'In attesa di +' + snap.config.bePct + '%');
    }
    for (const o of c.orders) lines.push(`⏳ limit ${n0(o.price)} · ${o.qty.toFixed(4)} BTC${snap.price ? ` (${pct((o.price - snap.price) / snap.price * 100)})` : ''}`);
    out.push(lines.join('\n'));
  }
  return out.length ? out.join('\n\n') : 'Nessuna posizione né ordine in attesa.';
}

function tradesText(snap) {
  const tr = snap.trades.slice(0, 8);
  if (!tr.length) return 'Ancora nessuna campagna chiusa.';
  return '<b>Ultime campagne</b>\n' + tr.map((t) => `${t.pnl >= 0 ? '🟢' : '🔴'} ${t.side} ${hhmm(t.closedAt)} · ${n0(t.avg)} → ${n0(t.exit)} · <b>${usd(t.pnl)}</b> (${esc(t.reason)})`).join('\n');
}

function helpText() {
  return '<b>Comandi</b>\n' + COMMANDS.map(([c, d]) => `/${c} — ${d}`).join('\n') + '\n\nRiceverai qui ogni piano, esecuzione, uscita e allarme del bot. Conto simulato: nessun ordine reale.';
}

async function handle(text, ctx) {
  const cmd = (text || '').trim().split(/\s+/)[0].replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
  const snap = () => ctx.bot.snapshot(ctx.price());
  switch (cmd) {
    case 'start': case 'aiuto': case 'help': return helpText();
    case 'stato': return statusText(snap());
    case 'posizioni': return positionsText(snap());
    case 'trade': return tradesText(snap());
    case 'segnale': {
      const m = ctx.lastSignal();
      return m ? `<b>Ultima istruzione</b> · ${hhmm(m.ts)}\n${esc(m.content || '(immagine)')}${m.summary ? `\n<i>${esc(m.summary)}</i>` : ''}` : 'Nessuna istruzione recente.';
    }
    case 'pausa': await ctx.bot.pause(); return '⏸ Bot in pausa. Gli ordini in attesa sono stati cancellati; le posizioni aperte restano gestite.\n/riattiva per ripartire.';
    case 'riattiva': await ctx.bot.resume(); return '🟢 Bot riattivato: nuove entry di nuovo consentite.';
    default: return 'Comando non riconosciuto. /aiuto per l’elenco.';
  }
}

// ---- polling loop -----------------------------------------------------------
let running = false;
async function start(ctx) {
  if (!enabled() || running) return;
  running = true;
  try {
    await call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    const me = await call('getMe');
    log(`connected as @${me.username}`);
  } catch (e) { log('setup failed:', e.message); }

  let offset = Number(kvGet('telegram_offset') || 0);
  while (running) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, { timeoutMs: 65000 });
      for (const u of updates) {
        offset = u.update_id + 1;
        kvSet('telegram_offset', offset);
        const m = u.message;
        if (!m?.text) continue;
        if (String(m.chat.id) !== String(config.telegramChatId)) { log(`ignored message from chat ${m.chat.id}`); continue; }
        const reply = await handle(m.text, ctx).catch((e) => `Errore: ${esc(e.message)}`);
        await sendHTML(reply).catch((e) => log('reply failed:', e.message));
      }
    } catch (e) {
      log('poll error:', e.message);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}
const stop = () => { running = false; };

module.exports = { call, enabled, notification, sendHTML, start, stop, handle, COMMANDS };
