import { prepare, simulate } from "../scripts/build.mjs";
export const TRAIN = [2022, 2023, 2024], TEST = [2025];
const cache = new Map();
export async function ctxs(seasons) { const out = []; for (const s of seasons) { if (!cache.has(s)) cache.set(s, await prepare(s)); out.push(cache.get(s)); } return out; }
const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
export function evaluate(params, cs) {
  let n = 0, b = 0, c = 0, mae = 0;
  for (const ctx of cs) simulate(ctx.matches, { ...ctx, params }, (x, pre) => {
    const o = outcome(x); n++; b += (pre.pRed - o) ** 2; if (o !== 0.5 && (pre.pRed > 0.5) === (o === 1)) c++;
    mae += (Math.abs(pre.red.np - x.actual.red.np) + Math.abs(pre.blue.np - x.actual.blue.np)) / 2;
  });
  return { brier: b / n, acc: c / n, mae: mae / n };
}
// coordinate descent: grid = { key: [values] }
export async function tune(start, grid, { passes = 2, log = true } = {}) {
  const tr = await ctxs(TRAIN);
  let best = { ...start }, bl = evaluate(best, tr).brier;
  for (let p = 0; p < passes; p++) {
    let moved = false;
    for (const [k, vals] of Object.entries(grid)) for (const v of vals) {
      const t = { ...best, [k]: v }; const l = evaluate(t, tr).brier;
      if (l < bl - 1e-6) { best = t; bl = l; moved = true; }
    }
    if (log) console.log(`pass ${p}: ${bl.toFixed(5)} ${JSON.stringify(Object.fromEntries(Object.keys(grid).map((k) => [k, best[k]])))}`);
    if (!moved) break;
  }
  return best;
}
export async function report(name, params) {
  const a = evaluate(params, await ctxs(TRAIN)), b = evaluate(params, await ctxs(TEST));
  console.log(`${name.padEnd(28)} train ${a.brier.toFixed(5)} ${(a.acc * 100).toFixed(2)}% mae ${a.mae.toFixed(2)} | 2025 ${b.brier.toFixed(5)} ${(b.acc * 100).toFixed(2)}% mae ${b.mae.toFixed(2)}`);
  return [a, b];
}

// ======================================================================
// EPA (display) track evaluation helpers, used by research/epa-eval.mjs.
// The EPA track is scored on how well it represents robots, not on win-prob:
// the EPA a team carries INTO an event should predict what it actually
// contributes at that event (its per-event component OPR).
// ======================================================================
import { simulateEpa, loadEpaPriors } from "../scripts/build.mjs";
import { epaParams } from "../site/js/model.js";

export const EPA_COMPS = ["auto", "teleop", "endgame"];
export const EPA_SEASONS = [2019, 2021, 2022, 2023, 2024, 2025];
// events that aren't used as targets: modified rules / not real competition
const NOT_TARGET = new Set(["OffSeason", "Scrimmage", "NonAdvancement", "Kickoff", "Other"]);
// extra weight where the top of the list is decided
export const TIER_WEIGHT = { FIRSTChampionship: 4, Premier: 3, SuperQualifier: 3, Championship: 2 };
export const TOP_SCORING_WEIGHT = 3; // floor weight for the season's top 5% highest-scoring events

// Ridge least squares toward the event mean (Cholesky): x = mean + d, (AᵀA + λI) d = Aᵀ(y - A·mean).
function oprSolve(teams, rows, lambda = 1) {
  const n = teams.length, idx = new Map(teams.map((t, i) => [t, i]));
  let ySum = 0, kSum = 0;
  for (const r of rows) { ySum += r.y; kSum += r.nums.length; }
  const mean = ySum / Math.max(1, kSum);
  const M = Array.from({ length: n }, (_, i) => { const a = new Float64Array(n); a[i] = lambda; return a; });
  const v = new Float64Array(n);
  for (const { nums, y } of rows) {
    const ix = nums.map((t) => idx.get(t)), res = y - mean * nums.length;
    for (const a of ix) { v[a] += res; for (const b of ix) M[a][b] += 1; }
  }
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = M[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / L[j][j];
  }
  const z = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = v[i]; for (let k = 0; k < i; k++) s -= L[i][k] * z[k]; z[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return new Map(teams.map((t, i) => [t, mean + x[i]]));
}

// Per (team, event) targets: what the team actually contributed at the event, per
// component. Per-robot (solo) elements count exactly where the data records them
// (team's mean at the event); the rest of each component is the event's ridge
// OPR on alliance scores. Only official events, teams with >= minMatches there.
// Cached per season: independent of the EPA params.
const targetCache = new Map();
export function epaTargets(ctx, { minMatches = 4, minTeams = 8 } = {}) {
  if (targetCache.has(ctx.season)) return targetCache.get(ctx.season);
  const { matches, soloComps } = ctx;
  const byEv = new Map();
  for (const x of matches) { if (!byEv.has(x.ev.code)) byEv.set(x.ev.code, []); byEv.get(x.ev.code).push(x); }
  const events = [];
  for (const [code, ms] of byEv) {
    const ev = ms[0].ev;
    if (NOT_TARGET.has(ev.type)) continue;
    const count = new Map();
    for (const x of ms) for (const t of [...x.red, ...x.blue]) count.set(t, (count.get(t) ?? 0) + 1);
    const teams = [...count.keys()];
    if (teams.length < minTeams) continue;
    // each team's mean per-robot points per component, from quals with the breakdown
    const solo = new Map(teams.map((t) => [t, { auto: [0, 0], teleop: [0, 0], endgame: [0, 0] }]));
    for (const x of ms) for (const [side, nums] of [["red", x.red], ["blue", x.blue]]) {
      const s = x.actual[side].solo;
      if (!s || s.some((p) => !p || p.length !== nums.length)) continue;
      nums.forEach((t, i) => {
        const acc = solo.get(t);
        for (const c of EPA_COMPS) acc[c][1]++;
        soloComps.forEach((c, j) => (acc[c][0] += s[j][i]));
      });
    }
    // shared rows; robots' solo counts: their own when recorded, else their event mean
    const soloMean = (t, c) => { const [s, n] = solo.get(t)[c]; return n ? s / n : 0; };
    const out = {};
    for (const c of EPA_COMPS) {
      const rows = [];
      for (const x of ms) for (const [side, nums] of [["red", x.red], ["blue", x.blue]]) {
        const a = x.actual[side], s = a.solo;
        let own = 0;
        const recorded = s && s.every((p) => p && p.length === nums.length);
        soloComps.forEach((sc, j) => { if (sc === c && recorded) own += s[j].reduce((p, q) => p + q, 0); });
        if (!recorded) for (const t of nums) own += soloMean(t, c);
        rows.push({ nums, y: a[c] - own });
      }
      out[c] = oprSolve(teams, rows);
    }
    let npSum = 0;
    for (const x of ms) npSum += x.actual.red.np + x.actual.blue.np;
    const pairs = teams.filter((t) => count.get(t) >= minMatches).map((t) => {
      const tg = { team: t };
      for (const c of EPA_COMPS) tg[c] = out[c].get(t) + soloMean(t, c);
      tg.total = tg.auto + tg.teleop + tg.endgame;
      return tg;
    });
    events.push({ code, type: ev.type, name: ev.name, avgNp: npSum / (2 * ms.length), pairs });
  }
  // weights: event tier, and a floor for the season's highest-scoring events
  const cut = [...events].map((e) => e.avgNp).sort((a, b) => b - a)[Math.floor(events.length * 0.05)] ?? Infinity;
  for (const e of events) e.w = Math.max(TIER_WEIGHT[e.type] ?? 1, e.avgNp >= cut ? TOP_SCORING_WEIGHT : 1);

  // Worlds: division teams' total/component OPR there, and playoff wins (divisions + finals)
  const worlds = new Map(); // team -> { opr: {auto, teleop, endgame, total}, po }
  for (const e of events) if (e.type === "FIRSTChampionship") for (const p of e.pairs) worlds.set(p.team, { opr: p, po: 0 });
  for (const x of matches) {
    if (x.ev.type !== "FIRSTChampionship" || !x.elim) continue;
    const r = x.actual.red.total, b = x.actual.blue.total;
    if (r === b) continue;
    // whole alliance (incl. the robot sitting out) gets the win
    const all = (al) => x.m.teams.filter((t) => t.alliance === al).map((t) => t.teamNumber);
    for (const t of all(r > b ? "Red" : "Blue")) if (worlds.has(t)) worlds.get(t).po++;
    for (const t of [...all("Red"), ...all("Blue")]) if (worlds.has(t)) worlds.get(t).inPo = 1;
  }
  const res = { events, worlds };
  targetCache.set(ctx.season, res);
  return res;
}

const priorCache = new Map();
async function priorsFor(season, ep) {
  const key = `${season}:${JSON.stringify([ep.shared.priorWeights, ep.shared.priorRookieZ, ep.shared.priorMinMatches])}`;
  if (!priorCache.has(key)) priorCache.set(key, await loadEpaPriors(season, ep));
  return priorCache.get(key);
}

// Run the EPA track over a season. Returns each team's EPA entering each event
// ("code:team" -> {auto, teleop, endgame, np}), the end-of-official-season EPA for
// Worlds teams, and the final ratings (as the site would list them).
export async function epaRun(ctx, over = {}, comps = EPA_COMPS) {
  const ep = epaParams(over);
  const epaPriors = await priorsFor(ctx.season, ep);
  const { events, worlds } = epaTargets(ctx);
  const offTypes = new Set(ep.shared.offTypes);
  let lastOfficial = -1;
  ctx.matches.forEach((x, i) => { if (!offTypes.has(x.ev.type)) lastOfficial = i; });
  const pre = new Map(), endSeason = new Map();
  const want = new Set(events.flatMap((e) => e.pairs.map((p) => `${e.code}:${p.team}`)));
  const seen = new Set();
  const sim = simulateEpa(ctx.matches, ctx, {
    epa: ep, comps, epaPriors,
    onBefore: (x, v) => {
      for (const t of [...x.red, ...x.blue]) {
        const k = `${x.ev.code}:${t}`;
        if (!seen.has(k)) { seen.add(k); if (want.has(k)) pre.set(k, v.epa(t)); }
      }
    },
    onMatch: (x, v, i) => { if (i === lastOfficial) for (const t of worlds.keys()) endSeason.set(t, v.epa(t)); },
  });
  return { pre, endSeason, sim };
}

const rankOf = (v) => {
  const s = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(v.length);
  for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; }
  return r;
};
const pearson = (a, b, w = a.map(() => 1)) => {
  const W = w.reduce((s, x) => s + x, 0), ma = a.reduce((s, x, i) => s + w[i] * x, 0) / W, mb = b.reduce((s, x, i) => s + w[i] * x, 0) / W;
  let ab = 0, aa = 0, bb = 0;
  a.forEach((x, i) => { ab += w[i] * (x - ma) * (b[i] - mb); aa += w[i] * (x - ma) ** 2; bb += w[i] * (b[i] - mb) ** 2; });
  return ab / Math.sqrt(aa * bb);
};
export const spearman = (a, b) => (a.length > 2 ? pearson(rankOf(a), rankOf(b)) : NaN);

// Per-pair records for one component ("auto" | "teleop" | "endgame" | "total").
export function epaPairs(ctx, run, comp) {
  const { events } = epaTargets(ctx);
  const key = comp === "total" ? "np" : comp;
  const out = [];
  for (const e of events) for (const p of e.pairs) {
    const r = run.pre.get(`${e.code}:${p.team}`);
    if (!r || r[key] == null) continue;
    out.push({ ev: e.code, type: e.type, w: e.w, team: p.team, pred: r[key], target: p[comp], err: r[key] - p[comp] });
  }
  return out;
}

// Metrics for one component on one season.
export function epaMetrics(ctx, run, comp) {
  const ps = epaPairs(ctx, run, comp);
  const W = ps.reduce((s, p) => s + p.w, 0);
  const wMean = (f, list = ps) => { const ww = list.reduce((s, p) => s + p.w, 0); return list.reduce((s, p) => s + p.w * f(p), 0) / ww; };
  const tMean = wMean((p) => p.target), tSd = Math.sqrt(wMean((p) => (p.target - tMean) ** 2));
  const wMae = wMean((p) => Math.abs(p.err));
  // the top of the list: pairs whose target is in the season's top 5%
  const cut = ps.map((p) => p.target).sort((a, b) => b - a)[Math.floor(ps.length * 0.05)];
  const top = ps.filter((p) => p.target >= cut), worldsPs = ps.filter((p) => p.type === "FIRSTChampionship");
  const mae = (list) => list.length ? list.reduce((s, p) => s + Math.abs(p.err), 0) / list.length : NaN;
  const bias = (list) => list.length ? list.reduce((s, p) => s + p.err, 0) / list.length : NaN;
  // top of list vs Worlds: end-of-season EPA (off-season excluded) vs Worlds division OPR / playoff wins
  const { worlds } = epaTargets(ctx);
  const key = comp === "total" ? "np" : comp;
  const wt = [...worlds].filter(([t]) => run.endSeason.has(t));
  const rhoOpr = spearman(wt.map(([t]) => run.endSeason.get(t)[key]), wt.map(([, x]) => x.opr[comp]));
  const rhoPo = spearman(wt.map(([t]) => run.endSeason.get(t)[key]), wt.map(([, x]) => x.po + (x.inPo ?? 0)));
  return {
    n: ps.length, wMae, nMae: wMae / tSd, wCorr: pearson(ps.map((p) => p.pred), ps.map((p) => p.target), ps.map((p) => p.w)),
    bias: wMean((p) => p.err), topMae: mae(top), topBias: bias(top), worldsMae: mae(worldsPs), worldsBias: bias(worldsPs),
    rhoOpr, rhoPo, nWorlds: wt.length, pairs: ps,
  };
}

// Paired bootstrap over events: 95% CI of (weighted MAE of b) - (weighted MAE of a).
// a, b: epaPairs() lists for the same season and component, in the same order.
export function bootstrapMaeDiff(a, b, reps = 1000, seed = 7) {
  let rng = seed; const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const byEv = new Map();
  a.forEach((p, i) => {
    if (!byEv.has(p.ev)) byEv.set(p.ev, [0, 0]);
    const g = byEv.get(p.ev); g[0] += p.w; g[1] += p.w * (Math.abs(b[i].err) - Math.abs(p.err));
  });
  const gs = [...byEv.values()], diffs = [];
  for (let r = 0; r < reps; r++) { let w = 0, d = 0; for (let k = 0; k < gs.length; k++) { const g = gs[Math.floor(rand() * gs.length)]; w += g[0]; d += g[1]; } diffs.push(d / w); }
  diffs.sort((x, y) => x - y);
  return [diffs[Math.floor(reps * 0.025)], diffs[Math.floor(reps * 0.975) - 1]];
}
