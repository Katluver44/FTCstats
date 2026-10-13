// Ranking-quality validation for the EPA (display) track. No win-prob anywhere:
// the EPA a team carries INTO an event should predict what it contributes at
// that event (per-event component OPR; per-robot elements counted exactly).
//
//   node research/epa-eval.mjs --comp auto            # auto | teleop | endgame | total | all (default)
//   node research/epa-eval.mjs --comp all --params p.json
//        p.json = { "auto": { "mom": 0 }, "shared": { "offWeight": 0.2 } }   (merged onto DEFAULT_EPA_PARAMS)
//        Prints default vs candidate per season with a paired event-bootstrap 95% CI.
//   node research/epa-eval.mjs --comp teleop --grid g.json [--obj mae|rho]
//        g.json = { "teleop.mom": [0, -0.1, -0.2], "teleop.clipC": [0, 1.25] }  (optional "base": {...} params)
//        Leave-one-season-out: for each season, coordinate descent on the other five,
//        then default vs tuned on the held-out season.
//   Other flags: --seasons 2023,2024   --boot 1000   --no-sanity   --quiet
//
// Metrics per component and season (pairs = team x official event, weighted by
// event tier: Worlds 4, Premier/SuperQualifier 3, Championship 2, season's top-5%
// scoring events at least 3):
//   wMAE    weighted mean |pre-event EPA - event OPR|; nMAE = wMAE / weighted SD of targets
//   wCorr   weighted Pearson correlation;  bias = mean(EPA - OPR) (negative = underrated)
//   topMAE / topB(tgt)  pairs whose event OPR is in the season's top 5% (the bias here is
//           mostly regression to the mean: selected on high outcomes)
//   topB(EPA)  bias on the top 5% of pairs by pre-event EPA (the teams the list puts on
//           top; the bias a reader sees)
//   wldMAE  Worlds pairs only (pre-Worlds EPA vs Worlds division OPR; finals excluded)
//   rhoOPR  Spearman: EPA just before Worlds (off-season excluded) vs Worlds division OPR
//   rhoPO   Spearman: same EPA vs Worlds playoff wins (+1 for making playoffs)
// The objective for tuning ("mae") is the mean nMAE over seasons (lower = better).
// Priors come from site/data (built with DEFAULT_EPA_PARAMS): prior settings
// (shared.prior*) and carry/initFrac/v0 are live, but the previous seasons' final
// EPAs are what the current defaults produced. Rebuild after changing defaults.
import fs from "node:fs";
import { ctxs, EPA_COMPS, EPA_SEASONS, epaRun, epaMetrics, epaTargets, bootstrapMaeDiff } from "./lib.mjs";
import { epaParams } from "../site/js/model.js";
import { isPlaceholder } from "../scripts/build.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const comp = arg("comp", "all");
if (!["auto", "teleop", "endgame", "total", "all"].includes(comp)) throw new Error(`--comp: auto|teleop|endgame|total|all`);
const seasons = (arg("seasons") ?? EPA_SEASONS.join(",")).split(",").map(Number);
const reps = +arg("boot", 1000);
const obj = arg("obj", "mae");
const readJson = (f) => (f ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const cand = readJson(arg("params"));
const grid = readJson(arg("grid"));
const shown = comp === "all" ? [...EPA_COMPS, "total"] : [comp];
const runComps = comp === "auto" || comp === "teleop" || comp === "endgame" ? [comp] : EPA_COMPS;

const SANITY = 2025, SANITY_TEAMS = [14270, 11260, 24033]; // Quantum Robotics, Up-A-Creek (UAC), Alphatronic
const all = await ctxs([...new Set([...seasons, ...(flag("no-sanity") ? [] : [SANITY])])]);
const ctxOf = new Map(all.map((c) => [c.season, c]));

const timing = [];
async function evalSeason(season, over) {
  const t0 = performance.now();
  const run = await epaRun(ctxOf.get(season), over, runComps);
  const m = Object.fromEntries(shown.map((c) => [c, epaMetrics(ctxOf.get(season), run, c)]));
  timing.push(performance.now() - t0);
  return m;
}
const objective = (ms) => {
  const vals = [];
  for (const m of ms) for (const c of shown) {
    const v = obj === "rho" ? -m[c].rhoOpr : m[c].nMae;
    if (Number.isFinite(v)) vals.push(v);
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const HEAD = "season     n   wMAE   nMAE  wCorr   bias  topMAE topB(tgt) topB(EPA) wldMAE rhoOPR  rhoPO";
const line = (s, m) => `${String(s).padEnd(6)} ${String(m.n).padStart(6)} ${f(m.wMae).padStart(6)} ${f(m.nMae, 4).padStart(6)} ${f(m.wCorr, 4).padStart(6)} ${f(m.bias).padStart(6)} ${f(m.topMae).padStart(7)} ${f(m.topBias).padStart(9)} ${f(m.topBiasP).padStart(9)} ${f(m.worldsMae).padStart(6)} ${f(m.rhoOpr, 3).padStart(6)} ${f(m.rhoPo, 3).padStart(6)}`;
const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.reduce((a, b) => a + b, 0) / v.length; };
function table(title, bySeason) {
  console.log(`\n== ${title}`);
  for (const c of shown) {
    console.log(`-- ${c}\n${HEAD}`);
    for (const [s, m] of bySeason) console.log(line(s, m[c]));
    const ms = [...bySeason.values()].map((m) => m[c]);
    const avg = Object.fromEntries(["wMae", "nMae", "wCorr", "bias", "topMae", "topBias", "topBiasP", "worldsMae", "rhoOpr", "rhoPo"].map((k) => [k, mean(ms.map((m) => m[k]))]));
    console.log(line("mean", { ...avg, n: ms.reduce((a, m) => a + m.n, 0) }));
  }
}
function compare(label, base, other) {
  console.log(`\n== ${label}: default -> candidate, weighted MAE (paired event bootstrap 95% CI of the difference; negative = better)`);
  for (const c of shown) {
    console.log(`-- ${c}`);
    for (const [s, a] of base) {
      const b = other.get(s); if (!b) continue;
      const ci = bootstrapMaeDiff(a[c].pairs, b[c].pairs, reps);
      console.log(`${s}  wMAE ${f(a[c].wMae)} -> ${f(b[c].wMae)}  CI ${f(ci[0], 3)}..${f(ci[1], 3)}  nMAE ${f(a[c].nMae, 4)} -> ${f(b[c].nMae, 4)}  wCorr ${f(a[c].wCorr, 4)} -> ${f(b[c].wCorr, 4)}  topB(EPA) ${f(a[c].topBiasP)} -> ${f(b[c].topBiasP)}  topB(tgt) ${f(a[c].topBias)} -> ${f(b[c].topBias)}  rhoOPR ${f(a[c].rhoOpr, 3)} -> ${f(b[c].rhoOpr, 3)}  rhoPO ${f(a[c].rhoPo, 3)} -> ${f(b[c].rhoPo, 3)}`);
    }
  }
}

// grid keys "section.key" -> nested params
const setPath = (over, k, v) => { const [sec, key] = k.split("."); const o = structuredClone(over); (o[sec] ??= {})[key] = v; return o; };

const base = new Map();
for (const s of seasons) base.set(s, await evalSeason(s, {}));
const perRun = mean(timing) / 1000;
if (!flag("quiet")) table(`EPA track, DEFAULT_EPA_PARAMS (comp ${comp})`, base);
console.log(`\nobjective (${obj}) default: ${objective([...base.values()]).toFixed(5)}`);

let final = {};
if (cand) {
  const other = new Map();
  for (const s of seasons) other.set(s, await evalSeason(s, cand));
  if (!flag("quiet")) table(`EPA track, candidate ${arg("params")}`, other);
  compare("candidate", base, other);
  console.log(`objective (${obj}) candidate: ${objective([...other.values()]).toFixed(5)}`);
  final = cand;
}

if (grid) {
  const { base: start = cand ?? {}, ...keys } = grid;
  const held = new Map(), chosen = [];
  for (const h of seasons) {
    const train = seasons.filter((s) => s !== h);
    const score = async (over) => { const ms = []; for (const s of train) ms.push(await evalSeason(s, over)); return objective(ms); };
    let best = structuredClone(start), bl = await score(best);
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const [k, vs] of Object.entries(keys)) for (const v of vs) {
        const t = setPath(best, k, v), l = await score(t);
        if (l < bl - 1e-6) { best = t; bl = l; moved = true; }
      }
      if (!moved) break;
    }
    held.set(h, await evalSeason(h, best));
    chosen.push([h, best]);
    console.log(`held-out ${h}: tuned on ${train.join(",")} -> ${JSON.stringify(best)} (train objective ${bl.toFixed(5)})`);
  }
  compare("LOSO (each season scored with params tuned on the other seasons)", base, held);
  console.log(`objective (${obj}) LOSO: ${objective([...held.values()]).toFixed(5)} vs default ${objective([...base.values()]).toFixed(5)}`);
}

if (!flag("no-sanity")) {
  // what the site would list for the latest completed season under these params
  const ctx = ctxOf.get(SANITY);
  const run = await epaRun(ctx, final, EPA_COMPS);
  const names = new Map(), wld = epaTargets(ctx).worlds;
  for (const ev of ctx.events) for (const tp of ev.teams) names.set(tp.teamNumber, tp.team?.name ?? "");
  const off = new Set(epaParams(final).shared.offTypes);
  const official = new Set(ctx.matches.filter((x) => !off.has(x.ev.type)).flatMap((x) => [...x.red, ...x.blue]).filter((t) => !isPlaceholder(t)));
  const list = [...official].map((t) => ({ t, e: run.sim.rate(t) })).sort((a, b) => b.e.np - a.e.np);
  const row = (x, i) => {
    const w = wld.get(x.t);
    return `${String(i + 1).padStart(4)}  ${String(x.t).padStart(5)} ${(names.get(x.t) ?? "").slice(0, 26).padEnd(26)} ${f(x.e.np, 1).padStart(6)} ${f(x.e.auto, 1).padStart(6)} ${f(x.e.teleop, 1).padStart(6)} ${f(x.e.endgame, 1).padStart(6)}   ${w ? `${f(w.opr.total, 1).padStart(6)} ${String(w.po).padStart(3)}` : "     -   -"}`;
  };
  console.log(`\n== Sanity: ${SANITY} final EPA ranking ${cand ? "(candidate params)" : "(default params)"}\n   #   team name                        total   auto teleop endgm   WldOPR POw`);
  list.slice(0, 20).forEach((x, i) => console.log(row(x, i)));
  console.log("  ...");
  for (const t of SANITY_TEAMS) { const i = list.findIndex((x) => x.t === t); if (i >= 0) console.log(row(list[i], i)); }
}
console.log(`\nruntime: ${perRun.toFixed(2)} s per season per param set (comp ${comp}, ${runComps.length} component run${runComps.length > 1 ? "s, deduplicated when settings match" : ""}); ${timing.length} season-runs total`);
