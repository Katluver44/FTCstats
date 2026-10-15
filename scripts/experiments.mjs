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
  const per = [], bExp = [];
  for (const ctx of ctxs) {
    const soloComps = solo ? ctx.soloComps : [];
    const baseline = solo ? ctx.baseline : baselineOf(ctx.matches, []);
    const seen = new Map(); // "event/team" -> matches played there so far
    let sn = 0, sc = 0, sb = 0;
    const { model } = simulate(ctx.matches, { params, baseline, priors: ctx.priors, cv: ctx.cv, soloComps, movedSpec: solo ? ctx.movedSpec : -1, parkedSpec: solo ? ctx.parkedSpec : -1, rookieZ: ctx.rookieZ }, (x, pre) => {
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
    // calExp: fitted experience coefficients at season end (sign stability across seasons is the test)
    if (params.calExp && model.p.cal) { const i = 3 + (model.p.calPair ? 1 : 0); bExp.push(`${ctx.season ?? "?"}:${model.cal.b[i].toFixed(3)}/${model.cal.b[i + 1].toFixed(3)}`); }
  }
  if (!quiet) console.log(`${name.padEnd(34)} acc ${(c / n * 100).toFixed(2)}%  brier ${(br / n).toFixed(5)}  early ${(eb / en).toFixed(4)} rest ${((br - eb) / (n - en)).toFixed(4)}  mae ${(mae / n).toFixed(2)}  [${per.join(" ")}]${bExp.length ? `  b_e1/b_e2 ${bExp.join(" ")}` : ""}`);
  return br / n;
}

// Candidate improvements from the 2026-10 research round, tuned on TRAIN only.
const ROBUST = { volK: 0.1, volThr: 0.5, clipC: 1.25, clipUp: 0, vMatch: 0.01 }; // volatility + shortfall clip
const WIN = { winSelf: 0.4, winFoul: 0.4, winVar: 0.02 }; // self-calibrating, foul- and uncertainty-aware spread
// Within-event experience features in the recalibration (calExp, off by default).
// EXP_GRID=1 also tunes calExpWin x calAlpha on TRAIN only and scores the pick on TEST.
const EXP = [["calExp", { calExp: 1 }], ["calExp + win", { calExp: 1, calExpWin: 1 }], ["calExp + win .5", { calExp: 1, calExpWin: 0.5 }]];
if (process.env.EXP_GRID) {
  let best = null;
  for (const calExpWin of [0, 0.5, 1]) for (const calAlpha of [0.001, 0.002, 0.004]) {
    const p = { calExp: 1, calExpWin, calAlpha }, b = run(`grid ${JSON.stringify(p)}`, p);
    if (!best || b < best[1]) best = [p, b];
  }
  EXP.push([`calExp train-best ${JSON.stringify(best[0])}`, best[0]]);
}
const variants = [
  ["current", {}], ["robust updates", ROBUST], ["win-prob spread", WIN], ["both", { ...ROBUST, ...WIN }], ...EXP,
  ...process.argv.slice(2).map((a) => [a, JSON.parse(a)]),
];
for (const [name, p] of variants) run(name, p);
console.log("--- held-out", TEST);
for (const [name, p] of variants) run(name, p, { ctxs: test });
