// Is EPA the best rating to predict with? Compares, on the same matches, every
// prediction made before the match: EPA (this site), OPR (what FTCScout shows),
// Elo (wins/losses only, like chess), and average alliance score.
//   node scripts/metrics.mjs 2024 2025
import { prepare, simulate } from "./build.mjs";
import { oprPredictions } from "./opr.mjs";

const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
const grade = (matches, p) => {
  let n = 0, c = 0, b = 0;
  for (const x of matches) {
    const q = p.get(x), o = outcome(x);
    n++; b += (q - o) ** 2;
    if (o !== 0.5 && (q > 0.5) === (o === 1)) c++;
  }
  return `${(c / n * 100).toFixed(1)}% / ${(b / n).toFixed(4)}`;
};

// 2v2 Elo: alliance rating = mean of its teams; K tuned per season below
function elo(matches, K, scale = 400) {
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
function avgScore(matches, scale) {
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

for (const season of process.argv.slice(2).map(Number)) {
  const ctx = await prepare(season);
  const { matches } = ctx;
  const epa = new Map();
  simulate(matches, ctx, (x, pre) => epa.set(x, pre.pRed));
  const opr = new Map([...oprPredictions(matches, { winScale: 0.28, baselineTeam: (ctx.baseline.auto + ctx.baseline.teleop + ctx.baseline.endgame) / 2 })].map(([k, v]) => [k, v.pRed]));
  const bestElo = [16, 24, 32, 48, 64].map((K) => [K, elo(matches, K)]).map(([K, p]) => [K, grade(matches, p)]).sort((a, b) => parseFloat(a[1].split("/ ")[1]) - parseFloat(b[1].split("/ ")[1]))[0];
  const bestAvg = [0.2, 0.28, 0.36].map((s) => grade(matches, avgScore(matches, s))).sort((a, b) => parseFloat(a.split("/ ")[1]) - parseFloat(b.split("/ ")[1]))[0];
  console.log(`${season}  (winner correct / Brier, lower Brier is better)`);
  console.log(`  EPA (this site)        ${grade(matches, epa)}`);
  console.log(`  OPR, updated live      ${grade(matches, opr)}`);
  console.log(`  Elo (best K=${bestElo[0]})        ${bestElo[1]}`);
  console.log(`  Average score so far   ${bestAvg}`);
}
