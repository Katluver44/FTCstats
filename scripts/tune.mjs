// Coordinate-descent search over model params. Tunes on the first 70% of the
// season (by time) and reports the held-out last 30%, so the published
// accuracy isn't just overfitting.
//
//   node scripts/tune.mjs 2025

import { prepare, simulate, summarize } from "./build.mjs";
import { DEFAULT_PARAMS } from "../site/js/model.js";

const season = Number(process.argv[2] ?? 2025);
const { matches, baseline, priors, cv, soloComps } = await prepare(season);
const cut = Math.floor(matches.length * 0.7);
const train = matches.slice(0, cut);

// Loss = win-prob Brier + score error (scaled) so both get tuned.
const loss = (params, ms) => {
  const s = summarize(simulate(ms, { params, baseline, priors, cv, soloComps }).acc).all;
  return s.brier + s.scoreMae / 1000;
};

const grid = {
  kStart: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  kEnd: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4],
  kRampEnd: [10, 14, 18, 25, 35],
  elimWeight: [0.2, 0.4, 0.6, 0.8, 1],
  initFrac: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  winScale: [0.22, 0.25, 0.28, 0.31, 0.34, 0.38, 0.42],
  emaAlpha: [0.0005, 0.001, 0.002, 0.003, 0.005],
  kRp: [0.15, 0.25, 0.35, 0.45],
  kFoul: [0, 0.02, 0.05],
  ...(priors.size ? { carry: [0, 0.3, 0.6, 0.9, 1.2, 1.6], initFrac: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9] } : {}),
};

let best = { ...DEFAULT_PARAMS };
let bestLoss = loss(best, train);
console.log("start", bestLoss.toFixed(4));
for (let pass = 0; pass < 2; pass++) {
  for (const [key, vals] of Object.entries(grid)) {
    for (const v of vals) {
      const trial = { ...best, [key]: v };
      const l = loss(trial, train);
      if (l < bestLoss - 1e-5) { best = trial; bestLoss = l; }
    }
    console.log(`pass ${pass} ${key}=${best[key]}  loss ${bestLoss.toFixed(4)}`);
  }
}

const evalHoldout = (params) => {
  // run the full season so held-out matches start from realistic ratings,
  // but only score the last 30%
  let i = 0;
  const g = { n: 0, correct: 0, brier: 0, mae: 0 };
  simulate(matches, { params, baseline, priors, cv, soloComps }, (x, pre) => {
    if (i++ < cut) return;
    const o = x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0;
    g.n++;
    if (o !== 0.5 && (pre.pRed > 0.5) === (o === 1)) g.correct++;
    g.brier += (pre.pRed - o) ** 2;
    g.mae += (Math.abs(pre.red.np - x.actual.red.np) + Math.abs(pre.blue.np - x.actual.blue.np)) / 2;
  });
  return { accuracy: (g.correct / g.n).toFixed(3), brier: (g.brier / g.n).toFixed(4), mae: (g.mae / g.n).toFixed(1) };
};
console.log("holdout default:", evalHoldout(DEFAULT_PARAMS));
console.log("holdout tuned:  ", evalHoldout(best));
console.log(JSON.stringify(best));
