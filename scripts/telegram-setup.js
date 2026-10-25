// Links your Telegram chat to the bot: checks TELEGRAM_BOT_TOKEN from .env,
// waits for you to press "Avvia" (/start) in the bot's chat, then writes
// TELEGRAM_CHAT_ID to .env. Run: npm run telegram:setup
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const tg = require('../src/telegram');

const ENV = process.env.DESK_ENV_FILE || path.join(__dirname, '..', '.env');

function setEnv(key, value) {
  let s = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const line = `${key}=${value}`;
  s = new RegExp(`^${key}=.*$`, 'm').test(s) ? s.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${s.replace(/\n?$/, '\n')}${line}\n`;
  fs.writeFileSync(ENV, s);
}

(async () => {
  const token = config.telegramToken;
  if (!token) {
    console.log('Manca TELEGRAM_BOT_TOKEN nel file .env.\n1) Su Telegram apri @BotFather e invia /newbot\n2) Copia il token che ti dà\n3) Incollalo nel file .env dopo TELEGRAM_BOT_TOKEN= e rilancia questo comando.');
    process.exit(1);
  }
  let me;
  try { me = await tg.call('getMe', {}, { token }); }
  catch (e) { console.log(`Token non valido (${e.message}). Ricontrolla TELEGRAM_BOT_TOKEN nel .env.`); process.exit(1); }

  console.log(`Bot trovato: @${me.username}`);
  console.log(`Apri https://t.me/${me.username} sul telefono e premi "Avvia" (o scrivi /start). Attendo fino a 5 minuti…`);
  await tg.call('deleteWebhook', {}, { token }).catch(() => {});

  let offset = 0;
  const deadline = Date.now() + 5 * 60e3;
  while (Date.now() < deadline) {
    const updates = await tg.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, { token, timeoutMs: 35000 }).catch(() => []);
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m || m.chat.type !== 'private' || !/^\/start/.test(m.text || '')) continue;
      setEnv('TELEGRAM_CHAT_ID', m.chat.id);
      // confirm the pending update so the service does not answer it again
      await tg.call('getUpdates', { offset, timeout: 0 }, { token }).catch(() => {});
      await tg.call('sendMessage', { chat_id: m.chat.id, parse_mode: 'HTML', text: `✅ <b>Collegato.</b>\nDa ora ricevi qui le notifiche del Bot Desk.\n\nComandi: /stato /posizioni /trade /segnale /pausa /riattiva /aiuto` }, { token });
      console.log(`Collegato alla chat di ${m.from.first_name || 'te'}. TELEGRAM_CHAT_ID salvato nel .env.`);
      console.log('Riavvia il servizio per attivarlo:  launchctl kickstart -k gui/$(id -u)/com.signaldesk.agent');
      process.exit(0);
    }
  }
  console.log('Nessun /start ricevuto in 5 minuti. Rilancia il comando e premi "Avvia" nella chat del bot.');
  process.exit(1);
})();
