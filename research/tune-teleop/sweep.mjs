// Exploration helper for the teleop EPA component (not the selection tool: use epa-eval --grid for LOSO).
//   node research/tune-teleop/sweep.mjs configs.json
// configs.json = { "label": { "teleop": {...} }, ... }  ->  one summary row per config
import fs from "node:fs";
import { ctxs, EPA_SEASONS, epaRun, epaMetrics } from "../lib.mjs";

const cfgs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const all = await ctxs(EPA_SEASONS);
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.reduce((a, b) => a + b, 0) / v.length; };
console.log(`${"config".padEnd(40)} nMAE   ${EPA_SEASONS.map((s) => String(s).padStart(6)).join("")}   wMAE  wCorr  bias topBias rhoOPR rhoPO | 2025 tele rank 14270 11260 24033`);
for (const [label, over] of Object.entries(cfgs)) {
  const ms = [];
  let ranks = "";
  for (const ctx of all) {
    const run = await epaRun(ctx, over, ["teleop"]);
    ms.push(epaMetrics(ctx, run, "teleop"));
    if (ctx.season === 2025) {
      const list = [...run.endSeason.keys()].map((t) => [t, run.endSeason.get(t).teleop]).sort((a, b) => b[1] - a[1]);
      ranks = [14270, 11260, 24033].map((t) => { const i = list.findIndex((x) => x[0] === t); return i < 0 ? "  -" : String(i + 1).padStart(5); }).join(" ");
    }
  }
  const g = (k) => mean(ms.map((m) => m[k]));
  console.log(`${label.padEnd(40)} ${f(g("nMae"), 4)} ${ms.map((m) => f(m.nMae, 3).padStart(6)).join("")}  ${f(g("wMae"), 2).padStart(5)} ${f(g("wCorr"))} ${f(g("bias"), 2).padStart(5)} ${f(g("topBias"), 2).padStart(7)} ${f(g("rhoOpr"))} ${f(g("rhoPo"))} | (Worlds-team teleop rank) ${ranks}`);
}
