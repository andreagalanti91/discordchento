// OHLC candles from Binance public endpoints (no key), cached on disk.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const CACHE = path.join(DATA_DIR, 'candles');
fs.mkdirSync(CACHE, { recursive: true });

const ENDPOINTS = [
  'https://fapi.binance.com/fapi/v1/klines', // USDT-M perps (most signal channels trade these)
  'https://api.binance.com/api/v3/klines',
];
const INTERVAL_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

async function fetchRange(symbol, interval, start, end) {
  for (const base of ENDPOINTS) {
    const out = [];
    let t = start;
    let ok = true;
    while (t < end) {
      const u = `${base}?symbol=${symbol}&interval=${interval}&startTime=${t}&endTime=${end}&limit=1500`;
      const r = await fetch(u);
      if (!r.ok) { ok = false; break; }
      const rows = await r.json();
      if (!rows.length) break;
      for (const k of rows) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
      t = rows[rows.length - 1][0] + INTERVAL_MS[interval];
      if (rows.length < 1500) break;
    }
    if (ok && out.length) return out;
  }
  return [];
}

// Candles for [start, end], cached per symbol/interval/day so reruns are instant.
async function candles(symbol, interval, start, end) {
  const day = 86400e3;
  const all = [];
  for (let d = Math.floor(start / day) * day; d < end; d += day) {
    const f = path.join(CACHE, `${symbol}_${interval}_${new Date(d).toISOString().slice(0, 10)}.json`);
    let rows;
    const complete = d + day < Date.now() - INTERVAL_MS[interval];
    if (fs.existsSync(f)) rows = JSON.parse(fs.readFileSync(f, 'utf8'));
    else {
      rows = await fetchRange(symbol, interval, d, Math.min(d + day, Date.now()) - 1);
      if (complete && rows.length) fs.writeFileSync(f, JSON.stringify(rows));
    }
    all.push(...rows);
  }
  return all.filter((k) => k.t >= start - INTERVAL_MS[interval] && k.t <= end);
}

async function lastPrice(symbol) {
  for (const u of [`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`]) {
    try { const r = await fetch(u); if (r.ok) return +(await r.json()).price; } catch {}
  }
  return null;
}

module.exports = { candles, lastPrice, INTERVAL_MS };
