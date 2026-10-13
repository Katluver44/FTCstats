// Tries model variants across several seasons at once, so a change only
// "wins" if it helps on games it wasn't designed around.
//
//   node scripts/experiments.mjs

import { prepare, simulate, baselineOf } from "./build.mjs";

const TRAIN = [2022, 2023, 2024];
const TEST = 2025; // never used for tuning
const train = [];
for (const s of TRAIN) train.push(await prepare(s));
const test = [await prepare(TEST)];

const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);

function run(name, params = {}, { solo = true, ctxs = train } = {}) {
  let n = 0, c = 0, br = 0;
  const per = [];
  for (const ctx of ctxs) {
    const soloComps = solo ? ctx.soloComps : [];
    const baseline = solo ? ctx.baseline : baselineOf(ctx.matches, []);
    let sn = 0, sc = 0, sb = 0;
    simulate(ctx.matches, { params, baseline, priors: ctx.priors, cv: ctx.cv, soloComps, movedSpec: solo ? ctx.movedSpec : -1, parkedSpec: solo ? ctx.parkedSpec : -1, rookieZ: ctx.rookieZ }, (x, pre) => {
      const o = outcome(x);
      sn++; sb += (pre.pRed - o) ** 2;
      if (o !== 0.5 && (pre.pRed > 0.5) === (o === 1)) sc++;
    });
    n += sn; c += sc; br += sb;
    per.push(`${(sc / sn * 100).toFixed(1)}`);
  }
  console.log(`${name.padEnd(34)} acc ${(c / n * 100).toFixed(2)}%  brier ${(br / n).toFixed(4)}   [${per.join(" ")}]`);
  return br / n;
}

for (const deadShare of [1, 0.6, 0.4, 0.25]) run(`deadShare ${deadShare}`, { deadShare });
console.log("--- held-out", TEST);
for (const deadShare of [1, 0.6, 0.4]) run(`deadShare ${deadShare}`, { deadShare }, { ctxs: test });
