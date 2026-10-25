// Per-message analysis: parse the move, put it in market context, and turn it
// into a concrete Desk plan. Claude (optional, ANTHROPIC_API_KEY) adds a
// written read of the text + chart screenshots on top of the rule-based one.
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const { parse } = require('./parser');
const { candles, lastPrice } = require('./market');
const L = require('./levels');
const { VARIANTS, BASE } = require('./replica');
const config = require('./config');

const DESK = VARIANTS.desk;
const pct = (a, b) => ((a - b) / b) * 100;

async function marketContext(t) {
  const h = L.toHourly(await candles('BTCUSDT', '15m', t - 30 * 86400e3, t));
  if (h.length < 300) return null;
  const atr = L.atrSeries(h);
  const i = h.length - 1;
  const levels = L.levelsAt(h, i, atr, { ...L.DEFAULTS, zoneMult: 0.3 });
  const k = 2 / 201;
  let e = h[0].c;
  for (const x of h) e = x.c * k + e * (1 - k);
  const last = h[i];
  const day = h.slice(-24);
  return {
    price: last.c,
    atr: atr[i],
    atrPct: (atr[i] / last.c) * 100,
    ema200: e,
    trend: last.c > e ? 'UP' : 'DOWN',
    change24h: pct(last.c, day[0].o),
    levels: levels.filter((l) => l.touches >= 2).map((l) => ({ price: +l.price.toFixed(1), touches: l.touches })),
  };
}

function nearestLevel(levels, price) {
  let best = null;
  for (const l of levels || []) if (!best || Math.abs(l.price - price) < Math.abs(best.price - price)) best = l;
  return best ? { ...best, distPct: +pct(price, best.price).toFixed(3) } : null;
}

function deskPlan(entry, ctx, ref) {
  const d = entry.side === 'LONG' ? 1 : -1;
  const orders = entry.orders.map((o) => ({
    posted: o.price,
    limit: o.market ? ref : +(o.price + d * DESK.frontrun).toFixed(1),
    weight: o.weight,
    market: !!o.market,
    distPct: +pct(o.price, ref).toFixed(2),
    level: nearestLevel(ctx?.levels, o.price),
  }));
  const avg = orders.reduce((s, o) => s + o.limit * o.weight, 0);
  const lev = BASE.leverage;
  return {
    side: entry.side,
    orders,
    avgEntry: +avg.toFixed(1),
    stop: +(avg * (1 - d * DESK.hardStopPct / 100)).toFixed(1),
    breakevenAt: +(avg * (1 + d * DESK.beAtPct / 100)).toFixed(1),
    tp1: +(avg * (1 + d * DESK.tp1Pct / 100)).toFixed(1),
    tp2: +(avg * (1 + d * DESK.tp2Pct / 100)).toFixed(1),
    liqAt20x: +(avg * (1 - d * (1 / lev - BASE.maintMargin))).toFixed(1),
  };
}

function ruleVerdict(events, ctx, ref) {
  const notes = [];
  let score = 50;
  const plans = [];
  for (const e of events) {
    if (e.type === 'entry') {
      const plan = deskPlan(e, ctx, ref);
      plans.push(plan);
      const confirmed = plan.orders.filter((o) => o.level && Math.abs(o.level.distPct) < 0.25);
      if (confirmed.length) { score += 10 * confirmed.length; notes.push(`${confirmed.length}/${plan.orders.length} livelli coincidono con cluster pivot 1H (${confirmed.map((o) => `${o.level.price} ×${o.level.touches}`).join(', ')})`); }
      else notes.push('Livelli non confermati dai cluster pivot 1H: discrezionali');
      if (ctx) {
        const withTrend = (e.side === 'LONG') === (ctx.trend === 'UP');
        score += withTrend ? 8 : -8;
        notes.push(withTrend ? `A favore del trend 1H (EMA200 ${ctx.ema200.toFixed(0)})` : `Contro il trend 1H (EMA200 ${ctx.ema200.toFixed(0)}): mean-reversion`);
        const far = plan.orders.filter((o) => !o.market && Math.abs(o.distPct) > ctx.atrPct * 6);
        if (far.length) notes.push(`${far.length} ordine/i a più di 6 ATR: fill poco probabile`);
      }
      if (e.hedge) { score -= 5; notes.push('Hedge: riduce il rischio netto ma nel backtest Desk non aggiunge rendimento'); }
      if (e.orders.some((o) => o.market)) notes.push('Entry a mercato: lo storico mostra fill migliori sui limit');
      notes.push(`Desk: limit con frontrun $${DESK.frontrun}, SL ${plan.stop}, BE a ${plan.breakevenAt}, TP1 ${plan.tp1} (50%), TP2 ${plan.tp2}. Liquidazione a 20x ≈ ${plan.liqAt20x}`);
    }
    if (e.type === 'take') notes.push(`Presa parziale ${e.pct}% del residuo${e.sides.length ? ' (' + e.sides.join('/') + ')' : ''}${e.approx ? ' — quantità non specificata, stimata 20%' : ''}`);
    if (e.type === 'be') notes.push('Stop a breakeven: coerente con la regola Desk (BE dopo +0.8%)');
    if (e.type === 'sl') notes.push(`Stop esplicito a ${e.price} (il canale dichiara che gli SL sono di solito "placeholder")`);
  }
  const kind = events.some((e) => e.type === 'entry') ? 'entry' : events.some((e) => ['take', 'be', 'sl'].includes(e.type)) ? 'management' : 'info';
  return { kind, score: Math.max(0, Math.min(100, score)), notes, plans };
}

let client = null;
async function claudeRead(msg, events, ctx, rule) {
  if (!config.anthropicKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  client ||= new Anthropic({ apiKey: config.anthropicKey });
  const imgs = JSON.parse(msg.attachments || '[]').filter((a) => a.local).slice(0, 3).map((a) => {
    const p = path.join(DATA_DIR, a.local);
    const ext = path.extname(p).slice(1).replace('jpg', 'jpeg');
    return { type: 'image', source: { type: 'base64', media_type: `image/${ext}`, data: fs.readFileSync(p).toString('base64') } };
  });
  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Una frase in italiano: cosa sta facendo il trader' },
      action: { type: 'string', enum: ['nuova entry', 'aggiunta/DCA', 'presa profitto', 'stop/breakeven', 'chiusura', 'aggiornamento', 'nessuna azione'] },
      side: { type: 'string', enum: ['LONG', 'SHORT', 'ENTRAMBI', 'N/A'] },
      levels: { type: 'array', items: { type: 'number' } },
      image_read: { type: 'string', description: 'Cosa mostrano gli screenshot (posizioni, entry, PnL, livelli)' },
      risk_notes: { type: 'array', items: { type: 'string' } },
      follow: { type: 'string', enum: ['segui', 'segui con piano Desk', 'attendi', 'ignora'] },
    },
    required: ['summary', 'action', 'side', 'levels', 'image_read', 'risk_notes', 'follow'],
    additionalProperties: false,
  };
  const res = await client.beta.messages.create({
    model: config.model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: 'Sei un analista di trading. Analizzi i messaggi di un canale Discord di segnali BTCUSDT perp (trader "Chento", livelli di liquidità, ladder limit, take parziali sul residuo, leva 20-50x). Sii concreto e scettico; rispondi in italiano.',
    messages: [{
      role: 'user',
      content: [
        ...imgs,
        { type: 'text', text: `Messaggio (${msg.ts}):\n${msg.content || '(solo immagine)'}\n\nEventi estratti: ${JSON.stringify(events)}\nContesto mercato: ${JSON.stringify(ctx && { ...ctx, levels: ctx.levels.slice(0, 30) })}\nAnalisi a regole: ${JSON.stringify(rule)}` },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.find((b) => b.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

async function analyze(messageId) {
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
  if (!msg) return null;
  const t = Date.parse(msg.ts);
  const live = Date.now() - t < 10 * 60e3;
  const k = await candles('BTCUSDT', '1m', t - 60e3, t + 60e3);
  const ref = live ? (await lastPrice('BTCUSDT')) ?? k[k.length - 1]?.c : k[0]?.c;
  const events = parse(msg.content, ref);
  const ctx = await marketContext(t).catch(() => null);
  const rule = ruleVerdict(events, ctx, ref);
  let ai = null;
  try { ai = await claudeRead(msg, events, ctx, rule); } catch (e) { console.error('[analyzer] claude', e.message); }
  const verdict = { ref, events, rule, ai, ctx: ctx && { ...ctx, levels: ctx.levels.filter((l) => Math.abs(pct(l.price, ref)) < 6) } };
  const summary = ai?.summary || rule.notes[0] || (events[0]?.type === 'info' ? 'Nessuna istruzione operativa' : '');
  db.prepare(`INSERT INTO analyses(message_id, ts, summary, verdict, created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET summary=excluded.summary, verdict=excluded.verdict, created_at=excluded.created_at`)
    .run(msg.id, msg.ts, summary, JSON.stringify(verdict), new Date().toISOString());
  db.prepare('UPDATE messages SET analyzed=1 WHERE id=?').run(msg.id);
  return { message: msg, summary, verdict };
}

async function analyzePending() {
  const rows = db.prepare('SELECT id FROM messages WHERE analyzed=0 ORDER BY ts').all();
  for (const r of rows) await analyze(r.id).catch((e) => console.error('[analyzer]', r.id, e.message));
  return rows.length;
}

module.exports = { analyze, analyzePending, marketContext };
