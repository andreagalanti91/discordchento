// Phone notifications: Telegram (see telegram.js) and/or ntfy.
// Both are off until configured in .env.
const config = require('./config');
const telegram = require('./telegram');

const log = (...a) => console.log(new Date().toISOString(), '[notify]', ...a);

async function ntfy(title, body, { priority, tags } = {}) {
  if (!config.ntfyTopic) return false;
  const r = await fetch(`${config.ntfyServer.replace(/\/$/, '')}/${encodeURIComponent(config.ntfyTopic)}`, {
    method: 'POST',
    // Non-ASCII titles must go in the body for ntfy; keep the title header ASCII.
    headers: { Title: title.normalize('NFKD').replace(/[^\x20-\x7e]/g, ''), Priority: priority || 'default', ...(tags ? { Tags: tags } : {}) },
    body,
  });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
  return true;
}

const TAGS = { plan: 'memo', fill: 'white_check_mark', partial: 'moneybag', exit: 'checkered_flag', stop: 'shield', brake: 'rotating_light', skip: 'pause_button', cancel: 'x' };

async function send(n) {
  const title = `Desk Bot · ${n.title}`;
  const opts = { priority: n.priority || (n.kind === 'brake' ? 'high' : n.kind === 'plan' || n.kind === 'exit' ? 'default' : 'low'), tags: TAGS[n.kind] };
  const results = await Promise.allSettled([ntfy(title, n.body, opts), telegram.enabled() ? telegram.notification(n).then(() => true) : false]);
  for (const r of results) if (r.status === 'rejected') log('send failed:', r.reason.message);
  return results.some((r) => r.status === 'fulfilled' && r.value);
}

const enabled = () => ({ ntfy: !!config.ntfyTopic, telegram: telegram.enabled() });

module.exports = { send, enabled };
