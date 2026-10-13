// Per-event teleop trace for a few 2025 teams: pre-event EPA vs event teleop OPR.
//   node research/tune-teleop/team.mjs '{"teleop":{"mom":0}}' 11260 14270
import { ctxs, epaRun, epaTargets } from "../lib.mjs";
const over = JSON.parse(process.argv[2] ?? "{}");
const teams = process.argv.slice(3).map(Number);
const [ctx] = await ctxs([2025]);
const run = await epaRun(ctx, over, ["teleop"]);
const { events } = epaTargets(ctx);
for (const t of teams) {
  console.log(`-- ${t}`);
  for (const e of events) {
    const p = e.pairs.find((q) => q.team === t);
    if (!p) continue;
    const r = run.pre.get(`${e.code}:${t}`);
    console.log(`${e.code.padEnd(14)} ${e.type.padEnd(18)} w${e.w} pre ${r?.teleop.toFixed(1).padStart(6)}  opr ${p.teleop.toFixed(1).padStart(6)}`);
  }
  console.log(`final ${run.sim.rate(t).teleop.toFixed(1)}  endSeason ${run.endSeason.get(t)?.teleop.toFixed(1)}`);
}
