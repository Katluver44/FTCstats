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
    baseline: { auto: a.auto, teleop: a.teleop, endgame: a.endgame, foul: a.foul, errVar: a.errVar, foulDiffVar: a.foulDiffVar, rp: a.rp, solo: a.solo ?? [], clipVar: a.clipVar },
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
export function forecastRankings(season, teams, matches, sims = 3000, { model = null, corr = 1, tb = "sim" } = {}) {
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
// Correlated strengths and the simulated tiebreaker are off by default here:
// random schedules are already well calibrated, and both made the 2023-2025
// backtest worse (corr=1 underconfident; tb "sim" -0.01 Spearman in 2023/2024).
export function forecastFromRoster(season, meta, ev, { perTeam = 5, sims = 2000, bonus = false, corr = 0, tb = "legacy", rpProb = null } = {}) {
  reseed(ev.teamList.length * 7919 + perTeam);
  const { rankBy } = SEASONS[season];
  const byScore = rankBy === "score";
  const model = modelFromMeta(meta);
  const teams = ev.teamList.map((t) => t.team);
  for (const t of ev.teamList) if (t.state) model.setTeam(t.team, t.state);
  const N = teams.length;
  if (N < 4) return [];
  const idx = new Map(teams.map((t, i) => [t, i]));
  const strength = teams.map((t) => model.epa(t).np); // shown in the table; legacy tiebreak proxy
  const sim = makeSim(season, model, { corr, tb });
  const vf = sim.field === "losingNp" ? "np" : sim.field;
  sim.setup(teams, 2 * teams.reduce((s, t) => s + (model.epa(t)[vf] ?? model.epa(t).np), 0) / N);
  const cache = new Map(); // "a,b|c,d" -> prediction
  const predict = (red, blue) => {
    const k = `${red}|${blue}`;
    if (!cache.has(k)) {
      const p = model.predict(red, blue);
      if (rpProb) { p.red.rp = rpProb(red, p.red); p.blue.rp = rpProb(blue, p.blue); }
      cache.set(k, p);
    }
    return cache.get(k);
  };

  const rankSum = new Float64Array(N), rsSum = new Float64Array(N);
  const top1 = new Float64Array(N), top4 = new Float64Array(N), top8 = new Float64Array(N);
  const rp = new Float64Array(N), played = new Float64Array(N), rs = new Float64Array(N), tbs = new Float64Array(N);
  const order = Array.from({ length: N }, (_, i) => i);

  for (let s = 0; s < sims; s++) {
    rp.fill(0); played.fill(0); tbs.fill(0);
    sim.newEvent();
    for (const m of randomSchedule(teams, perTeam)) {
      const p = predict(m.red, m.blue);
      let rr, br, tr = 0, tbb = 0;
      if (byScore) {
        const sd = SCORE_NOISE * model.avgAllianceNp();
        rr = Math.max(0, p.red.total + sd * gauss());
        br = Math.max(0, p.blue.total + sd * gauss());
      } else {
        [rr, br, tr, tbb] = sim.play(p, m.red.map((t) => idx.get(t)), m.blue.map((t) => idx.get(t)), bonus);
      }
      [...m.red, ...m.blue].forEach((t, j) => {
        if (m.surrogate[j]) return;
        const i = idx.get(t);
        rp[i] += j < 2 ? rr : br;
        tbs[i] += j < 2 ? tr : tbb;
        played[i]++;
      });
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
  }
  return teams.map((team, i) => ({
    team, epa: strength[i], meanRank: rankSum[i] / sims, meanRs: rsSum[i] / sims,
    p1: top1[i] / sims, p4: top4[i] / sims, p8: top8[i] / sims,
  })).sort((a, b) => a.meanRank - b.meanRank);
}
