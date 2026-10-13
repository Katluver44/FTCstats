// Is EPA the best rating to predict with? Compares, on the same matches, every
// prediction made before the match: EPA (this site), OPR (what FTCScout shows),
// Elo (wins/losses only, like chess), and average alliance score.
//   node scripts/metrics.mjs 2024 2025
import { prepare, simulate } from "./build.mjs";
import { oprPredictions } from "./opr.mjs";
import { elo, avgScore } from "./baselines.mjs";

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
