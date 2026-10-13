// Event replay, live updates, and ranking forecasts — all in the browser.

import { Model, allianceTeams } from "./model.js";
import { SEASONS, eventQuery, API, soloPoints } from "./seasons.js";

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
export function modelFromMeta(meta, avg) {
  const a = avg ?? meta.avgAlliance;
  return new Model({
    baseline: { auto: a.auto, teleop: a.teleop, endgame: a.endgame, foul: a.foul, rp: a.rp, solo: a.solo ?? [] },
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
      const on = (al) => allianceTeams({ teams: m.teams.filter((t) => t.onField && !t.noShow) }, al);
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
  const model = modelFromMeta(meta, ev.avg);
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

// Monte Carlo over the remaining quals. Returns per-team ranking odds.
export function forecastRankings(season, teams, matches, sims = 3000) {
  reseed(teams.length * 7919 + matches.length);
  const { winRp, tieRp, rpNames, rankBy } = SEASONS[season];
  const bonusRps = rpNames.length;
  const byScore = rankBy === "score";
  const idx = new Map(teams.map((t, i) => [t, i]));
  const N = teams.length;
  const baseRp = new Float64Array(N), basePlayed = new Float64Array(N), scoreSum = new Float64Array(N);
  const remaining = [];

  for (const m of matches) {
    if (m.level !== "Quals") continue;
    // surrogate appearances don't count toward a team's ranking
    const counts = (t) => idx.has(t) && !(m.surr ?? []).includes(t);
    const red = m.red.filter(counts), blue = m.blue.filter(counts);
    if (m.played) {
      const r = m.redScore, b = m.blueScore;
      const rr = byScore ? r.total : (r.total > b.total ? winRp : r.total === b.total ? tieRp : 0) + (r.rp ?? []).filter(Boolean).length;
      const br = byScore ? b.total : (b.total > r.total ? winRp : r.total === b.total ? tieRp : 0) + (b.rp ?? []).filter(Boolean).length;
      for (const t of red) { baseRp[idx.get(t)] += rr; basePlayed[idx.get(t)]++; scoreSum[idx.get(t)] += r.np; }
      for (const t of blue) { baseRp[idx.get(t)] += br; basePlayed[idx.get(t)]++; scoreSum[idx.get(t)] += b.np; }
    } else if (m.pred) {
      remaining.push({ red: red.map((t) => idx.get(t)), blue: blue.map((t) => idx.get(t)), p: m.pred });
      for (const t of red) scoreSum[idx.get(t)] += m.pred.red.np;
      for (const t of blue) scoreSum[idx.get(t)] += m.pred.blue.np;
    }
  }

  // real scores scatter by about half an average alliance score around the
  // prediction (measured on 2020-2025 quals)
  const avgTotal = remaining.reduce((t, m) => t + m.p.red.total + m.p.blue.total, 0) / Math.max(1, 2 * remaining.length);
  const scoreSd = SCORE_NOISE * avgTotal;
  const totalPlayed = basePlayed.map((p, i) => p + remaining.filter((m) => m.red.includes(i) || m.blue.includes(i)).length);
  // tiebreak proxy: average (actual + predicted) score
  const tb = scoreSum.map((s, i) => s / Math.max(1, totalPlayed[i]));

  const rankSum = new Float64Array(N), rsSum = new Float64Array(N);
  const top1 = new Float64Array(N), top4 = new Float64Array(N), top8 = new Float64Array(N);
  const rp = new Float64Array(N);
  const order = Array.from({ length: N }, (_, i) => i);
  const rs = new Float64Array(N);

  for (let s = 0; s < sims; s++) {
    rp.set(baseRp);
    for (const m of remaining) {
      if (byScore) {
        // simulate the scores themselves: predicted total plus match noise
        const r = Math.max(0, m.p.red.total + scoreSd * gauss()), b = Math.max(0, m.p.blue.total + scoreSd * gauss());
        for (const t of m.red) rp[t] += r;
        for (const t of m.blue) rp[t] += b;
        continue;
      }
      const u = rand();
      const redWins = u < m.p.pRed;
      let rr = redWins ? winRp : 0, br = redWins ? 0 : winRp;
      for (let k = 0; k < bonusRps; k++) {
        if (rand() < m.p.red.rp[k]) rr++;
        if (rand() < m.p.blue.rp[k]) br++;
      }
      for (const t of m.red) rp[t] += rr;
      for (const t of m.blue) rp[t] += br;
    }
    for (let i = 0; i < N; i++) rs[i] = byScore ? rp[i] : totalPlayed[i] ? rp[i] / totalPlayed[i] : 0;
    order.sort((a, b) => rs[b] - rs[a] || tb[b] - tb[a]);
    order.forEach((t, r) => {
      rankSum[t] += r + 1;
      rsSum[t] += rs[t];
      if (r === 0) top1[t]++;
      if (r < 4) top4[t]++;
      if (r < 8) top8[t]++;
    });
  }

  return teams.map((team, i) => ({
    team,
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
export function forecastFromRoster(season, meta, ev, { perTeam = 5, sims = 2000, bonus = false } = {}) {
  reseed(ev.teamList.length * 7919 + perTeam);
  const { winRp, tieRp, rpNames, rankBy } = SEASONS[season];
  const byScore = rankBy === "score";
  const model = modelFromMeta(meta);
  const teams = ev.teamList.map((t) => t.team);
  for (const t of ev.teamList) if (t.state) model.setTeam(t.team, t.state);
  const N = teams.length;
  if (N < 4) return [];
  const idx = new Map(teams.map((t, i) => [t, i]));
  const strength = teams.map((t) => model.epa(t).np); // tiebreak proxy
  const cache = new Map(); // "a,b|c,d" -> prediction
  const predict = (red, blue) => {
    const k = `${red}|${blue}`;
    if (!cache.has(k)) cache.set(k, model.predict(red, blue));
    return cache.get(k);
  };

  const rankSum = new Float64Array(N), rsSum = new Float64Array(N);
  const top1 = new Float64Array(N), top4 = new Float64Array(N), top8 = new Float64Array(N);
  const rp = new Float64Array(N), played = new Float64Array(N), rs = new Float64Array(N);
  const order = Array.from({ length: N }, (_, i) => i);

  for (let s = 0; s < sims; s++) {
    rp.fill(0); played.fill(0);
    for (const m of randomSchedule(teams, perTeam)) {
      const p = predict(m.red, m.blue);
      let rr, br;
      if (byScore) {
        const sd = SCORE_NOISE * model.avgAllianceNp();
        rr = Math.max(0, p.red.total + sd * gauss());
        br = Math.max(0, p.blue.total + sd * gauss());
      } else {
        const redWins = rand() < p.pRed;
        rr = redWins ? winRp : 0; br = redWins ? 0 : winRp;
        for (let k = 0; k < (bonus ? rpNames.length : 0); k++) {
          if (rand() < p.red.rp[k]) rr++;
          if (rand() < p.blue.rp[k]) br++;
        }
      }
      [...m.red, ...m.blue].forEach((t, j) => {
        if (m.surrogate[j]) return;
        const i = idx.get(t);
        rp[i] += j < 2 ? rr : br;
        played[i]++;
      });
    }
    for (let i = 0; i < N; i++) rs[i] = byScore ? rp[i] : played[i] ? rp[i] / played[i] : 0;
    order.sort((a, b) => rs[b] - rs[a] || strength[b] - strength[a]);
    order.forEach((t, r) => {
      rankSum[t] += r + 1; rsSum[t] += rs[t];
      if (r === 0) top1[t]++;
      if (r < 4) top4[t]++;
      if (r < 8) top8[t]++;
    });
  }
  return teams.map((team, i) => ({
    team, epa: strength[i], meanRank: rankSum[i] / sims, meanRs: rsSum[i] / sims,
    p1: top1[i] / sims, p4: top4[i] / sims, p8: top8[i] / sims,
  })).sort((a, b) => a.meanRank - b.meanRank);
}
