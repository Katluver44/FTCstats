// Bias on the top 5% of pairs selected by PREDICTED endgame EPA (not by target),
// so regression to the mean doesn't make a perfect predictor look underrated.
//   node research/tune-endgame/topbias.mjs a.json b.json ...   ("-" = defaults)
import fs from "node:fs";
import { ctxs, EPA_SEASONS, epaRun, epaPairs } from "../lib.mjs";
const cs = await ctxs(EPA_SEASONS);
for (const file of process.argv.slice(2)) {
  const over = file === "-" ? {} : JSON.parse(fs.readFileSync(file, "utf8"));
  const out = [];
  for (const ctx of cs) {
    const ps = epaPairs(ctx, await epaRun(ctx, over, ["endgame"]), "endgame").sort((a, b) => b.pred - a.pred);
    const top = ps.slice(0, Math.ceil(ps.length * 0.05));
    out.push(`${ctx.season} ${(top.reduce((s, p) => s + p.err, 0) / top.length).toFixed(2)}`);
  }
  console.log(`${file.padEnd(40)} topBias(by EPA): ${out.join("  ")}`);
}
