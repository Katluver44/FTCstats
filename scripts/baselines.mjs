// Simple rating baselines EPA is compared against (see About page):
// Elo on wins/losses only, and each team's average alliance score so far.

const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);

// 2v2 Elo: alliance rating = mean of its teams; K tuned per season below
export function elo(matches, K, scale = 400) {
  const r = new Map(), out = new Map();
  const get = (t) => r.get(t) ?? 1500;
  for (const x of matches) {
    const ra = x.red.reduce((s, t) => s + get(t), 0) / x.red.length;
    const rb = x.blue.reduce((s, t) => s + get(t), 0) / x.blue.length;
    const p = 1 / (1 + 10 ** ((rb - ra) / scale));
    out.set(x, p);
    const d = K * (outcome(x) - p);
    for (const t of x.red) r.set(t, get(t) + d);
    for (const t of x.blue) r.set(t, get(t) - d);
  }
  return out;
}

// each team's average alliance score so far this season
export function avgScore(matches, scale) {
  const sum = new Map(), cnt = new Map(), out = new Map();
  let league = 100;
  const avg = (t) => (cnt.get(t) ? sum.get(t) / cnt.get(t) : league);
  for (const x of matches) {
    const a = x.red.reduce((s, t) => s + avg(t), 0) / x.red.length, b = x.blue.reduce((s, t) => s + avg(t), 0) / x.blue.length;
    out.set(x, 1 / (1 + Math.exp(-(a - b) / (scale * league))));
    for (const [nums, side] of [[x.red, "red"], [x.blue, "blue"]]) {
      for (const t of nums) { sum.set(t, (sum.get(t) ?? 0) + x.actual[side].np); cnt.set(t, (cnt.get(t) ?? 0) + 1); }
    }
    league += 0.003 * ((x.actual.red.np + x.actual.blue.np) / 2 - league);
  }
  return out;
}

