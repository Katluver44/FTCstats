// Off-season variants the current params can't express (date cutoffs, per-event exclusion,
// post-Worlds scrimmages), emulated by editing the match list before the EPA run:
//   - an "excluded" off-season event (weight 0) only moves its own fork, so dropping its
//     matches leaves the main ratings identical;
//   - retyping an event to "OffSeason" makes it follow shared.offWeight.
// Scores every season on all targets, and separately on the targets the off-season
// can reach at all: official events that start after the season's first off-season event.
//   node research/tune-shared/offcut-eval.mjs [--boot 1000]
import { ctxs, EPA_SEASONS, epaRun, epaMetrics, epaPairs, bootstrapMaeDiff } from "../lib.mjs";
const argv = process.argv.slice(2);
const reps = +(argv[argv.indexOf("--boot") + 1] || 1000);
const MTI = /Maryland Tech Invitational|Multinational Tech Invitational/;
const worldsStart = (ctx) => ctx.events.filter((e) => e.type === "FIRSTChampionship").map((e) => e.start).sort()[0] ?? "9999";
const mtiStart = (ctx) => ctx.events.filter((e) => MTI.test(e.name)).map((e) => e.start).sort()[0];
const retype = (x, type) => ({ ...x, ev: { ...x.ev, type } });
// variants: name -> { over, edit(ctx) -> matches }
const V = {
  "A off excluded (default)": { over: {}, edit: (c) => c.matches },
  "B all off @0.4": { over: { shared: { offWeight: 0.4 } }, edit: (c) => c.matches },
  "C off <=MTI @0.4, later dropped": { over: { shared: { offWeight: 0.4 } }, edit: (c) => { const m = mtiStart(c); return c.matches.filter((x) => x.ev.type !== "OffSeason" || (m && x.ev.start <= m)); } },
  "D off <=MTI @1, later dropped": { over: { shared: { offWeight: 1 } }, edit: (c) => { const m = mtiStart(c); return c.matches.filter((x) => x.ev.type !== "OffSeason" || (m && x.ev.start <= m)); } },
  "E post-Worlds scrimmages as off (@0)": { over: {}, edit: (c) => { const w = worldsStart(c); return c.matches.map((x) => (x.ev.type === "Scrimmage" && x.ev.start > w ? retype(x, "OffSeason") : x)); } },
  "F E + off <=MTI @0.4": { over: { shared: { offWeight: 0.4 } }, edit: (c) => { const w = worldsStart(c), m = mtiStart(c); return c.matches.map((x) => (x.ev.type === "Scrimmage" && x.ev.start > w ? retype(x, "OffSeason") : x)).filter((x) => x.ev.type !== "OffSeason" || (m && x.ev.start <= m)); } },
};
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const cs = await ctxs(EPA_SEASONS);
const wmae = (ps) => ps.reduce((s, p) => s + p.w * Math.abs(p.err), 0) / ps.reduce((s, p) => s + p.w, 0);
const base = new Map();
for (const ctx of cs) {
  const firstOff = ctx.matches.filter((x) => x.ev.type === "OffSeason").map((x) => x.ev.start).sort()[0] ?? "9999";
  const reach = new Set(ctx.events.filter((e) => e.start > firstOff).map((e) => e.code));
  console.log(`\n=== ${ctx.season}  Worlds ${worldsStart(ctx)}  MTI ${mtiStart(ctx) ?? "-"}  first off-season ${firstOff}`);
  for (const [name, v] of Object.entries(V)) {
    const run = await epaRun({ ...ctx, matches: v.edit(ctx) }, v.over);
    const m = epaMetrics(ctx, run, "total");
    const ps = epaPairs(ctx, run, "total"), rs = ps.filter((p) => reach.has(p.ev));
    if (!base.has(ctx.season)) base.set(ctx.season, { ps, rs });
    const b = base.get(ctx.season);
    const ci = bootstrapMaeDiff(b.ps, ps, reps), ciR = rs.length ? bootstrapMaeDiff(b.rs, rs, reps) : [NaN, NaN];
    console.log(`${name.padEnd(38)} wMAE ${f(m.wMae)} (${f(ci[0], 3)}..${f(ci[1], 3)})  nMAE ${f(m.nMae, 4)}  topBias ${f(m.topBias)}  rhoOPR ${f(m.rhoOpr, 3)} rhoPO ${f(m.rhoPo, 3)} | reachable n=${rs.length} wMAE ${f(rs.length ? wmae(rs) : NaN)} (${f(ciR[0], 3)}..${f(ciR[1], 3)})`);
  }
}
