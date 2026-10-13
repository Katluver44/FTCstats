// Total EPA: bias on the top 5% by PREDICTED EPA (not by target, which is selection-biased),
// overall bias, wCorr, rhoOPR, rhoPO per season, for each override given.
//   node research/tune-shared/topbias.mjs '<json>' ...
import { ctxs, EPA_SEASONS, epaRun, epaMetrics } from "../lib.mjs";
const overs = [{}, ...process.argv.slice(2).map((s) => JSON.parse(s))];
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
for (const c of await ctxs(EPA_SEASONS)) {
  for (const o of overs) {
    const m = epaMetrics(c, await epaRun(c, o), "total"), ps = m.pairs;
    const cut = ps.map((p) => p.pred).sort((a, b) => b - a)[Math.floor(ps.length * 0.05)];
    const top = ps.filter((p) => p.pred >= cut);
    console.log(`${c.season} ${JSON.stringify(o.shared ?? {}).padEnd(80)} nMAE ${f(m.nMae, 4)} bias ${f(m.bias)} top5%byEPA bias ${f(top.reduce((s, p) => s + p.err, 0) / top.length)} mae ${f(top.reduce((s, p) => s + Math.abs(p.err), 0) / top.length)} wCorr ${f(m.wCorr, 4)} rhoOPR ${f(m.rhoOpr, 3)} rhoPO ${f(m.rhoPo, 3)}`);
  }
}
