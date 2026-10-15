// Replays a season's matches in time order through the EPA model and writes
// static JSON for the site into site/data/<season>/.
//
//   node scripts/build.mjs 2025

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEASONS, soloPoints } from "../site/js/seasons.js";
import { fitSoloValues } from "./solo-values.mjs";
import { Model, COMPONENTS, onField, allianceTeams, isElim, epaParams, epaComponent } from "../site/js/model.js";
import { oprPredictions } from "./opr.mjs";
import { localToUtc, splitVideos } from "./videos.mjs";
import { elo, avgScore } from "./baselines.mjs";
import { addEventSos, sosValue, sosPlaces } from "../site/js/sos.js";

const r1 = (x) => Math.round(x * 10) / 10;

// A match counts as played only with real scores: some scrimmages mark
// unplayed matches as played with a 0-0 score.
export const isPlayed = (m) =>
  m.hasBeenPlayed && !!m.scores?.red && (m.scores.red.totalPoints > 0 || m.scores.blue.totalPoints > 0);

// Off-season demo/placeholder teams (99xxx) play in matches but aren't real teams.
export const isPlaceholder = (team) => team >= 99000;
const r3 = (x) => Math.round(x * 1000) / 1000;

export async function loadSeason(season) {
  const dir = path.join(".cache", String(season));
  const files = await fs.readdir(dir).catch(() => []);
  const events = [];
  for (const f of files) {
    const ev = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
    if (season === 2019) fixLocalTimes(ev);
    if (!ev.remote) events.push(ev);
  }
  return events;
}

// 2019 match times come as the venue's clock time marked UTC ("11:15Z" for 11:15 in New
// York), so they're 4-7 h early in the US. Livestream recordings confirm it: their
// matches start that many hours after the listed times. Read them as local time.
const STATE_TZ = { CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", IN: "America/Indiana/Indianapolis",
  KY: "America/New_York", ME: "America/New_York", MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", NH: "America/New_York", NJ: "America/New_York",
  NY: "America/New_York", NC: "America/New_York", OH: "America/New_York", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", VT: "America/New_York",
  VA: "America/New_York", WV: "America/New_York", AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago", KS: "America/Chicago",
  LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago", AZ: "America/Phoenix", CO: "America/Denver", ID: "America/Boise",
  MT: "America/Denver", NM: "America/Denver", UT: "America/Denver", WY: "America/Denver", CA: "America/Los_Angeles", NV: "America/Los_Angeles",
  OR: "America/Los_Angeles", WA: "America/Los_Angeles", AK: "America/Anchorage", HI: "Pacific/Honolulu" };
function fixLocalTimes(ev) {
  const tz = ev.timezone && ev.timezone !== "UTC" ? ev.timezone : ev.location?.country === "USA" ? STATE_TZ[ev.location.state] : null;
  if (!tz) return;
  for (const m of ev.matches ?? []) for (const k of ["actualStartTime", "scheduledStartTime"]) {
    if (m[k]) m[k] = new Date(localToUtc(m[k].replace(/(\.\d+)?Z$/, ""), tz)).toISOString();
  }
}

function matchTime(ev, m) {
  const t = m.actualStartTime ?? m.scheduledStartTime;
  if (t) return Date.parse(t);
  // no timestamps: order by event start, then match id
  return Date.parse(`${ev.start}T12:00:00Z`) + m.id * 1000;
}

// Flattened, time-sorted list of played matches with usable scores.
export function playedMatches(season, events, fits = []) {
  const read = SEASONS[season].read;
  // per-robot points, only in quals: elim alliances have 3 teams and the
  // per-robot fields can't be matched to them reliably
  const withSolo = (a, raw, elim) => ({ ...a, solo: !elim && fits.length ? soloPoints(season, raw, fits) : null });
  const out = [];
  for (const ev of events) {
    for (const m of ev.matches) {
      if (!isPlayed(m)) continue;
      const red = onField(m, "Red"), blue = onField(m, "Blue");
      if (!red.length || !blue.length) continue;
      out.push({
        ev, m, red, blue, elim: isElim(m), time: matchTime(ev, m),
        actual: {
          red: withSolo(read(m.scores.red), m.scores.red, isElim(m)),
          blue: withSolo(read(m.scores.blue), m.scores.blue, isElim(m)),
        },
      });
    }
  }
  return out.sort((a, b) => a.time - b.time || a.m.id - b.m.id);
}

// Everything a model run needs for a season.
export async function prepare(season, events, priorOpts) {
  events ??= await loadSeason(season);
  const fits = fitSoloValues(season, events);
  const soloComps = fits.map((f) => f.comp);
  const movedSpec = fits.findIndex((f) => f.moved);
  const parkedSpec = fits.findIndex((f) => f.parked);
  const matches = playedMatches(season, events, fits);
  const baseline = baselineOf(matches, soloComps);
  // prediction track's priors come from last seasons' prediction ratings, the EPA track's from their EPAs
  const { priors, cv, rookieZ } = await loadPriors(season, priorOpts, "pnp");
  const epaPriors = await loadEpaPriors(season);
  return { season, events, fits, soloComps, movedSpec, parkedSpec, matches, baseline, priors, cv, rookieZ, epaPriors };
}

// Average alliance values over the first matches; components exclude per-robot points.
export function baselineOf(matches, soloComps = []) {
  const first = matches.slice(0, 400);
  const b = { auto: 0, teleop: 0, endgame: 0, foul: 0, foulVar: 0, rp: [0, 0, 0], solo: soloComps.map(() => 0) };
  let n = 0;
  for (const { actual, elim } of first) {
    for (const a of [actual.red, actual.blue]) {
      for (const c of COMPONENTS) b[c] += a[c];
      soloComps.forEach((c, j) => {
        const s = a.solo?.[j] ? a.solo[j].reduce((x, y) => x + y, 0) : 0;
        b[c] -= s; b.solo[j] += s;
      });
      b.foul += a.total - a.np;
      b.foulVar += (a.total - a.np) ** 2;
      if (!elim) a.rp.forEach((x, i) => (b.rp[i] += x ? 1 : 0));
      n++;
    }
  }
  for (const c of [...COMPONENTS, "foul"]) b[c] /= n || 1;
  b.foulVar = Math.max(0, b.foulVar / (n || 1) - b.foul ** 2);
  b.solo = b.solo.map((x) => x / (n || 1));
  b.rp = b.rp.map((x) => x / (n || 1));
  return b;
}

// Inverse normal CDF (Acklam's approximation), for rank-based z-scores.
function normInv(p) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const q = Math.min(p, 1 - p);
  let x;
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
    return p < 0.5 ? x : -x;
  }
  const r = (p - 0.5) ** 2;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * (p - 0.5)) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Starting ratings from up to three earlier seasons. Each season's final EPAs
// become rank-based z-scores (so different games compare fairly); they're
// blended with decaying weights, and a missing season counts as `rookieZ`.
// (After the FRC predictor's priors.)
// col: which rating to rank by: "pnp" (prediction track; tie order kept by "prank")
// or "np" (EPA track). Files from before the split only have "np".
// table: which of last season's team tables (OFF_TABLES) to rank: "full" (every
// off-season event at OFF_WEIGHT, minus excluded ones) predicted the next season
// marginally best (research/tune-shared/). The file name comes from that
// season's meta.json (offTables).
export const PRIOR_OPTS = { weights: [1, 0.3, 0.15], rookieZ: -0.5, minMatches: 5 }; // tuned on 2022-2024
export const PRIOR_TABLE = "full";
async function priorTable(season, table) {
  const dir = path.join("site", "data", String(season));
  const meta = await fs.readFile(path.join(dir, "meta.json"), "utf8").then(JSON.parse).catch(() => null);
  if (!meta) return null; // season not built
  const file = meta.offTables?.[table];
  if (!file) throw new Error(`site/data/${season}/meta.json has no offTables.${table}: rebuild ${season} first`);
  return JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
}
export async function loadPriors(season, opts = PRIOR_OPTS, col = "pnp", table = PRIOR_TABLE) {
  const { weights, rookieZ, minMatches } = { ...PRIOR_OPTS, ...opts };
  const colOf = (t) => (t.cols.includes(col) ? t.cols.indexOf(col) : t.cols.indexOf("np"));
  const past = [];
  for (let k = 1; k <= weights.length; k++) {
    if (!weights[k - 1]) { past.push(null); continue; }
    const prev = await priorTable(season - k, table);
    if (!prev) { past.push(null); continue; }
    const npI = colOf(prev), mI = prev.cols.indexOf("matches"), rkI = col === "pnp" ? prev.cols.indexOf("prank") : -1;
    const rows = prev.rows.filter((r) => r[mI] >= minMatches).sort((a, b) => b[npI] - a[npI] || (rkI >= 0 ? a[rkI] - b[rkI] : 0));
    const z = new Map(rows.map((r, i) => [r[0], -normInv((i + 0.5) / rows.length)]));
    past.push(z);
  }
  if (!past[0]) return { priors: new Map(), cv: 0.5 };
  const teams = new Set(past.flatMap((m) => (m ? [...m.keys()] : [])));
  const priors = new Map();
  for (const t of teams) {
    let sum = 0, wsum = 0;
    past.forEach((m, i) => {
      if (!weights[i] || !m) return;
      sum += weights[i] * (m.get(t) ?? rookieZ);
      wsum += weights[i];
    });
    priors.set(t, sum / wsum);
  }
  // spread of last season's EPAs relative to its mean, to turn z into points
  const prev = JSON.parse(await fs.readFile(path.join("site", "data", String(season - 1), "teams.json"), "utf8"));
  const npI = colOf(prev), mI = prev.cols.indexOf("matches");
  const vals = prev.rows.filter((r) => r[mI] >= minMatches).map((r) => r[npI]);
  if (vals.length < 10) return { priors: new Map(), cv: 0.5 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { priors, cv: sd / mean, rookieZ };
}

// The EPA track's priors, with its own prior settings (EPA params `shared`).
export function loadEpaPriors(season, epa = epaParams()) {
  const { priorWeights, priorRookieZ, priorMinMatches } = epa.shared;
  return loadPriors(season, { weights: priorWeights, rookieZ: priorRookieZ, minMatches: priorMinMatches }, "np");
}

// Runs the model and scores its pre-match predictions.
// Event types whose results don't change official ratings: off-season events
// often play modified rules and lineups. Each runs on its own fork of the model,
// so ratings still learn within the event (as the live page does).
export const UNOFFICIAL = new Set(["OffSeason"]);
// How much an off-season event's rating changes count once it ends, for the
// "Through MTI" / "Full season" tables and next season's starting ratings.
// 0.4 ranked teams best by their next season (research/offweight.mjs, 2021-2024);
// counting them fully (1) was the worst of 0 / 0.25 / 0.5 / 0.75 / 1.
export const OFF_WEIGHT = 0.4;

// The team tables the site offers (EPA shared off-season settings for each).
//   official: off-season events excluded (scrimmages and post-Worlds Premier events count)
//   mti: off-season events up to and including MTI (Maryland / Multinational Tech
//        Invitational, the last big US one) at OFF_WEIGHT
//   full: every off-season event at OFF_WEIGHT
// Both off-season tables leave out excluded events (EPA shared.offExclude / offFlag).
export const OFF_TABLES = {
  official: { file: "teams.json", shared: { offWeight: 0 } },
  mti: { file: "teams-mti.json", shared: { offWeight: OFF_WEIGHT, offCutoff: "MTI" } },
  full: { file: "teams-full.json", shared: { offWeight: OFF_WEIGHT, offCutoff: null } },
};
const MTI_NAME = /(Maryland|Multinational) Tech Invitational/i;
// MTI's event code in a season (USCHSLAOS in 2021-2025, USCHSLHOS in 2020), or null.
export const mtiCode = (events) => [...events].filter((e) => MTI_NAME.test(e.name)).sort((a, b) => a.start.localeCompare(b.start))[0]?.code ?? null;

// Off-season events whose scores don't fit the teams' ratings: actual average
// alliance score outside range x the sum of the teams' EPAs (alliances whose
// teams all have an official rating). Catches modified-rules events, e.g. 2025
// Robot Rumble Missouri/Illinois divisions, 2024 USMIRHOS / RODEOS.
//   rate(team): official ratings (EPA track, off-season excluded) at season end.
export function flagOffseason(matches, rate, offTypes = UNOFFICIAL, range = [0.5, 1.6]) {
  const out = new Set();
  if (!range) return out;
  const acc = new Map();
  for (const x of matches) {
    if (!offTypes.has(x.ev.type)) continue;
    for (const side of ["red", "blue"]) {
      const nums = x[side];
      if (nums.some((t) => isPlaceholder(t) || !(rate(t).n > 0))) continue;
      if (!acc.has(x.ev.code)) acc.set(x.ev.code, [0, 0]);
      const a = acc.get(x.ev.code);
      a[0] += x.actual[side].np; a[1] += nums.reduce((s, t) => s + rate(t).np, 0);
    }
  }
  for (const [code, [act, pred]] of acc) if (pred > 0 && (act < range[0] * pred || act > range[1] * pred)) out.add(code);
  return out;
}

// Weight of each off-season event's rating changes, from the EPA shared settings:
// offWeight, unless the event starts after offCutoff (an event code, looked up in
// this season; a code not played yet means no cutoff) or is excluded by name/code
// (offExclude) or flagged (a set of codes from flagOffseason).
export function offWeights(matches, { offWeight = 0, offCutoff = null, offExclude = [] } = {}, flagged = new Set()) {
  if (!offWeight) return 0;
  let cut = offCutoff;
  if (cut && !/^\d{4}-\d{2}-\d{2}/.test(cut)) cut = matches.find((x) => x.ev.code === cut)?.ev.start ?? null;
  const ex = (offExclude ?? []).map((e) => (/^[A-Z0-9]+$/.test(e) ? (ev) => ev.code === e : ((re) => (ev) => re.test(ev.name ?? ""))(new RegExp(e, "i"))));
  return (ev) => ((cut && ev.start > cut) || flagged.has(ev.code) || ex.some((f) => f(ev)) ? 0 : offWeight);
}

// One rating track over a season: a Model, plus a fork for each unofficial event.
// offWeight: a number, or ev -> weight per event (offWeights).
function makeTrack(matches, modelArgs, { unofficial = UNOFFICIAL, offWeight = 0 } = {}) {
  const model = new Model(modelArgs);
  const forks = new Map(); // event code -> forked model
  // when an unofficial event ends, its weight x its rating changes carry over
  const wOf = new Map();
  const weight = (ev) => {
    if (!wOf.has(ev.code)) wOf.set(ev.code, typeof offWeight === "function" ? offWeight(ev) : offWeight);
    return wOf.get(ev.code);
  };
  const lastOf = new Map();
  matches.forEach((x, i) => unofficial.has(x.ev.type) && weight(x.ev) && lastOf.set(x.ev.code, i));
  return {
    model,
    // the model a match is played on
    at(x) {
      if (!unofficial.has(x.ev.type)) return model;
      if (!forks.has(x.ev.code)) forks.set(x.ev.code, model.fork());
      return forks.get(x.ev.code);
    },
    done(x, i) { if (lastOf.get(x.ev.code) === i) this.at(x).merge(weight(x.ev)); },
  };
}

// A team's prediction-track state entering an event it hasn't played yet,
// including between-event growth (p.grow), without changing the model.
function grown(model, code, num) {
  const f = model.fork();
  f.enter([num], code);
  return f.epa(num);
}

// The prediction track.
export function simulate(matches, { season, params, baseline, priors, cv, soloComps, movedSpec, parkedSpec, rookieZ, unofficial = UNOFFICIAL, offWeight = 0, zone = true }, onMatch) {
  const types = new Map(matches.map((x) => [x.ev.code, x.ev.type]));
  const track = makeTrack(matches, { params, baseline, priors, cv, soloComps, movedSpec, parkedSpec, rookieZ,
    zoneRp: zone ? SEASONS[season]?.zoneRp : null, eventType: (code) => types.get(code) }, { unofficial, offWeight });
  const acc = newAcc();
  for (const [i, x] of matches.entries()) {
    const m = track.at(x);
    // between-event growth (p.grow, off by default); before `before` so event-file
    // states include it and live.js replays match the build without calling enter()
    m.enter([...x.red, ...x.blue], x.ev.code);
    const before = onMatch ? new Map([...x.red, ...x.blue].map((t) => [t, m.epa(t)])) : null;
    const avgBefore = onMatch ? { ...m.avg, rp: [...m.avg.rp], solo: [...m.avg.solo], clipVar: { ...m.errVar }, cal: structuredClone(m.cal) } : null;
    const pre = m.update(x.red, x.blue, x.actual, x.elim, x.ev.code);
    score(acc, x, pre);
    onMatch?.(x, pre, m, before, avgBefore);
    track.done(x, i);
  }
  return { model: track.model, acc };
}

// The EPA (display) track: one Model per component, each with its own settings
// (components with identical settings share one run). Ratings only; nothing
// here feeds win probabilities.
//   ctx: prepare()'s output (uses baseline, soloComps, movedSpec, parkedSpec, epaPriors)
//   epa: full EPA params (epaParams(...)); comps: components to run
//   offWeight: overrides every component's off-season weight
//   offFlagged: off-season event codes that count 0 (flagOffseason)
//   epaPriors: overrides ctx.epaPriors (e.g. loaded with other prior settings)
//   onBefore(x, view, i) / onMatch(x, view, i): around each match; view.epa(team) reads
//     the ratings the match is played on (an off-season event's fork, or the main ones)
// Returns { rate(team), epa: view over the main models, groups }.
export function simulateEpa(matches, ctx, { epa = epaParams(), comps = COMPONENTS, offWeight, offFlagged = new Set(), epaPriors, onBefore, onMatch } = {}) {
  const { priors, cv, rookieZ } = epaPriors ?? ctx.epaPriors;
  const { baseline, soloComps, movedSpec, parkedSpec } = ctx;
  const groups = new Map(), groupOf = {};
  for (const c of comps) {
    const s = epaComponent(epa, c);
    if (offWeight != null) s.offWeight = offWeight;
    const key = JSON.stringify(s);
    if (!groups.has(key)) {
      const track = makeTrack(matches, { params: s.model, baseline, priors, cv, soloComps, movedSpec, parkedSpec, rookieZ },
        { unofficial: new Set(s.offTypes), offWeight: offWeights(matches, s, offFlagged) });
      groups.set(key, { track, comps: [] });
    }
    groups.get(key).comps.push(c);
    groupOf[c] = groups.get(key);
  }
  const gs = [...groups.values()];
  // ratings as of now, on the models match x is played on (main models when x is null)
  const view = (x) => {
    const ms = new Map(gs.map((g) => [g, x ? g.track.at(x) : g.track.model]));
    return {
      epa(t) {
        const out = { n: ms.get(gs[0]).team(t).n, np: 0 };
        for (const c of comps) {
          const v = ms.get(groupOf[c]).epa(t)[c];
          out[c] = v; out.np += v;
        }
        return out;
      },
    };
  };
  for (const [i, x] of matches.entries()) {
    for (const g of gs) g.track.at(x).enter([...x.red, ...x.blue], x.ev.code); // between-event growth (off by default)
    if (onBefore) onBefore(x, view(x), i);
    for (const g of gs) g.track.at(x).update(x.red, x.blue, x.actual, x.elim, x.ev.code);
    if (onMatch) onMatch(x, view(x), i);
    for (const g of gs) g.track.done(x, i);
  }
  const main = view(null);
  return { rate: (t) => main.epa(t), epa: main, groups: gs };
}

function newAcc() {
  const g = () => ({ n: 0, correct: 0, brier: 0, mae: 0, rpN: 0, rpBrier: 0 });
  return { all: g(), quals: g(), elims: g(), champs: g(), calib: Array.from({ length: 10 }, () => [0, 0]) };
}

function score(acc, x, pre) {
  const { red, blue } = x.actual;
  const outcome = red.total === blue.total ? 0.5 : red.total > blue.total ? 1 : 0;
  // calibration, from the favourite's point of view
  const fav = pre.pRed >= 0.5 ? pre.pRed : 1 - pre.pRed;
  const favWon = pre.pRed >= 0.5 ? outcome : 1 - outcome;
  const bin = acc.calib[Math.min(9, Math.floor(fav * 10))];
  bin[0]++; bin[1] += favWon;
  const groups = [acc.all, x.elim ? acc.elims : acc.quals];
  if (/Championship/.test(x.ev.type)) groups.push(acc.champs);
  for (const g of groups) {
    g.n++;
    if (outcome !== 0.5 && (pre.pRed > 0.5) === (outcome === 1)) g.correct++;
    g.brier += (pre.pRed - outcome) ** 2;
    g.mae += (Math.abs(pre.red.np - red.np) + Math.abs(pre.blue.np - blue.np)) / 2;
    if (!x.elim) {
      for (const side of ["red", "blue"]) {
        pre[side].rp.forEach((p, i) => {
          g.rpBrier += (p - (x.actual[side].rp[i] ? 1 : 0)) ** 2;
          g.rpN++;
        });
      }
    }
  }
}

export function summarize(acc) {
  const out = {};
  for (const [k, g] of Object.entries(acc)) {
    if (k === "calib") {
      out.calib = g.map(([n, w], i) => ({ bin: i / 10, n, winRate: n ? r3(w / n) : null })).filter((b) => b.n);
      continue;
    }
    if (!g.n) continue;
    out[k] = {
      matches: g.n,
      accuracy: r3(g.correct / g.n),
      brier: r3(g.brier / g.n),
      scoreMae: r1(g.mae / g.n),
      rpBrier: g.rpN ? r3(g.rpBrier / g.rpN) : null,
    };
  }
  return out;
}

const epaRow = (e) => ({
  np: r1(e.np), auto: r1(e.auto), teleop: r1(e.teleop), endgame: r1(e.endgame),
  rp: e.rp.map(r3),
});

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}

// params: prediction-track overrides; epaOver: EPA-track overrides ({ shared, auto, teleop, endgame }).
export async function build(season, params = {}, epaOver = {}) {
  const cfg = SEASONS[season];
  const hasRp = cfg.rpNames.length > 0;
  const events = await loadSeason(season);
  const ctx = await prepare(season, events);
  const { matches, baseline, priors, cv, soloComps, movedSpec, parkedSpec, fits, rookieZ } = ctx;
  const epa = epaParams(epaOver);
  const ctxEpa = { ...ctx, epaPriors: await loadEpaPriors(season, epa) };

  // ---- EPA track (what the team lists show): each team's EPA after every match,
  // and entering every event ----
  const epaVec = (e) => [r1(e.np), r1(e.auto), r1(e.teleop), r1(e.endgame)];
  const epaAfter = new Map(); // match -> Map(team -> [np, auto, teleop, endgame])
  const epaStart = new Map(); // `${code}:${team}` -> np entering the event
  const epaStartVec = new Map(); // same, as [np, auto, teleop, endgame]
  const epaTrack = simulateEpa(matches, ctxEpa, {
    epa,
    onBefore: (x, v) => {
      for (const t of [...x.red, ...x.blue]) if (!epaStart.has(`${x.ev.code}:${t}`)) {
        epaStart.set(`${x.ev.code}:${t}`, v.epa(t).np);
        epaStartVec.set(`${x.ev.code}:${t}`, epaVec(v.epa(t)));
      }
    },
    onMatch: (x, v) => epaAfter.set(x, new Map([...x.red, ...x.blue].map((t) => [t, epaVec(v.epa(t))]))),
  });

  const history = new Map(); // team -> [entries]
  const eventStart = new Map(); // `${code}:${team}` -> epa before first match there
  const predByMatch = new Map(); // `${code}:${id}` -> pre-match prediction

  const eventAvg = new Map(); // event code -> season averages when the event started
  const { model, acc } = simulate(matches, { season, params, baseline, priors, cv, soloComps, movedSpec, parkedSpec, rookieZ }, (x, pre, model, before, avgBefore) => {
    if (!eventAvg.has(x.ev.code)) eventAvg.set(x.ev.code, avgBefore);
    predByMatch.set(`${x.ev.code}:${x.m.id}`, pre);
    for (const [side, mine, theirs] of [["red", x.red, x.blue], ["blue", x.blue, x.red]]) {
      const pWin = side === "red" ? pre.pRed : 1 - pre.pRed;
      for (const t of mine) {
        const key = `${x.ev.code}:${t}`;
        if (!eventStart.has(key)) eventStart.set(key, before.get(t));
        if (!history.has(t)) history.set(t, []);
        history.get(t).push({
          ev: x.ev.code, m: x.m.description, elim: x.elim, time: x.time, ...(UNOFFICIAL.has(x.ev.type) ? { off: 1 } : {}),
          side, partners: mine.filter((n) => n !== t), opps: theirs,
          pWin: r3(pWin), score: x.actual[side].total, oppScore: x.actual[side === "red" ? "blue" : "red"].total,
          pred: [r1(pre[side].total), r1(pre[side === "red" ? "blue" : "red"].total)],
          // bonus RPs: [predicted chance >50%, earned] per RP, for the dot display
          rp: x.elim || !hasRp ? null : pre[side].rp.map((p, i) => (p > 0.5 ? 1 : 0) + (x.actual[side].rp[i] ? 2 : 0)),
          orp: x.elim || !hasRp ? null : pre[side === "red" ? "blue" : "red"].rp.map((p, i) => (p > 0.5 ? 1 : 0) + (x.actual[side === "red" ? "blue" : "red"].rp[i] ? 2 : 0)),
          epa: epaAfter.get(x).get(t), // EPA track (pWin / pred above are the prediction track)
          // this robot's own points from each per-robot element (SEASONS[season].solo), quals only
          ...(x.actual[side].solo && mine.length === 2 ? { solo: x.actual[side].solo.map((pair) => pair[mine.indexOf(t)]) } : {}),
        });
      }
    }
  });

  // ---- head-to-head with OPR, and accuracy over the season ----
  const opr = oprPredictions(matches, { winScale: model.p.winScale, baselineTeam: (baseline.auto + baseline.teleop + baseline.endgame) / 2 });
  const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
  const eloP = elo(matches, 64), avgP = avgScore(matches, 0.28);
  const cmp = { epa: { c: 0, b: 0 }, opr: { c: 0, b: 0 }, elo: { c: 0, b: 0 }, avg: { c: 0, b: 0 }, n: 0 };
  const months = new Map();
  for (const x of matches) {
    const o = outcome(x), pe = predByMatch.get(`${x.ev.code}:${x.m.id}`).pRed, po = opr.get(x).pRed;
    cmp.n++;
    for (const [k, p] of [["epa", pe], ["opr", po], ["elo", eloP.get(x)], ["avg", avgP.get(x)]]) {
      cmp[k].b += (p - o) ** 2;
      if (o !== 0.5 && (p > 0.5) === (o === 1)) cmp[k].c++;
    }
    const key = new Date(x.time).toISOString().slice(0, 7);
    if (!months.has(key)) months.set(key, { n: 0, c: 0, o: 0 });
    const mo = months.get(key);
    mo.n++;
    if (o !== 0.5 && (pe > 0.5) === (o === 1)) mo.c++;
    if (o !== 0.5 && (po > 0.5) === (o === 1)) mo.o++;
  }
  const compare = {
    epa: { accuracy: r3(cmp.epa.c / cmp.n), brier: r3(cmp.epa.b / cmp.n) },
    opr: { accuracy: r3(cmp.opr.c / cmp.n), brier: r3(cmp.opr.b / cmp.n) },
    elo: { accuracy: r3(cmp.elo.c / cmp.n), brier: r3(cmp.elo.b / cmp.n) },
    avg: { accuracy: r3(cmp.avg.c / cmp.n), brier: r3(cmp.avg.b / cmp.n) },
    byMonth: [...months].filter(([, m]) => m.n >= 200).map(([month, m]) => ({ month, matches: m.n, epa: r3(m.c / m.n), opr: r3(m.o / m.n) })),
  };

  const out = path.join("site", "data", String(season));
  // videos.json / alliances.json come from other scripts (videos.mjs, alliances.mjs); keep them
  const keep = {};
  for (const f of ["videos.json", "alliances.json"]) keep[f] = await fs.readFile(path.join(out, f)).catch(() => null);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  for (const [f, buf] of Object.entries(keep)) if (buf) await fs.writeFile(path.join(out, f), buf);
  if (keep["videos.json"]) await splitVideos(out, JSON.parse(keep["videos.json"]));

  // ---- team info gathered from event rosters ----
  const info = new Map();
  const teamEvents = new Map();
  const byStart = [...events].sort((a, b) => a.start.localeCompare(b.start));
  for (const ev of byStart) {
    for (const tp of ev.teams) {
      const loc = tp.team?.location;
      info.set(tp.teamNumber, {
        name: tp.team?.name ?? "",
        loc: loc ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ") : "",
        country: loc?.country ?? "",
        rookie: tp.team?.rookieYear ?? null,
      });
      if (!teamEvents.has(tp.teamNumber)) teamEvents.set(tp.teamNumber, []);
      teamEvents.get(tp.teamNumber).push({ ev, stats: tp.stats });
    }
  }

  // ---- teams.json: compact table of every team that played ----
  // Ranked by the EPA track (e); p is the prediction track, kept for priors and the
  // home page's predicted dream match. Official ratings: off-season matches don't
  // count unless the EPA params say so (see UNOFFICIAL, EPA shared.offWeight).
  const byRating = (k, split) => (a, b) => (split ? (b[k].n > 0) - (a[k].n > 0) : 0) || b[k].np - a[k].np;
  const ranked = [...history.keys()].filter((t) => !isPlaceholder(t))
    .map((t) => ({ t, e: epaTrack.rate(t), p: model.epa(t), h: history.get(t) }))
    // teams with only off-season matches have no official rating yet: list them last
    .sort(byRating("e", true));
  // np/auto/teleop/endgame: EPA track. pnp..pendgame, rp0-2: prediction track;
  // prank: order by prediction rating (ties in the rounded pnp keep it, for priors)
  const cols = ["team", "name", "loc", "country", "np", "auto", "teleop", "endgame", "rp0", "rp1", "rp2",
    "matches", "wins", "losses", "ties", "events", "trend", "pnp", "pauto", "pteleop", "pendgame", "prank", "cons", "sos", "sosPlaces"];
  const predRank = (list, split) => new Map([...list].sort(byRating("p", split)).map((x, i) => [x.t, i]));
  // Strength of schedule (site/js/sos.js): how hard each team's qualification draws
  // were, 0-1 (the chance a random schedule would have been easier), on ranking points,
  // plus the ranking places that cost. Ratings as teams entered each event.
  const byEvent = new Map();
  for (const x of matches) {
    if (x.elim) continue;
    if (!byEvent.has(x.ev.code)) byEvent.set(x.ev.code, { ev: x.ev, quals: [], np: 0, n: 0 });
    const g = byEvent.get(x.ev.code);
    g.quals.push({ red: x.red, blue: x.blue });
    for (const sd of ["red", "blue"]) if (Number.isFinite(x.actual?.[sd]?.np)) { g.np += x.actual[sd].np; g.n++; }
  }
  const sosAcc = { official: new Map(), all: new Map() };
  for (const { ev, quals, np, n } of byEvent.values()) {
    if (!n) continue;
    const ratings = new Map();
    for (const t of new Set(quals.flatMap((q) => [...q.red, ...q.blue]))) {
      const e = epaStart.get(`${ev.code}:${t}`);
      if (e != null) ratings.set(t, { epa: e, rp: eventStart.get(`${ev.code}:${t}`)?.rp ?? [] });
    }
    const opts = { winRp: cfg.winRp ?? 2, rankBy: cfg.rankBy, scale: 0.28 * (np / n) };
    if (!UNOFFICIAL.has(ev.type)) addEventSos(sosAcc.official, ratings, quals, opts);
    addEventSos(sosAcc.all, ratings, quals, opts);
  }
  const sosOf = (t, official) => { const a = (official ? sosAcc.official : sosAcc.all).get(t), v = sosValue(a); return v == null ? null : [r3(v), r1(sosPlaces(a) ?? 0)]; };
  const tableRows = (list, official, prank) => list.map(({ t, e, p, h }) => {
    const hh = official ? h.filter((x) => !x.off) : h;
    let w = 0, l = 0, ti = 0;
    for (const x of hh) x.score > x.oppScore ? w++ : x.score < x.oppScore ? l++ : ti++;
    const i = info.get(t) ?? {};
    const evs = new Set(hh.map((x) => x.ev)).size;
    // EPA change over the last 10 matches
    const prev = hh.length > 10 ? hh[hh.length - 11].epa[0] : hh.length ? hh[0].epa[0] : e.np;
    // consistency: how far its alliance's score typically lands from our prediction,
    // as a share of the predicted score (lower = steadier); needs 5+ predicted matches
    const fit = hh.filter((x) => x.pred && x.pred[0] > 0);
    const cons = fit.length >= 5
      ? Math.sqrt(fit.reduce((s, x) => s + (x.score - x.pred[0]) ** 2, 0) / fit.length) / (fit.reduce((s, x) => s + x.pred[0], 0) / fit.length)
      : null;
    return [t, i.name ?? "", i.loc ?? "", i.country ?? "", r1(e.np), r1(e.auto), r1(e.teleop), r1(e.endgame),
      ...p.rp.map(r3), hh.length, w, l, ti, evs, r1(e.np - prev),
      r1(p.np), r1(p.auto), r1(p.teleop), r1(p.endgame), prank.get(t), cons == null ? null : r3(cons), ...(sosOf(t, official) ?? [null, null])];
  });
  const rows = tableRows(ranked, true, predRank(ranked, true));
  await writeJson(path.join(out, "teams.json"), { cols, rows });
  // the team page radar ranks a team among teams with 5+ matches; ship 101 quantiles
  // of each axis (meta.radarDist) instead of making the page load teams.json
  const quant = (xs) => {
    const v = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
    return v.length ? Array.from({ length: 101 }, (_, q) => r3(v[Math.round((q / 100) * (v.length - 1))])) : [];
  };
  const radarPool = rows.filter((r) => r[11] >= 5);
  const clamp01 = (x) => Math.min(1, Math.max(0, x ?? 0));
  const radarDist = {
    auto: quant(radarPool.map((r) => r[5])), teleop: quant(radarPool.map((r) => r[6])), endgame: quant(radarPool.map((r) => r[7])),
    rp: quant(radarPool.map((r) => cfg.rpNames.reduce((sum, _, i) => sum + clamp01(r[8 + i]), 0))),
    cons: quant(radarPool.map((r) => (r[22] == null ? null : -r[22]))),
    win: quant(radarPool.map((r) => (r[11] ? (r[12] + r[14] / 2) / r[11] : null))),
  };
  const consOf = new Map(rows.map((r) => [r[0], r[22]]));

  // Teams from last season that haven't played this season yet, with the EPA the
  // model starts them on (carried over from past seasons), so Compete can use them
  const last = await fs.readFile(path.join("site", "data", String(season - 1), "teams.json"), "utf8").then(JSON.parse).catch(() => null);
  if (last) {
    const c = (k) => last.cols.indexOf(k);
    const pre = last.rows.filter((r) => !history.has(r[0]) && !isPlaceholder(r[0])).map((r) => {
      const t = r[0], e = epaTrack.rate(t), p = model.epa(t), i = info.get(t);
      return [t, i?.name || r[c("name")], i?.loc || r[c("loc")], r1(e.np), r1(e.auto), r1(e.teleop), r1(e.endgame),
        r1(p.np), r1(p.auto), r1(p.teleop), r1(p.endgame), ...p.rp.map(r3)];
    }).sort((a, b) => b[3] - a[3]);
    await writeJson(path.join(out, "teams-pre.json"), {
      cols: ["team", "name", "loc", "np", "auto", "teleop", "endgame", "pnp", "pauto", "pteleop", "pendgame", "rp0", "rp1", "rp2"], rows: pre,
    });
  }

  // Off-season tables (OFF_TABLES): the same table with off-season events counted
  // at OFF_WEIGHT, through MTI or all of them, minus excluded events. Only written
  // when the season has off-season matches; meta.offTables names each table's file.
  const offTables = { official: OFF_TABLES.official.file, mti: OFF_TABLES.official.file, full: OFF_TABLES.official.file };
  const mti = mtiCode(events);
  // modified-rules events, judged against the official EPAs at season end
  const offFlagged = flagOffseason(matches, epaTrack.rate, new Set(epa.shared.offTypes), epa.shared.offFlag);
  const offEvents = [...new Map(matches.filter((x) => epa.shared.offTypes.includes(x.ev.type)).map((x) => [x.ev.code, x.ev])).values()];
  const excludeW = offWeights(matches, { offWeight: 1, offExclude: epa.shared.offExclude }, offFlagged);
  const offExcluded = offEvents.filter((ev) => !excludeW(ev)).map((ev) => ev.code).sort();
  if (offEvents.length) {
    for (const key of ["mti", "full"]) {
      const shared = { ...OFF_TABLES[key].shared, offCutoff: OFF_TABLES[key].shared.offCutoff === "MTI" ? mti : OFF_TABLES[key].shared.offCutoff };
      const epaT = epaParams({ ...epaOver, shared: { ...epaOver.shared, ...shared } });
      // prediction-track columns (pnp.., next season's prediction priors): off-season
      // events at OFF_WEIGHT up to the cutoff, no exclusions (as before the presets)
      const { model: allModel } = simulate(matches, { season, params, baseline, priors, cv, soloComps, movedSpec, parkedSpec, rookieZ,
        offWeight: offWeights(matches, { offWeight: shared.offWeight, offCutoff: shared.offCutoff }) });
      const allHist = new Map();
      const cutStart = shared.offCutoff ? events.find((e) => e.code === shared.offCutoff)?.start : null;
      const allEpa = simulateEpa(matches, ctxEpa, {
        epa: epaT, offFlagged,
        onMatch: (x, v) => {
          if (cutStart && x.ev.start > cutStart && UNOFFICIAL.has(x.ev.type)) return; // after the cutoff: not in this table
          for (const side of ["red", "blue"]) for (const t of x[side]) {
            if (!allHist.has(t)) allHist.set(t, []);
            allHist.get(t).push({ ev: x.ev.code, score: x.actual[side].total, oppScore: x.actual[side === "red" ? "blue" : "red"].total, epa: [r1(v.epa(t).np)] });
          }
        },
      });
      const rankedAll = [...allHist.keys()].filter((t) => !isPlaceholder(t))
        .map((t) => ({ t, e: allEpa.rate(t), p: allModel.epa(t), h: allHist.get(t) }))
        .sort(byRating("e", false));
      offTables[key] = OFF_TABLES[key].file;
      await writeJson(path.join(out, offTables[key]), { cols, rows: tableRows(rankedAll, false, predRank(rankedAll, false)) });
    }
  }

  // ---- per-team files, bundled 10 teams to a file (team/<number / 10>x.json: 1919x = 19190-19199) ----
  const rankOf = new Map(ranked.map((x, i) => [x.t, i + 1]));
  // world / country / state ranks for the team page tiles (so it needn't load teams.json)
  const stateOf = (t) => { const p = (info.get(t)?.loc ?? "").split(", "); return p.length >= 3 ? p[p.length - 2] : null; };
  const placeRanks = new Map();
  for (const [key, group] of [["country", (t) => info.get(t)?.country || null], ["state", (t) => (info.get(t)?.country && stateOf(t) ? `${info.get(t).country}|${stateOf(t)}` : null)]]) {
    const counts = new Map(), seen = new Map();
    for (const x of ranked) { const g = group(x.t); if (g) counts.set(g, (counts.get(g) ?? 0) + 1); }
    for (const x of ranked) {
      const g = group(x.t);
      if (!g) continue;
      seen.set(g, (seen.get(g) ?? 0) + 1);
      if (!placeRanks.has(x.t)) placeRanks.set(x.t, {});
      placeRanks.get(x.t)[key] = [key === "state" ? g.split("|")[1] : g, seen.get(g), counts.get(g)];
    }
  }
  // each event's highest combined score (both alliances, with fouls): the team page tints that match gold
  const evHigh = new Map();
  for (const x of matches) {
    const s = x.actual.red.total + x.actual.blue.total;
    if (Number.isFinite(s) && s > (evHigh.get(x.ev.code) ?? -1)) evHigh.set(x.ev.code, s);
  }
  const buckets = new Map();
  for (const { t, e, p, h } of ranked) {
    const evs = (teamEvents.get(t) ?? []).map(({ ev, stats }) => {
      const mine = h.filter((x) => x.ev === ev.code);
      const startEpa = epaStart.get(`${ev.code}:${t}`);
      return {
        code: ev.code, name: ev.name, type: ev.type, start: ev.start,
        rank: stats?.rank ?? null, wins: stats?.wins ?? null, losses: stats?.losses ?? null, ties: stats?.ties ?? null,
        epaStart: startEpa != null ? r1(startEpa) : null,
        epaEnd: mine.length ? mine[mine.length - 1].epa[0] : null,
        high: evHigh.get(ev.code) ?? null,
      };
    });
    const bucket = Math.floor(t / 10);
    if (!buckets.has(bucket)) buckets.set(bucket, {});
    buckets.get(bucket)[t] = {
      team: t, ...(info.get(t) ?? {}), rank: rankOf.get(t), of: ranked.length, places: placeRanks.get(t) ?? {}, cons: consOf.get(t) ?? null,
      // epa: EPA track (bonus-RP chances from the prediction track); pred: prediction track
      epa: { ...epaRow({ ...e, rp: p.rp }) }, pred: epaRow(p), matches: h, events: evs,
    };
  }
  // season awards per team (from scripts/fetch-awards.mjs), newest event first
  const awardsBy = await loadAwards(season, events);
  for (const teams of buckets.values()) for (const t of Object.values(teams)) if (awardsBy.has(t.team)) t.awards = awardsBy.get(t.team);
  for (const [bucket, teams] of buckets) await writeJson(path.join(out, "team", `${bucket}x.json`), teams);

  // ---- events ----
  const evList = [];
  for (const ev of events) {
    // parent events with divisions list every division's teams; keep only the
    // teams that actually played in this event's own matches
    const inMatches = new Set(ev.matches.flatMap((m) => m.teams.map((t) => t.teamNumber)));
    const roster = inMatches.size ? ev.teams.filter((tp) => inMatches.has(tp.teamNumber)) : ev.teams;
    const teams = roster.filter((tp) => !isPlaceholder(tp.teamNumber)).map((tp) => {
      const e = history.has(tp.teamNumber) ? epaTrack.rate(tp.teamNumber) : null;
      // prediction rating entering the event; for teams that haven't played here yet, their current rating
      // teams yet to play this season get their starting rating from past seasons
      // (with p.grow, apply the between-event growth on a throwaway fork, as simulate() would at its first match)
      const start = eventStart.get(`${ev.code}:${tp.teamNumber}`) ?? (model.p.grow ? grown(model, ev.code, tp.teamNumber) : model.epa(tp.teamNumber));
      const eStart = epaStart.get(`${ev.code}:${tp.teamNumber}`) ?? epaTrack.rate(tp.teamNumber).np;
      const h = history.get(tp.teamNumber)?.filter((x) => x.ev === ev.code) ?? [];
      return {
        team: tp.teamNumber, name: tp.team?.name ?? "",
        rank: tp.stats?.rank ?? null, rp: tp.stats?.rp ?? null,
        wins: tp.stats?.wins ?? null, losses: tp.stats?.losses ?? null, ties: tp.stats?.ties ?? null,
        epaStart: r1(eStart), // EPA track
        // full prediction-model state entering the event, so the site can replay it live
        state: start ? {
          auto: r1(start.shared.auto), teleop: r1(start.shared.teleop), endgame: r1(start.shared.endgame),
          solo: start.solo.map(r1), n: start.n, v: r3(start.v), rp: start.rp.map(r3), ev: start.ev ?? null,
          evStart: start.evStart ? Object.fromEntries(Object.entries(start.evStart).map(([k, v]) => [k, r1(v)])) : null,
          ...(start.zone ? { zone: start.zone.map(r3) } : {}),
        } : null,
        epaEnd: h.length ? h[h.length - 1].epa[0] : null,
        // [np, auto, teleop, endgame] entering the event and after its last match here, for the pick map
        epaIn: epaStartVec.get(`${ev.code}:${tp.teamNumber}`) ?? epaVec(epaTrack.rate(tp.teamNumber)),
        epaOut: h.length ? h[h.length - 1].epa : null,
        epaNow: e ? { np: r1(e.np), auto: r1(e.auto), teleop: r1(e.teleop), endgame: r1(e.endgame) } : null,
      };
    });
    const read = cfg.read;
    let correct = 0, decided = 0;
    const ms = ev.matches
      .slice()
      .sort((a, b) => matchTime(ev, a) - matchTime(ev, b) || a.id - b.id)
      .map((m) => {
        const red = allianceTeams(m, "Red"), blue = allianceTeams(m, "Blue");
        const redOn = onField(m, "Red"), blueOn = onField(m, "Blue");
        const played = isPlayed(m);
        let pre = predByMatch.get(`${ev.code}:${m.id}`);
        // unplayed matches get a prediction from current ratings; a played match the
        // model skipped (bad on-field data) gets none, rather than one that knows the result
        if (!pre && !played && redOn.length && blueOn.length) pre = model.predict(redOn, blueOn);
        const res = played ? { red: read(m.scores.red), blue: read(m.scores.blue) } : null;
        if (res && pre && res.red.total !== res.blue.total) {
          decided++;
          if ((pre.pRed > 0.5) === (res.red.total > res.blue.total)) correct++;
        }
        const isQual = m.tournamentLevel === "Quals";
        const sc = (a, raw) => ({
          np: a.np, total: a.total, auto: a.auto, teleop: a.teleop, endgame: a.endgame, rp: hasRp ? a.rp : null,
          ...(isQual && fits.length ? { solo: soloPoints(season, raw, fits) } : {}),
        });
        const same = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
        const surr = m.teams.filter((t) => t.surrogate).map((t) => t.teamNumber);
        return {
          id: m.id, d: m.description, level: m.tournamentLevel, time: matchTime(ev, m),
          red, blue, played,
          // who actually played, when that differs from the alliance (elims, no-shows)
          ...(!same(red, redOn) || !same(blue, blueOn) ? { redOn, blueOn } : {}),
          ...(surr.length ? { surr } : {}), // surrogate appearances don't count for ranking
          redScore: res ? sc(res.red, m.scores.red) : null,
          blueScore: res ? sc(res.blue, m.scores.blue) : null,
          pred: pre ? {
            pRed: r3(pre.pRed),
            red: { np: r1(pre.red.np), total: r1(pre.red.total), auto: r1(pre.red.auto), teleop: r1(pre.red.teleop), endgame: r1(pre.red.endgame), rp: hasRp ? pre.red.rp.map(r3) : null },
            blue: { np: r1(pre.blue.np), total: r1(pre.blue.total), auto: r1(pre.blue.auto), teleop: r1(pre.blue.teleop), endgame: r1(pre.blue.endgame), rp: hasRp ? pre.blue.rp.map(r3) : null },
          } : null,
        };
      });
    const top = teams.map((t) => t.epaNow?.np ?? 0).sort((a, b) => b - a);
    const strength = top.length ? r1(top.slice(0, 8).reduce((a, b) => a + b, 0) / Math.min(8, top.length)) : 0;
    const loc = ev.location ? [ev.location.city, ev.location.state, ev.location.country].filter(Boolean).join(", ") : "";
    const summary = {
      code: ev.code, name: ev.name, type: ev.type, start: ev.start, end: ev.end, loc,
      teams: teams.length, matches: ms.length, played: ms.filter((m) => m.played).length,
      finished: ev.finished, ongoing: ev.ongoing, strength,
      accuracy: decided ? r3(correct / decided) : null,
      topTeam: teams.reduce((b, t) => ((t.epaNow?.np ?? -1) > (b?.epaNow?.np ?? -1) ? t : b), null)?.team ?? null,
    };
    evList.push(summary);
    const av = eventAvg.get(ev.code) ?? model.avg;
    // season averages when the event started, so the browser can replay it exactly
    const avg = { auto: r1(av.auto), teleop: r1(av.teleop), endgame: r1(av.endgame), foul: r1(av.foul), errVar: r1(av.errVar), foulDiffVar: r1(av.foulDiffVar), solo: av.solo.map(r1), rp: av.rp.map(r3),
      clipVar: Object.fromEntries(Object.entries(av.clipVar ?? model.errVar).map(([k, v]) => [k, r1(v)])), cal: av.cal ?? model.cal,
      ...(av.zLeave != null ? { zLeave: r3(av.zLeave), zB0: r3(av.zB0), zB1: r3(av.zB1), zB2: r3(av.zB2) } : {}) };
    await writeJson(path.join(out, "event", `${ev.code}.json`), { ...summary, timezone: ev.timezone, avg, teamList: teams, matchList: ms });
  }
  evList.sort((a, b) => b.start.localeCompare(a.start) || b.strength - a.strength);
  await writeJson(path.join(out, "events.json"), evList);
  // small file so the home page loads without the full team/event lists
  await writeJson(path.join(out, "summary.json"), {
    cols, top: rows.slice(0, 10),
    live: evList.filter((e) => e.ongoing),
    recent: evList.filter((e) => e.finished).slice(0, 8),
    strongest: [...evList].filter((e) => e.teams >= 10).sort((a, b) => b.strength - a.strength).slice(0, 8),
  });

  // ---- season meta ----
  const nps = rows.map((r) => r[4]);
  const pct = (p) => nps[Math.floor((1 - p) * (nps.length - 1))];
  // scale for the team page meters: the best values among the top 50 teams
  const top50 = ranked.slice(0, 50).map((x) => x.e);
  const meterMax = Object.fromEntries(["np", "auto", "teleop", "endgame"].map((k) => [k, r1(Math.max(...top50.map((e) => e[k]), 1))]));
  const meta = {
    meterMax, radarDist,
    season, game: cfg.game, rpNames: cfg.rpNames, generated: new Date().toISOString(),
    teams: rows.length, events: events.length, matches: matches.length,
    accuracy: Object.fromEntries(Object.entries(summarize(acc)).map(([k, v]) => [k, hasRp || k === "calib" ? v : { ...v, rpBrier: null }])),
    compare,
    percentiles: { p99: pct(0.99), p90: pct(0.9), p75: pct(0.75), p50: pct(0.5), p25: pct(0.25) },
    avgAlliance: {
      auto: r1(model.avg.auto), teleop: r1(model.avg.teleop), endgame: r1(model.avg.endgame), foul: r1(model.avg.foul),
      errVar: r1(model.avg.errVar), foulDiffVar: r1(model.avg.foulDiffVar),
      clipVar: Object.fromEntries(Object.entries(model.errVar).map(([k, v]) => [k, r1(v)])), cal: model.cal,
      solo: model.avg.solo.map(r1),
      np: r1(model.avgAllianceNp()), rp: model.avg.rp.map(r3),
      ...(model.avg.zLeave != null ? { zLeave: r3(model.avg.zLeave), zB0: r3(model.avg.zB0), zB1: r3(model.avg.zB1), zB2: r3(model.avg.zB2) } : {}),
    },
    // prediction track (live replay builds its model from this)
    model: { ...model.p, baseline: { ...baseline, rp: baseline.rp.map(r3) }, cv: r3(cv), priors: priors.size },
    epaModel: { ...epa, priors: ctxEpa.epaPriors.priors.size }, // EPA (display) track
    // team tables per off-season setting (file names), MTI's code, off-season events left out of them
    offTables, mti, offExcluded,
    // per-robot scoring elements and their learned point values
    solo: fits.map((f) => ({ comp: f.comp, label: f.label, moved: f.moved, parked: f.parked, robots: f.robots, values: f.values, exact: r3(f.exact) })),
  };
  await writeJson(path.join(out, "meta.json"), meta);
  return meta;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seasons = process.argv.slice(2).map(Number);
  // EPA_PARAMS=file.json: EPA-track overrides ({ shared, auto, teleop, endgame }) for a trial build
  const epaOver = process.env.EPA_PARAMS ? JSON.parse(await fs.readFile(process.env.EPA_PARAMS, "utf8")) : {};
  for (const s of seasons.length ? seasons : [2025, 2026]) {
    const meta = await build(s, {}, epaOver);
    console.log(s, `${meta.teams} teams, ${meta.events} events, ${meta.matches} matches`);
    console.log(JSON.stringify(meta.accuracy, null, 1));
  }
  const all = await fs.readdir(path.join("site", "data")).catch(() => []);
  const built = all.filter((d) => /^\d{4}$/.test(d)).map(Number).sort((a, b) => b - a);
  await writeJson(path.join("site", "data", "seasons.json"), built);
  // the site opens on the newest season
  const metas = await Promise.all(built.map((s) => fs.readFile(path.join("site", "data", String(s), "meta.json"), "utf8").then(JSON.parse)));
  const def = built[0];
  await writeJson(path.join("site", "data", "index.json"), { seasons: built, default: def, games: Object.fromEntries(metas.map((m) => [m.season, m.matches])) });
}


// team number -> [{ ev, evName, start, type, placement }] for the season
async function loadAwards(season, events) {
  const dir = path.join(".cache", "awards", String(season));
  const byTeam = new Map();
  for (const ev of events) {
    const list = await fs.readFile(path.join(dir, `${ev.code}.json`), "utf8").then(JSON.parse).catch(() => []);
    for (const a of list) {
      if (!a.teamNumber) continue;
      if (!byTeam.has(a.teamNumber)) byTeam.set(a.teamNumber, []);
      byTeam.get(a.teamNumber).push({ ev: ev.code, evName: ev.name, start: ev.start, type: a.type, placement: a.placement });
    }
  }
  for (const list of byTeam.values()) list.sort((a, b) => b.start.localeCompare(a.start));
  return byTeam;
}
