// Runs the paper bot live: channel events from the analyzer, closed 1m bars
// from Binance, state saved in SQLite after every step so a restart (or the
// Mac sleeping) resumes exactly where it stopped, replaying missed candles.
const { kvGet, kvSet } = require('./db');
const { PaperBot, DEFAULTS } = require('./bot');
const { candles } = require('./market');
const notify = require('./notify');

const log = (...a) => console.log(new Date().toISOString(), '[bot]', ...a);
const env = process.env;
const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);

function botConfig() {
  return {
    capital: num('BOT_CAPITAL', DEFAULTS.capital),
    riskPct: num('BOT_RISK_PCT', DEFAULTS.riskPct),
    dcaRiskPct: num('BOT_DCA_RISK_PCT', DEFAULTS.dcaRiskPct),
    maxCampaignRiskPct: num('BOT_MAX_CAMPAIGN_RISK_PCT', DEFAULTS.maxCampaignRiskPct),
    maxEntries: num('BOT_MAX_ENTRIES', DEFAULTS.maxEntries),
    maxLeverage: num('BOT_MAX_LEVERAGE', DEFAULTS.maxLeverage),
    frontrun: num('BOT_FRONTRUN', DEFAULTS.frontrun),
    stopPct: num('BOT_STOP_PCT', DEFAULTS.stopPct),
    bePct: num('BOT_BE_PCT', DEFAULTS.bePct),
    tp1Pct: num('BOT_TP1_PCT', DEFAULTS.tp1Pct),
    tp1Frac: num('BOT_TP1_FRAC', DEFAULTS.tp1Frac),
    trailPct: num('BOT_TRAIL_PCT', DEFAULTS.trailPct),
    orderTTLh: num('BOT_ORDER_TTL_H', DEFAULTS.orderTTLh),
    dailyLossPct: num('BOT_DAILY_LOSS_PCT', DEFAULTS.dailyLossPct),
    maxDrawdownPct: num('BOT_MAX_DD_PCT', DEFAULTS.maxDrawdownPct),
  };
}

class BotRunner {
  constructor({ onUpdate } = {}) {
    this.onUpdate = onUpdate || (() => {});
    const saved = kvGet('bot_state');
    this.bot = new PaperBot(botConfig(), saved ? JSON.parse(saved) : null);
    this.price = null;
    this.busy = Promise.resolve();
  }

  save() { kvSet('bot_state', JSON.stringify(this.bot.s)); }

  // Serialize every mutation so events and bars never interleave.
  run(fn) { this.busy = this.busy.then(fn).catch((e) => log('error', e.stack || e.message)); return this.busy; }

  async flush() {
    const notes = this.bot.drain();
    this.save();
    for (const n of notes) {
      log(`${n.kind}: ${n.title} | ${n.body.replace(/\n/g, ' · ')}`);
      if (n.kind !== 'skip' || n.priority) await notify.send(n).catch(() => {});
    }
    if (notes.length) this.onUpdate(this.snapshot());
  }

  // Analyzer output for one message: apply entry/management events.
  onSignal(events, ref, t, msgId) {
    return this.run(async () => {
      for (const e of events) if (e.type !== 'info') this.bot.onEvent({ ...e, t, msgId }, ref);
      await this.flush();
    });
  }

  // Fetch closed 1m bars since the last processed one (catch-up after sleep).
  tick() {
    return this.run(async () => {
      const now = Date.now();
      const last = this.bot.s.lastBarT ?? (now - 5 * 60e3);
      const from = Math.max(last + 60e3, now - 3 * 86400e3);
      const bars = (await candles('BTCUSDT', '1m', from, now)).filter((b) => b.t > (this.bot.s.lastBarT ?? 0) && b.t + 60e3 <= now);
      for (const b of bars) this.bot.onBar(b);
      if (bars.length) this.price = bars[bars.length - 1].c;
      await this.flush();
      if (bars.length > 5) log(`caught up ${bars.length} candles`);
    });
  }

  // Signals posted shortly before the bot started still deserve their orders.
  seed(recent) {
    if (kvGet('bot_seeded')) return Promise.resolve();
    return this.run(async () => {
      for (const r of recent) for (const e of r.events) if (e.type === 'entry') this.bot.onEvent({ ...e, t: Date.now(), msgId: r.msgId }, r.ref);
      kvSet('bot_seeded', '1');
      await this.flush();
    });
  }

  pause() { return this.run(async () => { this.bot.pause(Date.now()); await this.flush(); }); }
  resume() { return this.run(async () => { this.bot.resume(Date.now()); await this.flush(); }); }
  testNotify() { return notify.send({ kind: 'plan', title: 'Notifica di prova', body: 'Se leggi questo messaggio, le notifiche del bot funzionano.' }); }

  snapshot(price = this.price) {
    const s = this.bot.s;
    const px = price ?? s.curve[s.curve.length - 1]?.eq;
    const camp = (c) => c && {
      ...c, unrealized: c.qty > 0 && price ? +(c.qty * (price - c.avg) * (c.side === 'LONG' ? 1 : -1)).toFixed(2) : 0,
      notional: +(c.qty * (price || c.avg)).toFixed(2),
    };
    return {
      config: this.bot.cfg, notify: notify.enabled(), price,
      summary: this.bot.summary(price ?? 0),
      campaigns: { LONG: camp(s.campaigns.LONG), SHORT: camp(s.campaigns.SHORT) },
      trades: s.trades.slice(-100).reverse(), log: s.log.slice(-80).reverse(), curve: s.curve,
      startedAt: s.startedAt, paused: s.paused, pauseReason: s.pauseReason, blockedDay: s.blockedDay, lastBarT: s.lastBarT,
    };
  }
}

module.exports = { BotRunner, botConfig };
