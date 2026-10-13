// One-knob-at-a-time exploration (in-sample, all seasons) for the auto EPA component.
// node research/tune-auto/scan.mjs '<base json for auto>' key v1,v2,...  [key2 v...]
import { ctxs, EPA_SEASONS, epaRun, epaMetrics } from "../lib.mjs";
const all = await ctxs(EPA_SEASONS);
const base = JSON.parse(process.argv[2] || "{}");
const args = process.argv.slice(3);
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
async function ev(auto) {
  const ms = [];
  for (const c of all) { const run = await epaRun(c, { auto }, ["auto"]); const m = epaMetrics(c, run, "auto"); delete m.pairs; ms.push(m); }
  const mean = (k) => { const v = ms.map((m) => m[k]).filter(Number.isFinite); return v.reduce((a, b) => a + b, 0) / v.length; };
  return { nMae: mean("nMae"), wMae: mean("wMae"), wCorr: mean("wCorr"), bias: mean("bias"), topBias: mean("topBias"), rhoOpr: mean("rhoOpr"), rhoPo: mean("rhoPo"), per: ms.map((m) => m.nMae) };
}
const pr = (lab, r) => console.log(`${lab.padEnd(34)} nMAE ${f(r.nMae, 4)} wMAE ${f(r.wMae)} wCorr ${f(r.wCorr)} bias ${f(r.bias, 2)} top ${f(r.topBias, 2)} rhoOPR ${f(r.rhoOpr)} rhoPO ${f(r.rhoPo)} | ${r.per.map((x) => f(x, 4)).join(" ")}`);
pr("base " + JSON.stringify(base), await ev(base));
for (let i = 0; i < args.length; i += 2) {
  const k = args[i];
  for (const v of args[i + 1].split(",").map(Number)) pr(`${k}=${v}`, await ev({ ...base, [k]: v }));
}
