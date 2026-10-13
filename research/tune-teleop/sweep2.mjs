// Like sweep.mjs, plus: top-5% bias selected by PREDICTED EPA (no regression-to-mean artefact),
// and rhoDiv = Spearman of end-of-season teleop EPA vs Worlds DIVISION teleop OPR (the eval's
// worlds map is overwritten by the 12-team Worlds finals event for finalists).
//   node research/tune-teleop/sweep2.mjs configs.json
import fs from "node:fs";
import { ctxs, EPA_SEASONS, epaRun, epaMetrics, epaTargets, spearman } from "../lib.mjs";
const cfgs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const all = await ctxs(EPA_SEASONS);
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.reduce((a, b) => a + b, 0) / v.length; };
const divOf = (ctx) => {
  const cmp = epaTargets(ctx).events.filter((e) => e.type === "FIRSTChampionship").sort((a, b) => a.pairs.length - b.pairs.length);
  const d = new Map(); for (const e of cmp) for (const p of e.pairs) d.set(p.team, p.teleop); return d;
};
console.log(`${"config".padEnd(28)}  nMAE  wMAE  bias topT  topP  rhoOPR rhoDiv rhoPO | per-season topP / rhoDiv | 2025 div-team rank 14270 11260 19564`);
for (const [label, over] of Object.entries(cfgs)) {
  const rows = []; let ranks = "";
  for (const ctx of all) {
    const run = await epaRun(ctx, over, ["teleop"]);
    const m = epaMetrics(ctx, run, "teleop"), ps = m.pairs;
    const cutP = ps.map((p) => p.pred).sort((a, b) => b - a)[Math.floor(ps.length * 0.05)];
    const tp = ps.filter((p) => p.pred >= cutP); m.topP = tp.reduce((s, p) => s + p.err, 0) / tp.length;
    const div = divOf(ctx), ts = [...div.keys()].filter((t) => run.endSeason.has(t));
    m.rhoDiv = ts.length > 2 ? spearman(ts.map((t) => run.endSeason.get(t).teleop), ts.map((t) => div.get(t))) : NaN;
    rows.push(m);
    if (ctx.season === 2025) {
      const list = ts.map((t) => [t, run.endSeason.get(t).teleop]).sort((a, b) => b[1] - a[1]);
      ranks = [14270, 11260, 19564].map((t) => String(list.findIndex((x) => x[0] === t) + 1).padStart(5)).join(" ");
    }
  }
  const g = (k) => mean(rows.map((m) => m[k]));
  console.log(`${label.padEnd(28)} ${f(g("nMae"), 4)} ${f(g("wMae"), 2)} ${f(g("bias"), 2)} ${f(g("topBias"), 1)} ${f(g("topP"), 2).padStart(5)} ${f(g("rhoOpr"))} ${f(g("rhoDiv"))} ${f(g("rhoPo"))} | ${rows.map((m) => f(m.topP, 1)).join(" ")} / ${rows.slice(1).map((m) => f(m.rhoDiv)).join(" ")} | ${ranks}`);
}
