// Paired event-bootstrap CI between two auto overrides: node research/tune-auto/pair.mjs a.json b.json
import fs from "node:fs";
import { ctxs, EPA_SEASONS, epaRun, epaMetrics, bootstrapMaeDiff } from "../lib.mjs";
const [a, b] = process.argv.slice(2, 4).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
for (const c of await ctxs(EPA_SEASONS)) {
  const ma = epaMetrics(c, await epaRun(c, a, ["auto"]), "auto"), mb = epaMetrics(c, await epaRun(c, b, ["auto"]), "auto");
  const ci = bootstrapMaeDiff(ma.pairs, mb.pairs, 1000);
  console.log(`${c.season} wMAE ${f(ma.wMae)} -> ${f(mb.wMae)} CI ${f(ci[0])}..${f(ci[1])} topBias ${f(ma.topBias, 2)} -> ${f(mb.topBias, 2)} rhoOPR ${f(ma.rhoOpr)} -> ${f(mb.rhoOpr)} rhoPO ${f(ma.rhoPo)} -> ${f(mb.rhoPo)}`);
}
