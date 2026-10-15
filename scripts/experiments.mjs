// Tries model variants across several seasons at once, so a change only
// "wins" if it helps on games it wasn't designed around.
//
//   node scripts/experiments.mjs ['{"param":value}' ...]
//   PRIOR='{"nWeight":1,"n0":15}' node scripts/experiments.mjs   # starting-rating
//     settings (build.mjs PRIOR_OPTS overrides) for every variant

import { prepare, simulate, baselineOf } from "./build.mjs";

const TRAIN = [2022, 2023, 2024];
const TEST = 2025; // never used for tuning
const PRIOR = process.env.PRIOR ? JSON.parse(process.env.PRIOR) : undefined;
if (PRIOR) console.log("priors:", JSON.stringify(PRIOR));
const train = [];
for (const s of TRAIN) train.push(await prepare(s, undefined, PRIOR));
const test = [await prepare(TEST, undefined, PRIOR)];

const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);

// Brier is also split into "early" matches (some team is in its first 3
// matches of the event) and the rest.
function run(name, params = {}, { solo = true, ctxs = train } = {}) {
  let n = 0, c = 0, br = 0, en = 0, eb = 0;
  const per = [];
  for (const ctx of ctxs) {
    const soloComps = solo ? ctx.soloComps : [];
    const baseline = solo ? ctx.baseline : baselineOf(ctx.matches, []);
    const seen = new Map(); // "event/team" -> matches played there so far
    let sn = 0, sc = 0, sb = 0;
    simulate(ctx.matches, { params, baseline, priors: ctx.priors, cv: ctx.cv, soloComps, movedSpec: solo ? ctx.movedSpec : -1, parkedSpec: solo ? ctx.parkedSpec : -1, rookieZ: ctx.rookieZ, priorRel: ctx.priorRel }, (x, pre) => {
      const o = outcome(x);
      const b = (pre.pRed - o) ** 2;
      sn++; sb += b;
      if (o !== 0.5 && (pre.pRed > 0.5) === (o === 1)) sc++;
      let early = false;
      for (const t of [...x.red, ...x.blue]) {
        const k = `${x.ev.code}/${t}`, m = seen.get(k) ?? 0;
        if (m < 3) early = true;
        seen.set(k, m + 1);
      }
      if (early) { en++; eb += b; }
    });
    n += sn; c += sc; br += sb;
    per.push(`${(sc / sn * 100).toFixed(1)}`);
  }
  console.log(`${name.padEnd(34)} acc ${(c / n * 100).toFixed(2)}%  brier ${(br / n).toFixed(5)}  early ${(eb / en).toFixed(4)} rest ${((br - eb) / (n - en)).toFixed(4)}  [${per.join(" ")}]`);
  return br / n;
}

// Candidate improvements from the 2026-10 research round, tuned on TRAIN only.
const ROBUST = { volK: 0.1, volThr: 0.5, clipC: 1.25, clipUp: 0, vMatch: 0.01 }; // volatility + shortfall clip
const WIN = { winSelf: 0.4, winFoul: 0.4, winVar: 0.02 }; // self-calibrating, foul- and uncertainty-aware spread
const variants = [
  ["current", {}], ["robust updates", ROBUST], ["win-prob spread", WIN], ["both", { ...ROBUST, ...WIN }],
  // reliability-dependent starting variance (thin prior histories learn faster);
  // pairs with PRIOR='{"nWeight":1,...}' (Marcel priors). Grid: research/marcel-grid.mjs
  ["v0Rel 1", { v0Rel: 1 }], ["v0Rel 2", { v0Rel: 2 }],
  ...process.argv.slice(2).map((a) => [a, JSON.parse(a)]),
];
for (const [name, p] of variants) run(name, p);
console.log("--- held-out", TEST);
for (const [name, p] of variants) run(name, p, { ctxs: test });
