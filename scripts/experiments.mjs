// Tries model variants across several seasons at once, so a change only
// "wins" if it helps on games it wasn't designed around.
//
//   node scripts/experiments.mjs ['{"param":value}' ...]

import { prepare, simulate, baselineOf } from "./build.mjs";

const TRAIN = [2022, 2023, 2024];
const TEST = 2025; // never used for tuning
const train = [];
for (const s of TRAIN) train.push(await prepare(s));
const test = [await prepare(TEST)];

const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);

// Brier is also split into "early" matches (some team is in its first 3
// matches of the event) and the rest.
function run(name, params = {}, { solo = true, ctxs = train, quiet = false } = {}) {
  let n = 0, c = 0, br = 0, en = 0, eb = 0, mae = 0;
  const per = [];
  for (const ctx of ctxs) {
    const soloComps = solo ? ctx.soloComps : [];
    const baseline = solo ? ctx.baseline : baselineOf(ctx.matches, []);
    const seen = new Map(); // "event/team" -> matches played there so far
    let sn = 0, sc = 0, sb = 0;
    simulate(ctx.matches, { params, baseline, priors: ctx.priors, cv: ctx.cv, soloComps, movedSpec: solo ? ctx.movedSpec : -1, parkedSpec: solo ? ctx.parkedSpec : -1, rookieZ: ctx.rookieZ }, (x, pre) => {
      const o = outcome(x);
      const b = (pre.pRed - o) ** 2;
      sn++; sb += b;
      mae += (Math.abs(pre.red.np - x.actual.red.np) + Math.abs(pre.blue.np - x.actual.blue.np)) / 2;
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
  if (!quiet) console.log(`${name.padEnd(34)} acc ${(c / n * 100).toFixed(2)}%  brier ${(br / n).toFixed(5)}  early ${(eb / en).toFixed(4)} rest ${((br - eb) / (n - en)).toFixed(4)}  mae ${(mae / n).toFixed(2)}  [${per.join(" ")}]`);
  return br / n;
}

// Candidate improvements from the 2026-10 research round, tuned on TRAIN only.
const ROBUST = { volK: 0.1, volThr: 0.5, clipC: 1.25, clipUp: 0, vMatch: 0.01 }; // volatility + shortfall clip
const WIN = { winSelf: 0.4, winFoul: 0.4, winVar: 0.02 }; // self-calibrating, foul- and uncertainty-aware spread
// Per-component Kalman variances (compVar) and prior carry, seeded from the
// EPA track's per-component ratios (teleop vObs 3/2, endgame vObs 5/2, endgame carry 0.3).
const COMPVAR = { compVar: 1, vObsT: 1.5, vObsE: 2.5 };
const variants = [
  ["current", {}], ["robust updates", ROBUST], ["win-prob spread", WIN], ["both", { ...ROBUST, ...WIN }],
  ["compVar EPA ratios", COMPVAR], ["carryE .3", { carryE: 0.3 }], ["compVar + carryE", { ...COMPVAR, carryE: 0.3 }],
  ...process.argv.slice(2).map((a) => [a, JSON.parse(a)]),
];

// Coordinate descent on TRAIN seasons only (never on TEST). Opt in: TUNE=compvar.
function tune(start, grid) {
  let best = { ...start }, bl = run("", best, { quiet: true });
  for (let pass = 0; pass < 2; pass++) for (const [k, vs] of Object.entries(grid)) for (const v of vs) {
    const t = { ...best, [k]: v }, l = run("", t, { quiet: true });
    if (l < bl - 1e-6) { best = t; bl = l; }
  }
  return best;
}
if (process.env.TUNE === "compvar") {
  const best = tune({ compVar: 1 }, { vObsA: [0.7, 1, 1.5], vObsT: [1, 1.5, 2], vObsE: [1, 2, 3], vMatchT: [1, 4, 8], vEventT: [0, 0.5, 1], carryE: [0.3, 0.6, 1], carryA: [0.7, 1] });
  variants.push([`compVar tuned ${JSON.stringify(best)}`, best]);
}
for (const [name, p] of variants) run(name, p);
console.log("--- held-out", TEST);
for (const [name, p] of variants) run(name, p, { ctxs: test });
