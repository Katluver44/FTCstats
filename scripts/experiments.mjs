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
// matches of the event) and the rest, and shown for elims alone; mae = mean
// |predicted - actual| alliance score (fouls excluded).
function run(name, params = {}, { solo = true, ctxs = train, quiet = false } = {}) {
  let n = 0, c = 0, br = 0, en = 0, eb = 0, mae = 0, xn = 0, xb = 0;
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
      if (o !== 0.5 && (pre.pRed > 0.5) === (o === 1)) sc++;
      mae += (Math.abs(pre.red.np - x.actual.red.np) + Math.abs(pre.blue.np - x.actual.blue.np)) / 2;
      if (x.elim) { xn++; xb += b; }
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
  if (!quiet) console.log(`${name.padEnd(34)} acc ${(c / n * 100).toFixed(2)}%  brier ${(br / n).toFixed(5)}  early ${(eb / en).toFixed(4)} rest ${((br - eb) / (n - en)).toFixed(4)} elim ${(xb / xn).toFixed(4)}  mae ${(mae / n).toFixed(2)}  [${per.join(" ")}]`);
  return br / n;
}

// Coordinate descent on TRAIN Brier only (never on the test season), from base.
function tune(base, grid, passes = 2) {
  let best = { ...base }, bestB = run("", best, { quiet: true });
  for (let pass = 0; pass < passes; pass++) {
    for (const [k, vals] of Object.entries(grid)) {
      for (const v of vals) {
        const trial = { ...best, [k]: v };
        const b = run("", trial, { quiet: true });
        if (b < bestB - 1e-6) { best = trial; bestB = b; }
      }
    }
  }
  console.log(`tuned on ${TRAIN.join("/")}: ${JSON.stringify(best)}  train brier ${bestB.toFixed(5)}`);
  return best;
}

// Candidate improvements from the 2026-10 research round, tuned on TRAIN only.
const ROBUST = { volK: 0.1, volThr: 0.5, clipC: 1.25, clipUp: 0, vMatch: 0.01 }; // volatility + shortfall clip
const WIN = { winSelf: 0.4, winFoul: 0.4, winVar: 0.02 }; // self-calibrating, foul- and uncertainty-aware spread
const variants = [
  ["current", {}], ["robust updates", ROBUST], ["win-prob spread", WIN], ["both", { ...ROBUST, ...WIN }],
  // event-local joint (full-covariance) Kalman update: partners' credit is revised
  // as later matches come in (MMSE OPR with each team's entering rating as prior)
  ["fullCov", { fullCov: 1 }], ["fullCov vObs 2.5", { fullCov: 1, vObs: 2.5 }], ["fullCov + jointWinVar", { fullCov: 1, jointWinVar: 1 }],
  ...process.argv.slice(2).map((a) => [a, JSON.parse(a)]),
];
// TUNE=1: re-tune the noise settings for fullCov (gains change once credit isn't
// double-counted). Slow: ~50 train runs per pass.
if (process.env.TUNE) {
  const FULLCOV_GRID = { vObs: [1.5, 2, 2.5, 3], v0: [0.3, 0.5, 0.7], vEvent: [0.1, 0.2, 0.3], vMatch: [0, 0.01, 0.03], winVar: [0, 0.02, 0.05] };
  variants.push(["current re-tuned (train, control)", tune({}, FULLCOV_GRID)]);
  variants.push(["fullCov tuned (train)", tune({ fullCov: 1 }, FULLCOV_GRID)]);
  variants.push(["fullCov+jointWinVar tuned (train)", tune({ fullCov: 1, jointWinVar: 1 }, FULLCOV_GRID)]);
}
for (const [name, p] of variants) run(name, p);
console.log("--- held-out", TEST);
for (const [name, p] of variants) run(name, p, { ctxs: test });
