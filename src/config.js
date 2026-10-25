// Settings come from env vars (see .env.example); defaults target the original channel.
const fs = require('fs');
const path = require('path');

const envFile = process.env.DESK_ENV_FILE || path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
module.exports = {
  guildId: env.DISCORD_GUILD_ID || '1042855255089623100',
  channelId: env.DISCORD_CHANNEL_ID || '1547586761515860069',
  headless: env.HEADLESS === '1',
  reloadMinutes: Number(env.RELOAD_MINUTES || 20),
  port: Number(env.PORT || 4777),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  priceSource: env.PRICE_SOURCE || 'binance',
  botEnabled: env.BOT_ENABLED !== '0',
  ntfyTopic: env.NTFY_TOPIC || '',
  ntfyServer: env.NTFY_SERVER || 'https://ntfy.sh',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: env.TELEGRAM_CHAT_ID || '',
};
