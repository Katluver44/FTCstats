// Where does priorRookieZ help? Bias / MAE of pre-event total EPA, split by
// (has prior | no prior) x (team's 1st, 2nd, 3rd+ official event of the season).
//   node research/tune-shared/rookie-diag.mjs '<json override>' ...
import { ctxs, EPA_SEASONS, epaRun, epaPairs } from "../lib.mjs";
import { loadEpaPriors } from "../../scripts/build.mjs";
import { epaParams } from "../../site/js/model.js";
const overs = process.argv.slice(2).map((s) => JSON.parse(s));
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
for (const ctx of await ctxs(EPA_SEASONS.filter((s) => s !== 2019))) {
  console.log(`\n=== ${ctx.season}`);
  for (const over of [{}, ...overs]) {
    const { priors } = await loadEpaPriors(ctx.season, epaParams(over));
    const run = await epaRun(ctx, over);
    const ps = epaPairs(ctx, run, "total");
    const order = new Map(); // team -> event codes in order seen
    const evIdx = new Map(ctx.matches.map((x, i) => [x.ev.code, i]).reverse());
    const sorted = [...ps].sort((a, b) => evIdx.get(a.ev) - evIdx.get(b.ev));
    const g = {};
    for (const p of sorted) {
      const k = (order.get(p.team) ?? 0) + 1; order.set(p.team, k);
      const key = `${priors.has(p.team) ? "vet" : "new"}-${k >= 3 ? "3+" : k}`;
      (g[key] ??= []).push(p);
    }
    const cell = (k) => { const l = g[k] ?? []; const W = l.reduce((s, p) => s + p.w, 0); return `${k} n${String(l.length).padStart(5)} bias ${f(l.reduce((s, p) => s + p.w * p.err, 0) / W).padStart(6)} mae ${f(l.reduce((s, p) => s + p.w * Math.abs(p.err), 0) / W).padStart(5)}`; };
    console.log(`${JSON.stringify(over.shared ?? {}).padEnd(60)}\n   ${["new-1", "new-2", "new-3+"].map(cell).join(" | ")}\n   ${["vet-1", "vet-2", "vet-3+"].map(cell).join(" | ")}`);
  }
}
