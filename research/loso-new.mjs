// Leave-one-season-out check for NEW prediction-track options (off by default).
// For each held-out season: tune GRID on the other five seasons (coordinate
// descent from the defaults, new option off), then score defaults vs tuned on the
// held-out season, with paired event-bootstrap CIs for Brier and score MAE.
//   GRID='{"pairG":[0,0.1,0.2]}' node research/loso-new.mjs
//   BASE='{...}' sets fixed params for both sides (e.g. a change already kept).
//   CAND='{...}' sets fixed params for the tuned side only (e.g. switch the option on).
// Special key: offWeight (passed to simulate, not to the Model).
// Tried 2026-10-13 (mean over held-out seasons; none met "CI below zero in most seasons"):
//   alliance overlap feature (calPair 1, calPairWin 1): Brier 0.17288 -> 0.17254, MAE 21.56 -> 21.53,
//     CI < 0 in 3/6 -> in model.js, off.
//   fixed concave pair penalty (pairG): MAE -0.016 (CI < 0 in 5/6), Brier unchanged.
//   per-team partner residual: hurt at every weight, either sign.
//   elim win spread x0.8-1.25 / running elim score offset: no gain.
//   off-season results at weight 0.5 (offWeight): MAE -0.01 (CI < 0 in 5/6), Brier -0.00001 (0/6).
//   post-hoc Elo blend (5-10% in log-odds): in-sample best -0.00007, hurts 2022/2024.
import { ctxs } from "./lib.mjs";
import { simulate } from "../scripts/build.mjs";
const SEASONS = [2019, 2021, 2022, 2023, 2024, 2025];
const GRID = JSON.parse(process.env.GRID ?? "{}");
const BASE = JSON.parse(process.env.BASE ?? "{}");
const CAND = JSON.parse(process.env.CAND ?? "{}"); // fixed params for the candidate side only (e.g. turn the option on)
const all = await ctxs(SEASONS); const by = new Map(SEASONS.map((s, i) => [s, all[i]]));
const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
const cache = new Map();
function preds(params, season) {
  const key = season + JSON.stringify(params);
  if (cache.has(key)) return cache.get(key);
  const { offWeight = 0, ...p } = params;
  const out = [];
  simulate(by.get(season).matches, { ...by.get(season), params: p, offWeight }, (x, pre) => {
    const o = outcome(x);
    out.push({ ev: x.ev.code, elim: x.elim, b: (pre.pRed - o) ** 2, c: o !== 0.5 && (pre.pRed > 0.5) === (o === 1) ? 1 : 0, mae: (Math.abs(pre.red.np - x.actual.red.np) + Math.abs(pre.blue.np - x.actual.blue.np)) / 2 });
  });
  const sums = { n: out.length, b: out.reduce((s, q) => s + q.b, 0) };
  const r = { out, sums }; cache.set(key, r); return r;
}
const brier = (params, ss) => { let n = 0, b = 0; for (const s of ss) { const { sums } = preds(params, s); n += sums.n; b += sums.b; } return b / n; };
let rng = 7; const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
function boot(a, b, f) {
  const evs = [...new Set(a.map((p) => p.ev))]; const idx = new Map(evs.map((e) => [e, []])); a.forEach((p, i) => idx.get(p.ev).push(i));
  const diffs = [];
  for (let r = 0; r < 1000; r++) { let n = 0, d = 0; for (let k = 0; k < evs.length; k++) for (const i of idx.get(evs[Math.floor(rand() * evs.length)])) { n++; d += b[i][f] - a[i][f]; } diffs.push(d / n); }
  diffs.sort((x, y) => x - y); return [diffs[25], diffs[974]];
}
const m = (arr, f) => arr.reduce((s, p) => s + p[f], 0) / arr.length;
const rows = [];
for (const held of SEASONS) {
  const tr = SEASONS.filter((s) => s !== held);
  let best = { ...BASE, ...CAND }, bl = brier(best, tr);
  for (let pass = 0; pass < 2; pass++) for (const [k, vs] of Object.entries(GRID)) for (const v of vs) { const t = { ...best, [k]: v }; const l = brier(t, tr); if (l < bl - 1e-6) { best = t; bl = l; } }
  const a = preds(BASE, held).out, b = preds(best, held).out;
  const ci = boot(a, b, "b"), ciM = boot(a, b, "mae");
  const row = { held, brierOld: m(a, "b"), brierNew: m(b, "b"), ci, accOld: m(a, "c"), accNew: m(b, "c"), maeOld: m(a, "mae"), maeNew: m(b, "mae"), ciM, params: Object.fromEntries(Object.keys(GRID).map((k) => [k, best[k]])) };
  rows.push(row);
  console.log(`${held}  Brier ${row.brierOld.toFixed(5)} -> ${row.brierNew.toFixed(5)} [${ci.map((x) => x.toFixed(5)).join(", ")}]  acc ${(row.accOld * 100).toFixed(2)} -> ${(row.accNew * 100).toFixed(2)}  MAE ${row.maeOld.toFixed(3)} -> ${row.maeNew.toFixed(3)} [${ciM.map((x) => x.toFixed(3)).join(", ")}]  ${JSON.stringify(row.params)}`);
}
const mm = (f) => rows.reduce((s, r) => s + r[f], 0) / rows.length;
console.log(`mean  Brier ${mm("brierOld").toFixed(5)} -> ${mm("brierNew").toFixed(5)}  acc ${(mm("accOld") * 100).toFixed(2)} -> ${(mm("accNew") * 100).toFixed(2)}  MAE ${mm("maeOld").toFixed(3)} -> ${mm("maeNew").toFixed(3)}  Brier CI<0 in ${rows.filter((r) => r.ci[1] < 0).length}/6, better in ${rows.filter((r) => r.brierNew < r.brierOld).length}/6; MAE CI<0 in ${rows.filter((r) => r.ciM[1] < 0).length}/6`);
