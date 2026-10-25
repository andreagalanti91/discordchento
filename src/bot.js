// Paper-trading bot: the Desk strategy on a simulated account.
// Pure state machine (no I/O): feed it channel events and closed 1m bars, it
// returns notifications. The live runner (bot-runner.js) and the historical
// replay (scripts/bot-replay.js) drive the exact same code.
//
// Per campaign: limit ladder on the channel's levels (front-run), size so the
// stop loses `riskPct` of equity, stop `stopPct` from the average, breakeven at
// +bePct, TP1 (tp1Frac) at +tp1Pct, then the rest trails `trailPct` behind the
// best price. Channel messages are obeyed only when they cut risk.

const DEFAULTS = {
  capital: 10000,
  riskPct: 1,           // equity lost if a full campaign hits its stop
  dcaRiskPct: 0.5,      // extra risk an additional entry message may add
  maxCampaignRiskPct: 2,
  maxEntries: 3,        // orders per campaign
  maxLeverage: 10,      // cap on open + pending notional vs equity
  frontrun: 150,
  stopPct: 2.5,
  bePct: 0.8,
  tp1Pct: 0.8,
  tp1Frac: 0.5,
  trailPct: 0.7,
  orderTTLh: 72,
  dailyLossPct: 3,      // block new entries for the rest of the UTC day
  maxDrawdownPct: 15,   // pause the bot until resumed by hand
  makerFee: 0.0002,
  takerFee: 0.0005,
};

const dirOf = (side) => (side === 'LONG' ? 1 : -1);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 10) / 10;

function newState(cfg, t) {
  return {
    version: 1, startedAt: t, lastBarT: null, equity: cfg.capital, peak: cfg.capital,
    day: { date: dayOf(t), start: cfg.capital }, paused: false, pauseReason: null, blockedDay: null,
    campaigns: { LONG: null, SHORT: null }, nextId: 1, trades: [], log: [], curve: [{ t, eq: cfg.capital }],
  };
}

class PaperBot {
  constructor(cfg = {}, state = null, now = Date.now()) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.s = state || newState(this.cfg, now);
    this.out = [];
  }

  // ---- helpers ------------------------------------------------------------
  note(t, kind, title, body, extra = {}) {
    const n = { t, kind, title, body, ...extra };
    this.s.log.push(n);
    if (this.s.log.length > 500) this.s.log.splice(0, this.s.log.length - 500);
    this.out.push(n);
  }
  drain() { const o = this.out; this.out = []; return o; }

  exposure(px) {
    let n = 0;
    for (const c of Object.values(this.s.campaigns)) if (c) {
      n += c.qty * (px || c.avg || 0);
      for (const o of c.orders) n += o.qty * o.price;
    }
    return n;
  }
  canOpen(t) {
    if (this.s.paused) return `bot in pausa (${this.s.pauseReason})`;
    if (this.s.blockedDay === dayOf(t)) return 'limite di perdita giornaliero raggiunto';
    return null;
  }
  unrealized(px) {
    let u = 0;
    for (const c of Object.values(this.s.campaigns)) if (c && c.qty > 0) u += c.qty * (px - c.avg) * dirOf(c.side);
    return u;
  }

  // ---- channel events -----------------------------------------------------
  onEvent(e, ref) {
    const t = e.t;
    if (e.type === 'entry') return this.onEntry(e, ref, t);
    const sides = e.sides?.length ? e.sides : ['LONG', 'SHORT'].filter((s) => this.s.campaigns[s]);
    if (e.type === 'take' && e.pct >= 100) {
      for (const s of sides) {
        const c = this.s.campaigns[s];
        if (!c) continue;
        if (c.qty > 0) this.close(c, ref, 1, t, 'chiusura del canale');
        else this.cancelCampaign(c, t, 'il canale ha chiuso');
      }
    } else if (e.type === 'be') {
      for (const s of sides) {
        const c = this.s.campaigns[s];
        if (!c || c.qty <= 0) continue;
        const inProfit = (ref - c.avg) * dirOf(s) > 0;
        if (inProfit && (c.avg - c.stop) * dirOf(s) > 0) {
          c.stop = c.avg; c.be = true;
          this.note(t, 'stop', `${s}: stop a breakeven`, `Il canale ha scritto "sl be": stop spostato a ${r1(c.avg)}.`);
        }
      }
    } else if (e.type === 'sl') {
      const c = this.s.campaigns[e.side];
      if (c && c.qty > 0 && (e.price - c.stop) * dirOf(e.side) > 0) {
        c.stop = e.price; c.channelStop = e.price;
        this.note(t, 'stop', `${e.side}: stop del canale`, `Stop più stretto indicato dal canale: ${r1(e.price)}.`);
      }
    }
    // partial "take X%" messages are deliberately ignored: Desk exits replace them
  }

  onEntry(e, ref, t) {
    const block = this.canOpen(t);
    if (block) { this.note(t, 'skip', `Entry ${e.side} ignorata`, block); return; }
    const d = dirOf(e.side);
    let c = this.s.campaigns[e.side];
    const isNew = !c;
    if (c && e.modify) c.orders = [];
    const room = this.cfg.maxEntries - (c ? c.orders.length + c.fills.length : 0);
    if (room <= 0) { this.note(t, 'skip', `DCA ${e.side} ignorato`, `Già ${this.cfg.maxEntries} ingressi in questa campagna.`); return; }

    // A level already resting in this campaign is not ordered twice.
    const resting = new Set((c?.orders || []).map((o) => o.posted));
    const legs = e.orders.filter((o) => o.market || !resting.has(o.price)).slice(0, room)
      .map((o) => ({ price: o.market ? ref : o.price + d * this.cfg.frontrun, posted: o.market ? null : o.price, weight: o.weight, market: !!o.market }));
    if (!legs.length) { this.note(t, 'skip', `DCA ${e.side} ignorato`, 'Livelli già presenti negli ordini aperti.'); return; }
    const wSum = legs.reduce((a, l) => a + l.weight, 0) || 1;
    const avg = legs.reduce((a, l) => a + l.price * l.weight, 0) / wSum;
    const usedRisk = c ? c.riskBudget : 0;
    const riskPct = Math.min(isNew ? this.cfg.riskPct : this.cfg.dcaRiskPct, this.cfg.maxCampaignRiskPct - usedRisk);
    if (riskPct <= 0) { this.note(t, 'skip', `DCA ${e.side} ignorato`, 'Rischio massimo della campagna già allocato.'); return; }
    const riskUsd = this.s.equity * riskPct / 100;
    let qty = riskUsd / (avg * this.cfg.stopPct / 100);
    const cap = this.s.equity * this.cfg.maxLeverage - this.exposure(ref);
    if (qty * avg > cap) qty = Math.max(0, cap / avg);
    if (qty * avg < 10) { this.note(t, 'skip', `Entry ${e.side} ignorata`, 'Esposizione massima raggiunta.'); return; }

    if (isNew) {
      c = this.s.campaigns[e.side] = { id: this.s.nextId++, side: e.side, msgId: e.msgId, openedAt: t, orders: [], fills: [], qty: 0, avg: 0, maxQty: 0, stop: null, be: false, tp1: false, peak: null, realized: 0, fees: 0, riskBudget: 0 };
    }
    c.riskBudget += riskPct;
    const placed = [];
    for (const l of legs) {
      const q = qty * l.weight / wSum;
      if (l.market) this.fill(c, ref, q, t, this.cfg.takerFee, 'mercato');
      else { c.orders.push({ price: l.price, posted: l.posted, qty: q, t }); placed.push(l); }
    }
    const planStop = avg * (1 - d * this.cfg.stopPct / 100);
    this.note(t, 'plan', `${isNew ? 'Nuovo piano' : 'DCA'} ${e.side} · rischio ${riskPct}%`,
      [...legs.map((l, i) => `${i + 1}) ${l.market ? 'a mercato' : 'limit ' + r1(l.price)} · ${(qty * l.weight / wSum).toFixed(4)} BTC`),
        `Stop ${r1(planStop)} · BE da +${this.cfg.bePct}% · TP1 ${this.cfg.tp1Frac * 100}% a +${this.cfg.tp1Pct}% · poi trailing ${this.cfg.trailPct}%`,
        `Rischio ${Math.round(riskUsd)} $ su ${Math.round(this.s.equity)} $`].join('\n'), { side: e.side, msgId: e.msgId });
  }

  // ---- position mechanics ---------------------------------------------------
  fill(c, px, qty, t, fee, how) {
    c.avg = (c.avg * c.qty + px * qty) / (c.qty + qty);
    c.qty += qty;
    c.maxQty = Math.max(c.maxQty, c.qty);
    const f = qty * px * fee;
    c.fees += f; this.s.equity -= f;
    c.fills.push({ t, px: r1(px), qty: +qty.toFixed(6) });
    // Stop follows the new average; a tighter channel stop or breakeven wins.
    const d = dirOf(c.side);
    let stop = c.avg * (1 - d * this.cfg.stopPct / 100);
    if (c.channelStop && (c.channelStop - stop) * d > 0) stop = c.channelStop;
    if (c.be && (c.avg - stop) * d > 0) stop = c.avg;
    c.stop = stop;
    this.note(t, 'fill', `${c.side} eseguito ${how ? '(' + how + ')' : ''}`.trim(), `${qty.toFixed(4)} BTC a ${r1(px)}. Medio ${r1(c.avg)}, stop ${r1(c.stop)}.`, { side: c.side });
  }

  close(c, px, frac, t, reason) {
    const q = c.qty * Math.min(frac, 1);
    const pnl = q * (px - c.avg) * dirOf(c.side);
    const f = q * px * this.cfg.takerFee;
    c.realized += pnl - f; c.fees += f;
    this.s.equity += pnl - f;
    c.qty -= q;
    const done = c.qty <= c.maxQty * 0.001;
    this.note(t, done ? 'exit' : 'partial', `${c.side} · ${reason}`,
      `${q.toFixed(4)} BTC a ${r1(px)} · ${pnl - f >= 0 ? '+' : ''}${(pnl - f).toFixed(2)} $${done ? `\nCampagna chiusa: ${c.realized >= 0 ? '+' : ''}${c.realized.toFixed(2)} $` : ''}`, { side: c.side });
    if (done) this.finish(c, t, reason, px);
  }

  finish(c, t, reason, px) {
    this.s.trades.push({ id: c.id, side: c.side, msgId: c.msgId, openedAt: c.openedAt, closedAt: t, avg: r1(c.avg), exit: r1(px), qty: +c.maxQty.toFixed(6), pnl: +c.realized.toFixed(2), fees: +c.fees.toFixed(2), reason, fills: c.fills.length });
    this.s.campaigns[c.side] = null;
  }

  cancelCampaign(c, t, why) {
    if (c.qty > 0) { c.orders = []; return; }
    this.s.campaigns[c.side] = null;
    this.note(t, 'cancel', `${c.side}: ordini cancellati`, why, { side: c.side });
  }

  // ---- 1m bar ----------------------------------------------------------------
  onBar(b) {
    if (this.s.lastBarT != null && b.t <= this.s.lastBarT) return;
    this.s.lastBarT = b.t;
    const cfg = this.cfg;
    if (dayOf(b.t) !== this.s.day.date) {
      this.s.day = { date: dayOf(b.t), start: this.s.equity };
    }

    for (const side of ['LONG', 'SHORT']) {
      const c = this.s.campaigns[side];
      if (!c) continue;
      const d = dirOf(side);
      // stops first: if a candle touches stop and target, assume the stop
      if (c.qty > 0 && (side === 'LONG' ? b.l <= c.stop : b.h >= c.stop)) {
        const px = side === 'LONG' ? Math.min(c.stop, b.o) : Math.max(c.stop, b.o);
        this.close(c, px, 1, b.t, c.tp1 ? 'trailing stop' : c.be ? 'breakeven' : 'stop loss');
        continue;
      }
      if (c.qty > 0) {
        const fav = side === 'LONG' ? b.h : b.l;
        const move = ((fav - c.avg) / c.avg) * d * 100;
        if (!c.be && move >= cfg.bePct) {
          c.be = true;
          if ((c.avg - c.stop) * d > 0) c.stop = c.avg;
          this.note(b.t, 'stop', `${side}: stop a breakeven`, `+${cfg.bePct}% raggiunto: stop a ${r1(c.avg)}.`, { side });
        }
        if (!c.tp1 && move >= cfg.tp1Pct) {
          c.tp1 = true; c.orders = [];
          c.peak = fav;
          this.close(c, c.avg * (1 + d * cfg.tp1Pct / 100), cfg.tp1Frac, b.t, `TP1 +${cfg.tp1Pct}%`);
          if (!this.s.campaigns[side]) continue;
        }
        if (c.tp1) {
          c.peak = side === 'LONG' ? Math.max(c.peak, b.h) : Math.min(c.peak, b.l);
          const trail = c.peak * (1 - d * cfg.trailPct / 100);
          if ((trail - c.stop) * d > 0) c.stop = trail;
        }
      }
      // limit fills; expire stale orders
      c.orders = c.orders.filter((o) => {
        if (b.t - o.t > cfg.orderTTLh * 3600e3) return false;
        if (b.t < o.t) return true; // candle opened before the order existed
        if (side === 'LONG' ? b.l > o.price : b.h < o.price) return true;
        this.fill(c, side === 'LONG' ? Math.min(o.price, b.o) : Math.max(o.price, b.o), o.qty, b.t, cfg.makerFee, 'limit');
        return false;
      });
      // A candle that fills and then runs through the stop is a stopped trade.
      if (c.qty > 0 && c.fills[c.fills.length - 1]?.t === b.t && (side === 'LONG' ? b.l <= c.stop : b.h >= c.stop)) {
        this.close(c, c.stop, 1, b.t, 'stop loss');
        continue;
      }
      if (!c.orders.length && c.qty <= 0) this.cancelCampaign(c, b.t, 'Ordini scaduti senza esecuzione.');
    }

    // risk brakes (on equity marked to market)
    const eq = this.s.equity + this.unrealized(b.c);
    this.s.peak = Math.max(this.s.peak, eq);
    if (!this.s.paused && eq <= this.s.peak * (1 - cfg.maxDrawdownPct / 100)) {
      this.s.paused = true; this.s.pauseReason = `drawdown oltre ${cfg.maxDrawdownPct}%`;
      this.dropPending(b.t);
      this.note(b.t, 'brake', 'Bot in pausa', `Drawdown oltre il ${cfg.maxDrawdownPct}% dal massimo. Le posizioni aperte restano protette dagli stop; nessuna nuova entry finché non lo riattivi.`, { priority: 'high' });
    }
    if (this.s.blockedDay !== this.s.day.date && eq <= this.s.day.start * (1 - cfg.dailyLossPct / 100)) {
      this.s.blockedDay = this.s.day.date;
      this.dropPending(b.t);
      this.note(b.t, 'brake', 'Stop giornaliero', `Perdita di oggi oltre il ${cfg.dailyLossPct}%: niente nuove entry fino a domani (UTC).`, { priority: 'high' });
    }
    if (b.t % 3600e3 === 0) {
      this.s.curve.push({ t: b.t, eq: +eq.toFixed(2) });
      if (this.s.curve.length > 24 * 400) this.s.curve.splice(0, this.s.curve.length - 24 * 400);
    }
  }

  dropPending(t) {
    for (const c of Object.values(this.s.campaigns)) if (c) {
      if (c.qty > 0) c.orders = [];
      else this.s.campaigns[c.side] = null;
    }
  }

  resume(t) {
    this.s.paused = false; this.s.pauseReason = null; this.s.peak = this.s.equity + 0;
    this.note(t, 'brake', 'Bot riattivato', 'Nuove entry di nuovo consentite.');
  }
  pause(t, why = 'pausa manuale') {
    this.s.paused = true; this.s.pauseReason = why;
    this.dropPending(t);
    this.note(t, 'brake', 'Bot in pausa', 'Nessuna nuova entry; le posizioni aperte restano gestite.');
  }

  summary(px) {
    const tr = this.s.trades;
    const wins = tr.filter((x) => x.pnl > 0);
    const eq = this.s.equity + this.unrealized(px ?? 0);
    let peak = -Infinity, dd = 0;
    for (const p of this.s.curve) { peak = Math.max(peak, p.eq); dd = Math.max(dd, (peak - p.eq) / peak * 100); }
    return {
      capital: this.cfg.capital, equity: +eq.toFixed(2), realized: +this.s.equity.toFixed(2),
      returnPct: +((eq / this.cfg.capital - 1) * 100).toFixed(2),
      todayPct: +((eq / this.s.day.start - 1) * 100).toFixed(2),
      drawdownPct: +((1 - eq / Math.max(this.s.peak, eq)) * 100).toFixed(2), maxDrawdownPct: +dd.toFixed(2),
      trades: tr.length, winRate: tr.length ? +(wins.length / tr.length * 100).toFixed(1) : null,
      status: this.s.paused ? 'paused' : this.s.blockedDay === this.s.day.date ? 'blocked' : 'active',
    };
  }
}

module.exports = { PaperBot, DEFAULTS };
