// EPA vs OPR on the same matches, each with its best win-probability spread.
//   node scripts/compare.mjs 2025
import { loadSeason, playedMatches, baselineOf, loadPriors, simulate } from "./build.mjs";
import { oprPredictions } from "./opr.mjs";

const season = Number(process.argv[2] ?? 2025);
const matches = playedMatches(season, await loadSeason(season));
const baseline = baselineOf(matches);
const { priors, cv } = await loadPriors(season);

const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
const grade = (preds) => {
  let n = 0, c = 0, br = 0;
  for (const x of matches) {
    const p = preds.get(x), o = outcome(x);
    n++; br += (p - o) ** 2;
    if (o !== 0.5 && (p > 0.5) === (o === 1)) c++;
  }
  return { accuracy: +(c / n).toFixed(4), brier: +(br / n).toFixed(4) };
};

const epa = new Map();
simulate(matches, { baseline, priors, cv }, (x, pre) => epa.set(x, pre.pRed));
console.log("EPA", grade(epa));
const bt = (baseline.auto + baseline.teleop + baseline.endgame) / 2;
for (const ws of [0.2, 0.28, 0.36, 0.45]) {
  const o = oprPredictions(matches, { winScale: ws, baselineTeam: bt });
  console.log("OPR ws", ws, grade(new Map([...o].map(([k, v]) => [k, v.pRed]))));
}

for (const params of [{ margin: 0.1 }, { margin: 0.2 }, { margin: 0.35 }, { matchScale: 0.5 }, { matchScale: 1 }, { matchScale: 1, winScale: 0.22 }, { matchScale: 1, winScale: 0.34 }]) {
  const e = new Map();
  simulate(matches, { baseline, priors, cv, params }, (x, pre) => e.set(x, pre.pRed));
  console.log("EPA", JSON.stringify(params), grade(e));
}
// blend EPA and OPR in log-odds space
const opr = oprPredictions(matches, { winScale: 0.28, baselineTeam: bt });
const logit = (p) => Math.log(p / (1 - p)), sig = (z) => 1 / (1 + Math.exp(-z));
for (const w of [0.5, 0.65, 0.8]) {
  console.log("blend w", w, grade(new Map(matches.map((x) => [x, sig(w * logit(epa.get(x)) + (1 - w) * logit(opr.get(x).pRed))]))));
}
