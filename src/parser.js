// Turns the channel's free-text messages into trade events.
// The channel (Chento / ScalpX) trades BTCUSDT perps with limit ladders on
// liquidity levels and manages with "take N%" / "sl be" messages, so the
// parser is tuned to that vocabulary rather than to classic signal templates.
//
// Events:
//   { type:'entry', side, orders:[{price, weight}], market?:true, hedge?:true, modify?:true }
//   { type:'take', pct, sides }         pct of the RUNNING size (channel rule 7)
//   { type:'be', sides }                stop to breakeven
//   { type:'sl', side, price }
//   { type:'info', tags:[] }

const SIDE_WORDS = /\b(long(?:ing|ed)?|short(?:ing|ed)?|hedge)\b/gi;

// "85k", "85.6k", "82.200", "81.750", "82.2", "79.6k", "84.350" → BTC price.
function toPrice(raw, ref) {
  let s = raw.toLowerCase().replace(/[$,]/g, '');
  const k = s.endsWith('k');
  if (k) s = s.slice(0, -1);
  let n = Number(s);
  if (!isFinite(n)) return null;
  if (k || n < 1000) n *= 1000;
  if (ref && Math.abs(n - ref) / ref > 0.15) return null; // balances like "315k", "100k->200k"
  return n;
}

function numbersIn(text, ref) {
  const out = [];
  const re = /(\d{2,3}(?:[.,]\d{1,3})?k?|\d{2,3}\.\d{3}|\d{5,6}(?:\.\d+)?)/gi;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10).toLowerCase();
    if (/^\s*%/.test(after) || /^\s*x\b/.test(after)) continue;          // "25%", "20x"
    if (/\d\s*-\s*$/.test(before) && /%/.test(after.slice(0, 4))) continue;
    const price = toPrice(m[0], ref);
    if (!price) continue;
    let role = 'entry';
    if (/(tp|target|ideal tp|tp starting at|tp at)\s*[:=]?\s*$/.test(before) || /^\s*(ideal\s*)?tp\b/.test(after)) role = 'tp';
    else if (/\b(sl|stop|stops|stop loss)\s*[:=]?\s*$/.test(before) || /^\s*stops?\b/.test(after)) role = 'sl';
    else if (/(might go|wants|gives?|look for|lets see if gives|see if)\s*$/.test(before)) role = 'info';
    else if (/(missed)\s*$/.test(before)) role = 'info';
    out.push({ price, role, index: m.index, raw: m[0] });
  }
  return out;
}

// "20% here 30%-35% 80.4 50-40% 79.6"  /  "85.7 and 85.950 30% and 70%"
function weightsFor(text, orders) {
  const pairs = [...text.matchAll(/(\d{1,2})(?:\s*%?\s*-\s*(\d{1,2}))?\s*%\s*(here|[\d.,]+k?)/gi)];
  const w = {};
  for (const p of pairs) {
    const pct = p[2] ? (Number(p[1]) + Number(p[2])) / 2 : Number(p[1]);
    w[p[3].toLowerCase()] = pct;
  }
  const trailing = text.match(/(\d{1,2})\s*%\s*and\s*(\d{1,2})\s*%/i);
  orders.forEach((o, i) => {
    const key = Object.keys(w).find((k) => k !== 'here' && Math.abs(toPrice(k, o.price) - o.price) < 1);
    if (key) o.weight = w[key];
    else if (o.market && w.here) o.weight = w.here;
    else if (trailing && orders.length === 2) o.weight = Number(trailing[i + 1]);
  });
  const missing = orders.filter((o) => o.weight == null);
  const used = orders.reduce((a, o) => a + (o.weight || 0), 0);
  missing.forEach((o) => { o.weight = Math.max(100 - used, 0) / missing.length || 100 / orders.length; });
  const total = orders.reduce((a, o) => a + o.weight, 0) || 1;
  orders.forEach((o) => { o.weight = +(o.weight / total).toFixed(4); });
  return orders;
}

function sidesMentioned(t) {
  const s = new Set();
  if (/\blong/.test(t)) s.add('LONG');
  if (/\bshort|hedge/.test(t)) s.add('SHORT');
  if (/\b(both|all)\b/.test(t)) { s.add('LONG'); s.add('SHORT'); }
  return [...s];
}

function parse(content, refPrice) {
  const text = (content || '').replace(/<@&?\d+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').trim();
  const t = text.toLowerCase();
  const events = [];
  if (!t) return [{ type: 'info', tags: ['image-only'] }];
  // Long essays / rule posts / promos are context, not trade instructions.
  if (t.length > 600) return [{ type: 'info', tags: ['announcement'] }];

  // --- management ------------------------------------------------------------
  const sides = sidesMentioned(t);
  const takeRe = /\b(?:take|taking|close|closing|tp|i['’]?m out for|out for)\s*(?:another\s*|off\s*)?(\d{1,3})\s*%?(?!\d)(?!\s*(?:k\b|\.\d|entr))/i;
  const take = t.match(takeRe);
  const takeIsPrice = take && toPrice(take[1], refPrice) && !/%|take\s*\d{1,2}\s*$|take \d{1,2}\b/.test(t.slice(take.index, take.index + take[0].length + 2));
  if (take && !takeIsPrice && Number(take[1]) <= 100) {
    events.push({ type: 'take', pct: Number(take[1]), sides });
  } else if (/\bclose half\b/.test(t)) events.push({ type: 'take', pct: 50, sides });
  else if (/\b(tp some|take some|de-risk some|close some)\b/.test(t)) events.push({ type: 'take', pct: 20, sides, approx: true });
  else if (/\b(advice to close|close all|close here|closed? (the )?(long|short) fully)\b/.test(t)) events.push({ type: 'take', pct: 100, sides });

  if (/\bsl'?s?\s*(?:to\s*)?be\b|sl be|all sl[’']?s be/.test(t)) {
    const own = t.match(/\b(long|short)\s+sl'?s?\s*(?:to\s*)?be\b/);
    events.push({ type: 'be', sides: /all sl/.test(t) ? ['LONG', 'SHORT'] : own ? [own[1].toUpperCase()] : sides });
  }

  // --- entries ---------------------------------------------------------------
  const entryIntent = /(taking|take entry|entries|entruies|entry|longing|shorting|shorted|hedge short|\blong\b|\bshort\b|re-?enter|re-entry|scaling|dca|limits?)/.test(t)
    && !/^\s*(dca['’]?ed|moronic dca)/.test(t);
  const nums = numbersIn(text, refPrice);
  if (entryIntent) {
    // Split into segments at side keywords so "short 87.8 long 82.2" assigns correctly.
    const marks = [...text.matchAll(SIDE_WORDS)].map((m) => ({ i: m.index, side: /long/i.test(m[0]) ? 'LONG' : 'SHORT' }));
    const sideAt = (idx) => {
      let s = null;
      for (const m of marks) if (m.i <= idx) s = m.side;
      return s;
    };
    const bySide = { LONG: [], SHORT: [] };
    for (const n of nums.filter((x) => x.role === 'entry')) {
      const s = sideAt(n.index) || (refPrice ? (n.price < refPrice ? 'LONG' : 'SHORT') : null);
      if (s && !bySide[s].some((o) => o.price === n.price)) bySide[s].push({ price: n.price });
    }
    const marketHere = /\b(taking some here|get in|here \(long\)|here \(short\))\b/.test(t) || /\bhere\b.*\b(long|short)\b/.test(t);
    if (marketHere) {
      const s = /short/.test(t) ? 'SHORT' : 'LONG';
      bySide[s].unshift({ price: refPrice, market: true });
    }
    for (const side of ['LONG', 'SHORT']) {
      const orders = bySide[side];
      if (!orders.length) continue;
      // "Long sl BE tp starting at 84.4" mentions long only for management.
      events.push({
        type: 'entry', side,
        orders: weightsFor(text, orders),
        hedge: /hedge/.test(t) && side === 'SHORT' ? true : undefined,
        modify: /entry moved|moved/.test(t) || undefined,
        market: orders.some((o) => o.market) || undefined,
      });
    }
  }
  for (const n of nums.filter((x) => x.role === 'sl')) {
    const s = sides[0] || (refPrice && n.price < refPrice ? 'LONG' : 'SHORT');
    events.push({ type: 'sl', side: s, price: n.price });
  }

  if (!events.length) {
    const tags = [];
    if (/filled|dca['’]?ed/.test(t)) tags.push('filled');
    if (/x\.com|youtube|stream/.test(content || '')) tags.push('media');
    if (/inner circle|apply|challenge/.test(t)) tags.push('promo');
    events.push({ type: 'info', tags });
  }
  return events;
}

module.exports = { parse, toPrice };
