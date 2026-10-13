// Prototype (runtime monkeypatch, no source edits): let each team's auto rating
// follow league-wide growth. When the season-average auto score has moved from
// A_then (last time the team was touched) to A_now, the team's shared auto
// rating is scaled by (A_now / A_then)^g. g = 0 is the current model.
// node research/tune-auto/growth.mjs '<auto override json>' g1,g2,...
import { Model } from "../../site/js/model.js";
import { ctxs, EPA_SEASONS, epaRun, epaMetrics, bootstrapMaeDiff } from "../lib.mjs";
let G = 0;
const origTeam = Model.prototype.team;
Model.prototype.team = function (num) {
  const t = origTeam.call(this, num);
  if (G) {
    const a = this.avg.auto + this.avg.solo.reduce((s, x, j) => s + (this.soloComps[j] === "auto" ? x : 0), 0);
    if (t.aRef && a > 0) { const r = (a / t.aRef) ** G; t.auto *= r; t.solo = t.solo.map((s, j) => (this.soloComps[j] === "auto" ? s * r : s)); }
    t.aRef = a;
  }
  return t;
};
const all = await ctxs(EPA_SEASONS);
const auto = JSON.parse(process.argv[2] || "{}");
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const res = async (g) => { G = g; const out = []; for (const c of all) { const m = epaMetrics(c, await epaRun(c, { auto }, ["auto"]), "auto"); out.push(m); } return out; };
const base = await res(0);
for (const g of (process.argv[3] || "0.5,1").split(",").map(Number)) {
  const ms = await res(g);
  console.log(`g=${g}`);
  ms.forEach((m, i) => { const ci = bootstrapMaeDiff(base[i].pairs, m.pairs, 500); console.log(`  ${all[i].season} nMAE ${f(base[i].nMae, 4)} -> ${f(m.nMae, 4)} CI ${f(ci[0])}..${f(ci[1])} bias ${f(base[i].bias, 2)} -> ${f(m.bias, 2)} top ${f(base[i].topBias, 2)} -> ${f(m.topBias, 2)} rhoOPR ${f(base[i].rhoOpr)} -> ${f(m.rhoOpr)} rhoPO ${f(base[i].rhoPo)} -> ${f(m.rhoPo)}`); });
  const mean = (a, k) => a.map((m) => m[k]).filter(Number.isFinite).reduce((s, x, _, v) => s + x / v.length, 0);
  console.log(`  mean nMAE ${f(mean(base, "nMae"), 4)} -> ${f(mean(ms, "nMae"), 4)}  bias ${f(mean(base, "bias"), 2)} -> ${f(mean(ms, "bias"), 2)}  top ${f(mean(base, "topBias"), 2)} -> ${f(mean(ms, "topBias"), 2)}`);
}
