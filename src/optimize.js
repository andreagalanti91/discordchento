// Walk-forward random search for the Liquidity Levels strategy.
// train (first 8 months) → pick top-20 by train score → choose by validation
// (next 2 months) → report the untouched test window (last 2 months).
const L = require('./levels');

const SPACE = {
  zoneMult: [0.3, 0.5],
  minTouches: [2, 3, 4, 5, 6, 8],
  minDistATR: [0.5, 1, 1.5],
  maxDistATR: [3, 5, 8],
  frontrunATR: [0, 0.1, 0.2],
  ladderATR: [0.3, 0.6, 1],
  slATR: [0.75, 1.25, 2, 3, 4, 6],
  tp1R: [0.3, 0.5, 0.8, 1, 1.5, 2],
  beR: [null, 0.2, 0.3, 0.5],
  tp1Frac: [0.3, 0.5, 0.7],
  tp2: ['level', 2, 3],
  maxHoldH: [24, 72, 168],
  trendFilter: [false, true],
  hedge: [true, false],
};

function rng(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); }

function score(st) {
  if (st.trades < 25) return -Infinity;
  // Reward expectancy and consistency, punish drawdown.
  return st.totalR / Math.max(5, st.maxDrawdownPct) + Math.min(st.profitFactor || 0, 3);
}

async function optimize({ days = 365, samples = 2500, seed = 7, onProgress } = {}) {
  const to = Date.now();
  const from = to - days * 86400e3;
  const data = await L.loadData(from, to);
  const tTrain = from + (days - 120) * 86400e3;
  const tVal = from + (days - 60) * 86400e3;
  const lvCache = {};
  const levels = (z) => (lvCache[z] ||= L.precomputeLevels(data, { zoneMult: z }));

  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const seen = new Set();
  const runs = [];
  for (let i = 0; i < samples; i++) {
    const cfg = Object.fromEntries(Object.entries(SPACE).map(([k, v]) => [k, pick(v)]));
    if (cfg.minDistATR >= cfg.maxDistATR) continue;
    const key = JSON.stringify(cfg);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = L.simulate(data, levels(cfg.zoneMult), cfg);
    const train = L.slice(res, from, tTrain).stats;
    runs.push({ cfg, res, train, s: score(train) });
    if (onProgress && i % 50 === 0) onProgress(i, samples);
  }
  runs.sort((a, b) => b.s - a.s);
  const top = runs.slice(0, 20).map((r) => ({ ...r, val: L.slice(r.res, tTrain, tVal).stats }));
  top.sort((a, b) => score(b.val) - score(a.val) || b.s - a.s);
  const best = top[0];
  const baseline = L.simulate(data, levels(L.DEFAULTS.zoneMult), {});
  const summarize = (res) => ({
    full: res.stats,
    train: L.slice(res, from, tTrain).stats,
    validation: L.slice(res, tTrain, tVal).stats,
    test: L.slice(res, tVal, to).stats,
  });
  return {
    windows: { from, tTrain, tVal, to },
    samples: runs.length,
    best: { config: { ...L.DEFAULTS, ...best.cfg }, ...summarize(best.res), trades: best.res.trades, curve: best.res.curve },
    baseline: { config: L.DEFAULTS, ...summarize(baseline), curve: baseline.curve },
    top: top.slice(0, 10).map((r) => ({ cfg: r.cfg, train: r.train, val: r.val })),
    data,
    levels,
  };
}

module.exports = { optimize, SPACE };
