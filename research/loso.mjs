// Leave-one-season-out CV: for each season, tune the new params on the other seasons only,
// then score current vs new on the held-out season with a paired bootstrap over events.
import { ctxs } from "./lib.mjs";
import { simulate } from "../scripts/build.mjs";
const SEASONS = [2019, 2021, 2022, 2023, 2024, 2025];
const all = await ctxs(SEASONS); const by = new Map(SEASONS.map((s, i) => [s, all[i]]));
const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
function preds(params, ctx) { const out = []; simulate(ctx.matches, { ...ctx, params }, (x, pre) => out.push({ ev: x.ev.code, b: (pre.pRed - outcome(x)) ** 2, c: outcome(x) !== 0.5 && (pre.pRed > 0.5) === (outcome(x) === 1) ? 1 : 0, mae: (Math.abs(pre.red.np - x.actual.red.np) + Math.abs(pre.blue.np - x.actual.blue.np)) / 2 })); return out; }
const brier = (params, cs) => { let n = 0, b = 0; for (const c of cs) for (const p of preds(params, c)) { n++; b += p.b; } return b / n; };
const START = { winHet: 0.7, winSelf: 0.34, winFoul: 0.2, cal: 1, mom: -0.2, obsHet: 0.75, vObs: 2, v0: 0.5 };
const GRID = { winHet: [0.4, 0.7, 1], mom: [0, -0.1, -0.2, -0.3], obsHet: [0, 0.5, 0.75, 1], vObs: [1.5, 2, 2.5], winSelf: [0.31, 0.34, 0.37, 0.4] };
let rng = 7; const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const rows = [];
for (const held of SEASONS) {
  const tr = SEASONS.filter((s) => s !== held).map((s) => by.get(s));
  let best = { ...START }, bl = brier(best, tr);
  for (let pass = 0; pass < 2; pass++) for (const [k, vs] of Object.entries(GRID)) for (const v of vs) { const t = { ...best, [k]: v }; const l = brier(t, tr); if (l < bl - 1e-6) { best = t; bl = l; } }
  const a = preds({}, by.get(held)), b = preds(best, by.get(held));
  // paired bootstrap over events (matches within an event are correlated)
  const evs = [...new Set(a.map((p) => p.ev))]; const idx = new Map(evs.map((e) => [e, []])); a.forEach((p, i) => idx.get(p.ev).push(i));
  const diffs = [];
  for (let r = 0; r < 1000; r++) { let n = 0, d = 0; for (let k = 0; k < evs.length; k++) { for (const i of idx.get(evs[Math.floor(rand() * evs.length)])) { n++; d += b[i].b - a[i].b; } } diffs.push(d / n); }
  diffs.sort((x, y) => x - y);
  const m = (arr, f) => arr.reduce((s, p) => s + p[f], 0) / arr.length;
  const row = { held, n: a.length, brierOld: m(a, "b"), brierNew: m(b, "b"), ci: [diffs[25], diffs[974]], accOld: m(a, "c"), accNew: m(b, "c"), maeOld: m(a, "mae"), maeNew: m(b, "mae"), params: Object.fromEntries(Object.keys(GRID).map((k) => [k, best[k]])) };
  rows.push(row);
  console.log(`${held} n=${row.n}  Brier ${row.brierOld.toFixed(5)} -> ${row.brierNew.toFixed(5)} (diff 95% CI ${row.ci.map((x) => x.toFixed(5)).join("..")})  acc ${(row.accOld * 100).toFixed(2)} -> ${(row.accNew * 100).toFixed(2)}  MAE ${row.maeOld.toFixed(2)} -> ${row.maeNew.toFixed(2)}  tuned ${JSON.stringify(row.params)}`);
}
console.log(JSON.stringify(rows));
