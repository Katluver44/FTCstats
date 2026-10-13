// Event replay, live updates, and ranking forecasts — all in the browser.

import { Model } from "./model.js";
import { SEASONS, eventQuery, API } from "./seasons.js";

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

// FTCScout's raw event -> the same match shape the static event files use.
export function normalizeLive(season, ev) {
  const read = SEASONS[season].read;
  const time = (m) => Date.parse(m.actualStartTime ?? m.scheduledStartTime ?? `${ev.start}T12:00:00Z`) || 0;
  return ev.matches
    .slice()
    .sort((a, b) => time(a) - time(b) || a.id - b.id)
    .map((m) => {
      const side = (al) => m.teams.filter((t) => t.alliance === al).map((t) => t.teamNumber);
      const on = (al) => m.teams.filter((t) => t.alliance === al && t.onField && !t.noShow).map((t) => t.teamNumber);
      const played = m.hasBeenPlayed && !!m.scores?.red;
      const sc = (raw) => read(raw);
      return {
        id: m.id, d: m.description, level: m.tournamentLevel, time: time(m),
        red: side("Red"), blue: side("Blue"), redOn: on("Red"), blueOn: on("Blue"),
        played, redScore: played ? sc(m.scores.red) : null, blueScore: played ? sc(m.scores.blue) : null,
      };
    });
}

// Re-run the model over an event's matches, starting from each team's rating
// entering the event. Only the first `cutoff` quals count as played; later
// matches are predicted with ratings frozen at that point.
export function replayEvent(meta, ev, matches, cutoff = Infinity) {
  const a = meta.avgAlliance;
  const model = new Model({ baseline: { auto: a.auto, teleop: a.teleop, endgame: a.endgame, foul: a.foul, rp: a.rp } });
  for (const t of ev.teamList) {
    if (!t.state) continue;
    const [auto, teleop, endgame, foul, n, ...rp] = t.state;
    model.setTeam(t.team, { auto, teleop, endgame, foul, n, rp });
  }
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

// Monte Carlo over the remaining quals. Returns per-team ranking odds.
export function forecastRankings(season, teams, matches, sims = 3000) {
  const { winRp, tieRp, rpNames } = SEASONS[season];
  const bonusRps = rpNames.length;
  const idx = new Map(teams.map((t, i) => [t, i]));
  const N = teams.length;
  const baseRp = new Float64Array(N), basePlayed = new Float64Array(N), scoreSum = new Float64Array(N);
  const remaining = [];

  for (const m of matches) {
    if (m.level !== "Quals") continue;
    const red = m.red.filter((t) => idx.has(t)), blue = m.blue.filter((t) => idx.has(t));
    if (m.played) {
      const r = m.redScore, b = m.blueScore;
      const rr = (r.total > b.total ? winRp : r.total === b.total ? tieRp : 0) + (r.rp ?? []).filter(Boolean).length;
      const br = (b.total > r.total ? winRp : r.total === b.total ? tieRp : 0) + (b.rp ?? []).filter(Boolean).length;
      for (const t of red) { baseRp[idx.get(t)] += rr; basePlayed[idx.get(t)]++; scoreSum[idx.get(t)] += r.np; }
      for (const t of blue) { baseRp[idx.get(t)] += br; basePlayed[idx.get(t)]++; scoreSum[idx.get(t)] += b.np; }
    } else if (m.pred) {
      remaining.push({ red: red.map((t) => idx.get(t)), blue: blue.map((t) => idx.get(t)), p: m.pred });
      for (const t of red) scoreSum[idx.get(t)] += m.pred.red.np;
      for (const t of blue) scoreSum[idx.get(t)] += m.pred.blue.np;
    }
  }

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
      const u = Math.random();
      const redWins = u < m.p.pRed;
      let rr = redWins ? winRp : 0, br = redWins ? 0 : winRp;
      for (let k = 0; k < bonusRps; k++) {
        if (Math.random() < m.p.red.rp[k]) rr++;
        if (Math.random() < m.p.blue.rp[k]) br++;
      }
      for (const t of m.red) rp[t] += rr;
      for (const t of m.blue) rp[t] += br;
    }
    for (let i = 0; i < N; i++) rs[i] = totalPlayed[i] ? rp[i] / totalPlayed[i] : 0;
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
    currentRs: basePlayed[i] ? baseRp[i] / basePlayed[i] : null,
    played: basePlayed[i],
    left: totalPlayed[i] - basePlayed[i],
    meanRank: rankSum[i] / sims,
    meanRs: rsSum[i] / sims,
    p1: top1[i] / sims,
    p4: top4[i] / sims,
    p8: top8[i] / sims,
  })).sort((a, b) => a.meanRank - b.meanRank);
}
