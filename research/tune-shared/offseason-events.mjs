// Off-season (and scrimmage) event inventory per season: date vs Worlds, team count,
// average alliance np, and how that compares with what the teams' end-of-official-season
// EPAs predict (ratio far from 1 = modified rules / abnormal scoring).
//   node research/tune-shared/offseason-events.mjs [--types OffSeason,Scrimmage] [--seasons 2024,2025]
import { ctxs, EPA_SEASONS } from "../lib.mjs";
import { simulateEpa, isPlaceholder } from "../../scripts/build.mjs";
import { epaParams } from "../../site/js/model.js";
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const types = new Set(arg("types", "OffSeason").split(","));
const seasons = arg("seasons", EPA_SEASONS.join(",")).split(",").map(Number);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
for (const ctx of await ctxs(seasons)) {
  const run = simulateEpa(ctx.matches, ctx, { epa: epaParams() }); // offWeight 0: main model = official only
  const byEv = new Map();
  for (const x of ctx.matches) { if (!byEv.has(x.ev.code)) byEv.set(x.ev.code, []); byEv.get(x.ev.code).push(x); }
  const wld = ctx.events.filter((e) => e.type === "FIRSTChampionship").map((e) => e.end).sort();
  const lastOfficial = ctx.matches.filter((x) => !types.has(x.ev.type) && x.ev.type !== "Scrimmage").map((x) => x.ev.end).sort().at(-1);
  // official-event reference: mean alliance np of events in the same calendar month, and late-season (champs+) mean
  const evAvg = (ms) => ms.reduce((s, x) => s + x.actual.red.np + x.actual.blue.np, 0) / (2 * ms.length);
  const official = [...byEv.values()].filter((ms) => !types.has(ms[0].ev.type) && ms[0].ev.type !== "Scrimmage");
  console.log(`\n=== ${ctx.season}  Worlds ${wld[0] ?? "-"}..${wld.at(-1) ?? "-"}  last official ${lastOfficial}  official events ${official.length}`);
  console.log("code         start       vsWld  country          teams  m   avgNp  predNp ratio  topTeams  elimShare  name");
  const rows = [];
  for (const [code, ms] of byEv) {
    const ev = ms[0].ev;
    if (!types.has(ev.type)) continue;
    const teams = [...new Set(ms.flatMap((x) => [...x.red, ...x.blue]))].filter((t) => !isPlaceholder(t));
    let pred = 0, act = 0, k = 0;
    for (const x of ms) for (const side of ["red", "blue"]) {
      const nums = x[side].filter((t) => !isPlaceholder(t) && run.rate(t).n > 0);
      if (nums.length !== x[side].length) continue;
      pred += nums.reduce((s, t) => s + run.rate(t).np, 0); act += x.actual[side].np; k++;
    }
    const rated = teams.filter((t) => run.rate(t).n > 0).map((t) => run.rate(t).np).sort((a, b) => b - a);
    const days = wld[0] ? Math.round((Date.parse(ev.start) - Date.parse(wld[0])) / 864e5) : NaN;
    const sizes = new Set(ms.map((x) => x.red.length));
    rows.push({ code, start: ev.start, days, country: ev.location?.country ?? "", nT: teams.length, m: ms.length, avg: evAvg(ms), pred: k ? pred / k : NaN, ratio: k ? act / pred : NaN, top: rated.slice(0, 3).map((v) => f(v, 0)).join("/"), elim: ms.filter((x) => x.elim).length / ms.length, name: ev.name, sizes: [...sizes].join(",") });
  }
  rows.sort((a, b) => a.start.localeCompare(b.start));
  for (const r of rows) console.log(`${r.code.padEnd(12)} ${r.start}  ${String(r.days).padStart(5)}  ${r.country.slice(0, 15).padEnd(15)} ${String(r.nT).padStart(5)} ${String(r.m).padStart(3)} ${f(r.avg).padStart(7)} ${f(r.pred).padStart(7)} ${f(r.ratio, 2).padStart(5)}  ${r.top.padEnd(10)} ${f(r.elim, 2).padStart(5)}  ${r.name.slice(0, 50)}${r.sizes !== "2" ? ` [alliance size ${r.sizes}]` : ""}`);
}
