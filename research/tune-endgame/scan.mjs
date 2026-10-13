// One-at-a-time scan (exploration only; selection is done by epa-eval --grid LOSO).
//   node research/tune-endgame/scan.mjs base.json '{"initFrac":[0.3,0.6,1]}'
// Prints endgame nMAE per season (and mean, mean topBias, mean rhoOPR) for each value.
import fs from "node:fs";
import { ctxs, EPA_SEASONS, epaRun, epaMetrics } from "../lib.mjs";

const [baseFile, gridJson] = process.argv.slice(2);
const base = baseFile && baseFile !== "-" ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : {};
const grid = JSON.parse(gridJson);
const cs = await ctxs(EPA_SEASONS);
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
console.log(`base ${JSON.stringify(base)}`);
console.log("setting".padEnd(26) + EPA_SEASONS.map((s) => String(s).padStart(7)).join("") + "   mean  bias topBias  corr rhoOPR rhoPO");
for (const [k, vals] of Object.entries(grid)) for (const v of vals) {
  const over = structuredClone(base); (over.endgame ??= {})[k] = v;
  const ms = [];
  for (const ctx of cs) ms.push(epaMetrics(ctx, await epaRun(ctx, over, ["endgame"]), "endgame"));
  const mean = (key) => { const xs = ms.map((m) => m[key]).filter(Number.isFinite); return xs.reduce((a, b) => a + b, 0) / xs.length; };
  console.log(`${k}=${JSON.stringify(v)}`.padEnd(26) + ms.map((m) => f(m.nMae).padStart(7)).join("") + `  ${f(mean("nMae"), 4)} ${f(mean("bias"), 2).padStart(5)} ${f(mean("topBias"), 2).padStart(6)} ${f(mean("wCorr"))} ${f(mean("rhoOpr"))} ${f(mean("rhoPo"))}`);
}
