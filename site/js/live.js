// Event replay, live updates, and ranking forecasts — all in the browser.

import { Model, allianceTeams, onField } from "./model.js";
import { SEASONS, eventQuery, API, soloPoints } from "./seasons.js";
import { qualPts, selectionPts, allianceCount, PLAYOFF_PTS } from "./advancement.js";
import { playoffs, TEMPLATES } from "./playoffs.js";

export async function fetchLiveEvent(season, code) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: eventQuery(season), variables: { season: Number(season), code } }),
  });
  const json = await res.json();
  if (json.errors || !json.data?.eventByCode) throw new Error("live fetch failed");
  return json.data.eventByCode;
}

// A model set up like the build's, from a season's meta.json. Pass `avg` (an
// event file's season averages at its start) to replay that event exactly.
// `evType`: the event's type (zone-RP thresholds differ at championships).
export function modelFromMeta(meta, avg, evType = null) {
  const a = avg ?? meta.avgAlliance;
  return new Model({
    baseline: { auto: a.auto, teleop: a.teleop, endgame: a.endgame, foul: a.foul, errVar: a.errVar, foulDiffVar: a.foulDiffVar, rp: a.rp, solo: a.solo ?? [], clipVar: a.clipVar, cal: a.cal,
      ...(a.zLeave != null ? { zLeave: a.zLeave, zB0: a.zB0, zB1: a.zB1, zB2: a.zB2 } : {}) },
    zoneRp: SEASONS[meta.season]?.zoneRp ?? null,
    eventType: () => evType,
    soloComps: (meta.solo ?? []).map((s) => s.comp),
    movedSpec: (meta.solo ?? []).findIndex((s) => s.moved),
    parkedSpec: (meta.solo ?? []).findIndex((s) => s.parked),
  });
}

// FTCScout's raw event -> the same match shape the static event files use.
export function normalizeLive(season, ev, meta) {
  const read = SEASONS[season].read;
  const time = (m) => Date.parse(m.actualStartTime ?? m.scheduledStartTime ?? `${ev.start}T12:00:00Z`) || 0;
  return ev.matches
    .slice()
    .sort((a, b) => time(a) - time(b) || a.id - b.id)
    .map((m) => {
      const side = (al) => allianceTeams(m, al);
      const on = (al) => onField(m, al);
      const played = m.hasBeenPlayed && !!m.scores?.red;
      const isQual = m.tournamentLevel === "Quals";
      const sc = (raw) => {
        const { raw: _, ...a } = read(raw);
        return { ...a, solo: isQual && meta?.solo?.length ? soloPoints(season, raw, meta.solo) : null };
      };
      return {
        id: m.id, d: m.description, level: m.tournamentLevel, time: time(m),
        red: side("Red"), blue: side("Blue"), redOn: on("Red"), blueOn: on("Blue"),
        surr: m.teams.filter((t) => t.surrogate).map((t) => t.teamNumber),
        played, redScore: played ? sc(m.scores.red) : null, blueScore: played ? sc(m.scores.blue) : null,
      };
    });
}

// Re-run the model over an event's matches, starting from each team's rating
// entering the event. Only the first `cutoff` quals count as played; later
// matches are predicted with ratings frozen at that point.
export function replayEvent(meta, ev, matches, cutoff = Infinity) {
  const model = modelFromMeta(meta, ev.avg, ev.type);
  for (const t of ev.teamList) if (t.state) model.setTeam(t.team, t.state);
  let quals = 0, frozen = false;
  const out = matches.map((m) => {
    const isQual = m.level === "Quals";
    if (isQual && quals++ >= cutoff) frozen = true;
    const red = m.redOn ?? m.red, blue = m.blueOn ?? m.blue;
    if (!red.length || !blue.length) return { ...m, pred: null };
    const usePlayed = m.played && !frozen;
    const pre = usePlayed
      ? model.update(red, blue, { red: m.redScore, blue: m.blueScore }, !isQual, ev.code)
      : model.predict(red, blue);
    return {
      ...m,
      played: usePlayed,
      actuallyPlayed: m.played,
      pred: { pRed: pre.pRed, red: pre.red, blue: pre.blue },
    };
  });
  return { model, matches: out };
}

const SCORE_NOISE = 0.47; // score spread / average alliance score, measured 2020-2025
// spread of the tiebreaker field around its prediction / its average, per match
// (2019-2025 quals: auto 0.54-0.70, match points without fouls 0.37-0.45)
const TB_NOISE = { auto: 0.65, np: 0.4 };

// Plays out simulated matches for both forecasts.
// - Each simulated event first draws every team's "true" strength from the
//   model's uncertainty about it (variance v, scaled by `corr`), so one team's
//   matches move together: a team that's better than its rating is better all
//   event. Per-match odds are sharpened to keep each match's overall win
//   probability unchanged.
// - The tiebreaker is played out from simulated alliance scores in the field
//   the season actually breaks ties on (SEASONS[season].tiebreak).
// Ranking points an alliance earned in a played qual (its score, in seasons ranked by score).
function earnedRp(season, own, opp) {
  const { winRp, tieRp, rankBy } = SEASONS[season];
  if (rankBy === "score") return own.total;
  return (own.total > opp.total ? winRp : own.total === opp.total ? tieRp : 0) + (own.rp ?? []).filter(Boolean).length;
}
// The tiebreaker points an alliance earned in a played match.
function earnedTb(season, own, opp) {
  const field = SEASONS[season].tiebreak ?? "np";
  return field === "losingNp" ? Math.min(own.np, opp.np) : own[field] ?? own.np;
}

// Qualification standings from the quals played so far in `matches`, by the
// season's rules: ranking score (average RP, or total score where `rankBy` is
// "score"), then the average tiebreaker. Surrogate appearances don't count.
// Deeper tiebreakers aren't modelled, so teams still tied fall back to their
// official final rank (`finalRank`, team -> rank) when it's known. Checked on
// every saved event: final standings match the official ranks for 98-99.98%
// of teams in each finished season (2019-2025), and W-L-T records for 99.8%.
// -> Map team -> { rank, rs, played, wins, losses, ties }; teams yet to play have rank null.
export function standings(season, teams, matches, finalRank = new Map()) {
  const { rankBy, dropLowestTb } = SEASONS[season];
  const byScore = rankBy === "score";
  const st = new Map(teams.map((t) => [t, { rp: 0, tbs: [], played: 0, wins: 0, losses: 0, ties: 0 }]));
  for (const m of matches) {
    if (m.level !== "Quals" || !m.played || !m.redScore || !m.blueScore) continue;
    const r = m.redScore, b = m.blueScore;
    for (const [side, own, opp] of [["red", r, b], ["blue", b, r]]) {
      for (const t of m[side]) {
        const s = st.get(t);
        if (!s || (m.surr ?? []).includes(t)) continue;
        s.rp += earnedRp(season, own, opp);
        s.tbs.push(earnedTb(season, own, opp));
        s.played++;
        if (own.total > opp.total) s.wins++; else if (own.total < opp.total) s.losses++; else s.ties++;
      }
    }
  }
  for (const s of st.values()) {
    s.rs = !s.played ? null : byScore ? s.rp : s.rp / s.played;
    const tbs = dropLowestTb && s.tbs.length >= dropLowestTb ? [...s.tbs].sort((x, y) => x - y).slice(1) : s.tbs;
    s.tb = tbs.length ? tbs.reduce((x, y) => x + y, 0) / tbs.length : 0;
    s.rank = null;
  }
  const last = (t) => finalRank.get(t) ?? 1e9;
  [...st].filter(([, s]) => s.played)
    .sort(([ta, a], [tb, b]) => b.rs - a.rs || b.tb - a.tb || last(ta) - last(tb))
    .forEach(([, s], i) => (s.rank = i + 1));
  return st;
}

function makeSim(season, model, { corr = 1, tb = "sim" } = {}) {
  const { winRp, rpNames } = SEASONS[season];
  const field = SEASONS[season].tiebreak ?? "np";
  const valueField = field === "losingNp" ? "np" : field;
  const avgNp = model ? Math.max(10, model.avgAllianceNp()) : 0;
  const scale = model ? model.p.winScale * avgNp : 0;
  const spread2 = (scale * Math.PI / Math.sqrt(3)) ** 2; // variance of a logistic with this scale
  // a rating variance of vObs is one match's worth of score noise
  const unit = model ? (SCORE_NOISE * avgNp) ** 2 / model.p.vObs : 0;
  const useCorr = !!model && corr > 0;
  let sd = [], delta = [], avgTb = 0;
  const sim = {
    field,
    // the actual tiebreaker points an alliance earned in a played match
    actualTb: (own, opp) => earnedTb(season, own, opp),
    expectedTb: (pOwn, pOpp) => (field === "losingNp" ? Math.min(pOwn.np, pOpp.np) : pOwn[field] ?? pOwn.np),
    setup(teams, avgField) {
      avgTb = avgField;
      sd = teams.map((t) => (useCorr ? Math.sqrt(corr * (model.teams.get(t)?.v ?? model.p.v0) * unit) : 0));
      delta = sd.map(() => 0);
    },
    newEvent() { for (let i = 0; i < sd.length; i++) delta[i] = sd[i] ? sd[i] * gauss() : 0; },
    // -> [red RP, blue RP, red tiebreak points, blue tiebreak points]
    play(p, red, blue, bonus = true) {
      let pRed = p.pRed, dr = 0, db = 0;
      if (useCorr) {
        let v = 0;
        for (const t of red) { dr += delta[t]; v += sd[t] ** 2; }
        for (const t of blue) { db += delta[t]; v += sd[t] ** 2; }
        const s = scale * Math.sqrt(Math.max(0.1, 1 - v / spread2));
        pRed = 1 / (1 + Math.exp(-(p.red.total - p.blue.total + dr - db) / s));
      }
      const redWins = rand() < pRed;
      let rr = redWins ? winRp : 0, br = redWins ? 0 : winRp;
      if (bonus) for (let k = 0; k < rpNames.length; k++) {
        if (rand() < p.red.rp[k]) rr++;
        if (rand() < p.blue.rp[k]) br++;
      }
      let tr = 0, tbb = 0;
      if (tb === "sim") {
        const noise = (TB_NOISE[valueField] ?? 0.4) * avgTb;
        const frac = valueField === "np" ? 1 : avgTb / Math.max(1, avgNp); // share of a strength surprise that shows in this field
        const vr = p.red[valueField] + frac * dr + noise * gauss();
        const vb = p.blue[valueField] + frac * db + noise * gauss();
        tr = field === "losingNp" ? Math.min(vr, vb) : vr;
        tbb = field === "losingNp" ? Math.min(vr, vb) : vb;
      } else {
        tr = sim.expectedTb(p.red, p.blue); tbb = sim.expectedTb(p.blue, p.red);
      }
      return [rr, br, tr, tbb];
    },
  };
  return sim;
}

// Monte Carlo over the remaining quals. Returns per-team ranking odds.
// Pass the replay's `model` to draw correlated team strengths (see makeSim).
// advancement: { official } (FIRST's alliances, if out) also forecasts advancement points (see makeAdvSim); needs `model`.
export function forecastRankings(season, teams, matches, sims = 3000, { model = null, corr = 1, tb = "sim", advancement = null } = {}) {
  reseed(teams.length * 7919 + matches.length);
  const { rankBy } = SEASONS[season];
  const byScore = rankBy === "score";
  const sim = makeSim(season, model, { corr, tb });
  const idx = new Map(teams.map((t, i) => [t, i]));
  const N = teams.length;
  const baseRp = new Float64Array(N), basePlayed = new Float64Array(N);
  const baseTb = new Float64Array(N), scoreSum = new Float64Array(N);
  const remaining = [];

  for (const m of matches) {
    if (m.level !== "Quals") continue;
    // surrogate appearances don't count toward a team's ranking
    const counts = (t) => idx.has(t) && !(m.surr ?? []).includes(t);
    const red = m.red.filter(counts), blue = m.blue.filter(counts);
    if (m.played) {
      const r = m.redScore, b = m.blueScore;
      const rr = earnedRp(season, r, b), br = earnedRp(season, b, r);
      const tr = tb === "legacy" ? r.np : sim.actualTb(r, b), tbb = tb === "legacy" ? b.np : sim.actualTb(b, r);
      for (const t of red) { baseRp[idx.get(t)] += rr; basePlayed[idx.get(t)]++; baseTb[idx.get(t)] += tr; }
      for (const t of blue) { baseRp[idx.get(t)] += br; basePlayed[idx.get(t)]++; baseTb[idx.get(t)] += tbb; }
    } else if (m.pred) {
      remaining.push({ red: red.map((t) => idx.get(t)), blue: blue.map((t) => idx.get(t)), p: m.pred });
      for (const t of red) scoreSum[idx.get(t)] += m.pred.red.np;
      for (const t of blue) scoreSum[idx.get(t)] += m.pred.blue.np;
    }
  }

  // real scores scatter by about half an average alliance score around the
  // prediction (measured on 2020-2025 quals)
  const avgOf = (f) => remaining.reduce((t, m) => t + m.p.red[f] + m.p.blue[f], 0) / Math.max(1, 2 * remaining.length);
  const scoreSd = SCORE_NOISE * avgOf("total");
  sim.setup(teams, avgOf(sim.field === "losingNp" ? "np" : sim.field));
  const totalPlayed = basePlayed.map((p, i) => p + remaining.filter((m) => m.red.includes(i) || m.blue.includes(i)).length);
  // legacy tiebreak proxy: average (actual + predicted) score
  const legacyTb = baseTb.map((s, i) => (s + scoreSum[i]) / Math.max(1, totalPlayed[i]));

  const rankSum = new Float64Array(N), rsSum = new Float64Array(N);
  const top1 = new Float64Array(N), top4 = new Float64Array(N), top8 = new Float64Array(N);
  const rp = new Float64Array(N), tbs = new Float64Array(N);
  const order = Array.from({ length: N }, (_, i) => i);
  const rs = new Float64Array(N);
  const adv = advancement && model ? makeAdvSim(teams, model, teams.map((t) => model.epa(t).np), { ...advancement, matches, quals: !remaining.length }) : null;

  for (let s = 0; s < sims; s++) {
    rp.set(baseRp); tbs.set(baseTb);
    sim.newEvent();
    for (const m of remaining) {
      if (byScore) {
        // simulate the scores themselves: predicted total plus match noise
        const r = Math.max(0, m.p.red.total + scoreSd * gauss()), b = Math.max(0, m.p.blue.total + scoreSd * gauss());
        for (const t of m.red) rp[t] += r;
        for (const t of m.blue) rp[t] += b;
        continue;
      }
      const [rr, br, tr, tbb] = sim.play(m.p, m.red, m.blue);
      for (const t of m.red) { rp[t] += rr; tbs[t] += tr; }
      for (const t of m.blue) { rp[t] += br; tbs[t] += tbb; }
    }
    for (let i = 0; i < N; i++) rs[i] = byScore ? rp[i] : totalPlayed[i] ? rp[i] / totalPlayed[i] : 0;
    const tbv = tb === "legacy" ? legacyTb : tbs.map((x, i) => x / Math.max(1, totalPlayed[i]));
    order.sort((a, b) => rs[b] - rs[a] || tbv[b] - tbv[a]);
    order.forEach((t, r) => {
      rankSum[t] += r + 1;
      rsSum[t] += rs[t];
      if (r === 0) top1[t]++;
      if (r < 4) top4[t]++;
      if (r < 8) top8[t]++;
    });
    adv?.add(order);
  }

  return teams.map((team, i) => ({
    team, ...(adv ? adv.result(i, sims) : {}),
    currentRs: !basePlayed[i] ? null : byScore ? baseRp[i] : baseRp[i] / basePlayed[i],
    played: basePlayed[i],
    left: totalPlayed[i] - basePlayed[i],
    meanRank: rankSum[i] / sims,
    meanRs: rsSum[i] / sims,
    p1: top1[i] / sims,
    p4: top4[i] / sims,
    p8: top8[i] / sims,
  })).sort((a, b) => a.meanRank - b.meanRank);
}


// Seeded random numbers, so a forecast shows the same numbers on every visit.
let seed = 1;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const reseed = (s) => { seed = s | 0 || 1; };

// standard normal sample (Box-Muller)
function gauss() {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

// FTC-style random qualification schedule: each round, teams are shuffled into
// 2v2 matches; a short last match is filled with surrogate appearances that
// don't count toward the surrogate team's ranking.
export function randomSchedule(teams, perTeam) {
  const matches = [];
  for (let round = 0; round < perTeam; round++) {
    const order = shuffle([...teams]);
    for (let i = 0; i < order.length; i += 4) {
      const slots = order.slice(i, i + 4);
      const surrogate = slots.map(() => false);
      while (slots.length < 4) {
        const t = order[Math.floor(rand() * i)];
        if (!slots.includes(t)) { slots.push(t); surrogate.push(true); }
      }
      matches.push({ red: slots.slice(0, 2), blue: slots.slice(2), surrogate });
    }
  }
  return matches;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pre-event ranking prediction from the team list alone: thousands of random
// schedules, each played out from the teams' ratings entering the event.
// Bonus-RP chances are left out by default: per-team RP ratings added noise
// and made the predicted order worse in the 2025 backtest.
// Correlated strengths and the simulated tiebreaker are off by default here:
// random schedules are already well calibrated, and both made the 2023-2025
// backtest worse (corr=1 underconfident; tb "sim" -0.01 Spearman in 2023/2024).
// model: pass one to reuse (e.g. strength of schedule compares against a replay's model)
export function forecastFromRoster(season, meta, ev, { perTeam = 5, sims = 2000, bonus = false, corr = 0, tb = "legacy", rpProb = null, model: given = null, advancement = null } = {}) {
  reseed(ev.teamList.length * 7919 + perTeam);
  const { rankBy } = SEASONS[season];
  const byScore = rankBy === "score";
  const model = given ?? modelFromMeta(meta, null, ev.type);
  const teams = ev.teamList.map((t) => t.team);
  if (!given) for (const t of ev.teamList) if (t.state) model.setTeam(t.team, t.state);
  const N = teams.length;
  if (N < 4) return [];
  const strength = teams.map((t) => model.epa(t).np); // shown in the table; legacy tiebreak proxy
  const sim = makeSim(season, model, { corr, tb });
  const vf = sim.field === "losingNp" ? "np" : sim.field;
  sim.setup(teams, 2 * teams.reduce((s, t) => s + (model.epa(t)[vf] ?? model.epa(t).np), 0) / N);
  // Alliance-only half of model.predict, once per ordered team pair (index i*N+j; order
  // kept so sums match predict() to the bit). Each match only combines two of them.
  const base = new Array(N * N);
  const allianceOf = (i, j) => {
    const k = i * N + j;
    return base[k] ??= model.allianceBase([teams[i], teams[j]]);
  };
  const preV = teams.map((t) => model.preVar(t));
  const kalman = !!model.p.kalman;

  const rankSum = new Float64Array(N), rsSum = new Float64Array(N);
  const top1 = new Float64Array(N), top4 = new Float64Array(N), top8 = new Float64Array(N);
  const rp = new Float64Array(N), played = new Float64Array(N), rs = new Float64Array(N), tbs = new Float64Array(N);
  const order = Array.from({ length: N }, (_, i) => i);
  const adv = advancement ? makeAdvSim(teams, model, strength, advancement) : null;
  const order0 = Array.from({ length: N }, (_, i) => i);
  const scoreSd = SCORE_NOISE * model.avgAllianceNp();

  for (let s = 0; s < sims; s++) {
    rp.fill(0); played.fill(0); tbs.fill(0);
    sim.newEvent();
    const sched = randomSchedule(order0, perTeam); // team indices
    for (let k = 0; k < sched.length; k++) {
      const m = sched[k], R = m.red, B = m.blue;
      const varSum = kalman ? 0 + preV[R[0]] + preV[R[1]] + preV[B[0]] + preV[B[1]] : 0;
      const p = model.predictFrom(allianceOf(R[0], R[1]), allianceOf(B[0], B[1]), null, null, undefined, varSum);
      if (rpProb) {
        const red = [teams[R[0]], teams[R[1]]], blue = [teams[B[0]], teams[B[1]]];
        p.red.rp = rpProb(red, p.red); p.blue.rp = rpProb(blue, p.blue);
      }
      let rr, br, tr = 0, tbb = 0;
      if (byScore) {
        rr = Math.max(0, p.red.total + scoreSd * gauss());
        br = Math.max(0, p.blue.total + scoreSd * gauss());
      } else {
        [rr, br, tr, tbb] = sim.play(p, R, B, bonus);
      }
      for (let j = 0; j < 4; j++) {
        if (m.surrogate[j]) continue;
        const i = j < 2 ? R[j] : B[j - 2];
        rp[i] += j < 2 ? rr : br;
        tbs[i] += j < 2 ? tr : tbb;
        played[i]++;
      }
    }
    for (let i = 0; i < N; i++) rs[i] = byScore ? rp[i] : played[i] ? rp[i] / played[i] : 0;
    const tbv = tb === "legacy" ? strength : tbs.map((x, i) => x / Math.max(1, played[i]));
    order.sort((a, b) => rs[b] - rs[a] || tbv[b] - tbv[a]);
    order.forEach((t, r) => {
      rankSum[t] += r + 1; rsSum[t] += rs[t];
      if (r === 0) top1[t]++;
      if (r < 4) top4[t]++;
      if (r < 8) top8[t]++;
    });
    adv?.add(order);
  }
  return teams.map((team, i) => ({
    team, epa: strength[i], ...(adv ? adv.result(i, sims) : {}), meanRank: rankSum[i] / sims, meanRs: rsSum[i] / sims,
    p1: top1[i] / sims, p4: top4[i] / sims, p8: top8[i] / sims,
  })).sort((a, b) => a.meanRank - b.meanRank);
}

// Advancement points (advancement.js) in each simulated event, for the forecasts above.
// - Quals: points for the simulated rank; once quals are over (`quals`), the official
//   ranks in `ranks` (team -> rank) instead.
// - Alliance selection (Table 13-2 alliance count): each captain is the best-ranked team
//   left and picks the highest-rated team left (so a picked lower captain's place moves
//   up, §13.7.1); declines aren't modelled. FIRST's alliances once they're out (`official`,
//   or the playoff matches themselves).
// - Playoffs: the double-elimination bracket (playoffs.js TEMPLATES) played match by match
//   from the model's win chances, one draw per match. In the 4-8 alliance brackets the
//   upper-bracket winner takes the final with one win and the lower-bracket winner needs
//   two (M-10, then M-11 if required, as events play it); a 2-alliance final is best of 3.
//   Matches already played keep their real winners.
// Judged awards aren't forecast.
function makeAdvSim(teams, model, strength, { official = null, matches = [], ranks = null, quals = false } = {}) {
  const N = teams.length;
  const idx = new Map(teams.map((t, i) => [t, i]));
  const qp = Array.from({ length: N }, (_, r) => qualPts(r + 1, N));
  const byStrength = teams.map((_, i) => i).sort((a, b) => strength[b] - strength[a]);
  // the official ranking once quals are over
  const fixedOrder = quals && ranks && teams.every((t) => ranks.get(t) != null)
    ? teams.map((_, i) => i).sort((a, b) => ranks.get(teams[a]) - ranks.get(teams[b])) : null;

  // real alliances and bracket results, once they exist
  let alliances = null;
  const known = new Map(); // match number -> index of the winning alliance
  const finalWins = new Map(); // 2-alliance best-of-3 final: alliance index -> games won
  const elims = matches.filter((m) => m.level && m.level !== "Quals");
  const p = elims.length || official?.length ? playoffs(elims.length ? matches : [], teams.map((t) => ({ team: t, rank: ranks?.get(t) ?? null })), official) : null;
  if (official?.length) alliances = official.map((a) => a.filter((t) => idx.has(t)).map((t) => idx.get(t)));
  else if (p && p.alliances.length === allianceCount(N)) alliances = p.alliances.map((a) => a.teams.filter((t) => idx.has(t)).map((t) => idx.get(t)));
  const A = alliances?.length ?? allianceCount(N);
  const tpl = TEMPLATES[A];
  if (p && alliances) {
    const seedOf = (a) => (a ? a.seed - 1 : null);
    for (const sec of p.sections) for (const r of sec.rounds) for (const sl of r.slots) {
      if (!sl.winner) {
        if (sl.key === "F" && (sl.redWins || sl.blueWins)) { finalWins.set(seedOf(sl.red), sl.redWins); finalWins.set(seedOf(sl.blue), sl.blueWins); }
        continue;
      }
      if (sl.key === "F") { finalWins.set(seedOf(sl.red), sl.redWins); finalWins.set(seedOf(sl.blue), sl.blueWins); continue; }
      const n = /^M-(\d+)$/.exec(sl.key)?.[1];
      if (!n) continue;
      if (A === 2) finalWins.set(seedOf(sl.winner), (finalWins.get(seedOf(sl.winner)) ?? 0) + 1);
      else known.set(+n, seedOf(sl.winner));
    }
  }

  const cache = new Map();
  const pRed = (a, b) => {
    const k = `${a}|${b}`;
    if (!cache.has(k)) cache.set(k, model.predict(a.map((i) => teams[i]), b.map((i) => teams[i])).pRed);
    return cache.get(k);
  };
  const qual = new Float64Array(N), sel = new Float64Array(N), po = new Float64Array(N);
  const win = new Float64Array(N), cap = new Float64Array(N);
  const taken = new Uint8Array(N);
  const nonFinal = tpl ? Object.keys(tpl.src).map(Number).filter((n) => !tpl.final.includes(n)).sort((a, b) => a - b) : [];

  return {
    add(order) {
      const ord = fixedOrder ?? order;
      ord.forEach((t, r) => (qual[t] += qp[r]));
      let al = alliances;
      if (!al) {
        taken.fill(0);
        al = [];
        let c = 0, s = 0;
        for (let k = 0; k < A; k++) {
          while (c < N && taken[ord[c]]) c++;
          if (c >= N) break;
          const captain = ord[c]; taken[captain] = 1;
          while (s < N && taken[byStrength[s]]) s++;
          const pick = s < N ? byStrength[s] : null;
          if (pick != null) taken[pick] = 1;
          al.push(pick != null ? [captain, pick] : [captain]);
        }
      }
      al.forEach((a, k) => {
        for (const t of a) sel[t] += selectionPts(k + 1);
        if (a.length) cap[a[0]]++;
      });
      if (!tpl || al.length !== A) return;
      const res = new Map();
      const who = (x) => (x[0] === "A" ? +x.slice(1) - 1 : x[0] === "W" ? res.get(+x.slice(1))[0] : res.get(+x.slice(1))[1]);
      const play = (r, b) => (rand() < pRed(al[r], al[b]) ? [r, b] : [b, r]);
      for (const n of nonFinal) {
        const [r, b] = tpl.src[n].map(who);
        const w = known.get(n);
        res.set(n, w === r || w === b ? (w === r ? [r, b] : [b, r]) : play(r, b));
      }
      const [fa, fb] = tpl.src[tpl.final[0]].map(who);
      const game = (n) => { const w = known.get(n); return w === fa || w === fb ? w : play(fa, fb)[0]; };
      let champ;
      if (A === 2) {
        let wa = finalWins.get(fa) ?? 0, wb = finalWins.get(fb) ?? 0;
        while (wa < 2 && wb < 2) { if (play(fa, fb)[0] === fa) wa++; else wb++; }
        champ = wa >= 2 ? fa : fb;
      } else {
        // fa comes from the upper bracket: one win takes it; fb must win twice
        champ = game(tpl.final[0]) === fa ? fa : game(tpl.final[1]);
      }
      const runner = champ === fa ? fb : fa;
      const award = (k, pts) => { for (const t of al[k]) po[t] += pts; };
      award(champ, PLAYOFF_PTS.Winner); award(runner, PLAYOFF_PTS.Finalist);
      for (const t of al[champ]) win[t]++;
      for (const [n, place] of Object.entries(tpl.place)) if (PLAYOFF_PTS[place]) award(res.get(+n)[1], PLAYOFF_PTS[place]);
    },
    result(i, sims) {
      const eQual = qual[i] / sims, eSel = sel[i] / sims, ePlayoff = po[i] / sims;
      return { eQual, eSel, ePlayoff, eTotal: eQual + eSel + ePlayoff, pWin: win[i] / sims, pCaptain: cap[i] / sims };
    },
  };
}
