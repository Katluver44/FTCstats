// How good are the pre-event ranking predictions? For every past event with a
// full qualification schedule, predict the final rankings from the team list
// alone (ratings as of the event's start, random schedules) and compare with
// what actually happened. Writes site/data/<season>/ranking.json.
//
//   node scripts/rank-backtest.mjs 2025

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { forecastFromRoster, replayEvent, forecastRankings } from "../site/js/live.js";

// Spearman rank correlation between two orderings of the same teams.
function spearman(a, b) {
  const n = a.length;
  const mean = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - mean) * (b[i] - mean);
    da += (a[i] - mean) ** 2;
    db += (b[i] - mean) ** 2;
  }
  return num / Math.sqrt(da * db);
}
const rankOf = (vals) => {
  const order = vals.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(vals.length);
  order.forEach(([, i], k) => (r[i] = k + 1));
  return r;
};

export async function backtest(season, { sims = 400, minTeams = 12 } = {}) {
  const dir = path.join("site", "data", String(season));
  const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
  const events = JSON.parse(await fs.readFile(path.join(dir, "events.json"), "utf8"));
  const methods = { random: [], noBonus: [], schedule: [], epa: [] };
  const cal = Array.from({ length: 10 }, () => [0, 0]); // P(top 4) calibration
  let nEvents = 0;

  for (const e of events) {
    if (e.teams < minTeams || !e.finished) continue;
    const ev = JSON.parse(await fs.readFile(path.join(dir, "event", `${e.code}.json`), "utf8"));
    const quals = ev.matchList.filter((m) => m.level === "Quals");
    const ranked = ev.teamList.filter((t) => t.rank != null && t.state);
    if (quals.length < 8 || ranked.length < minTeams || quals.some((m) => !m.played)) continue;
    const teams = new Set(ranked.map((t) => t.team));
    const ev2 = { ...ev, teamList: ranked };
    const actual = ranked.map((t) => t.rank);
    const perTeam = Math.round((quals.length * 4) / ev.teamList.length);

    const score = (key, predRanks, pTop4) => {
      const rho = spearman(rankOf(predRanks), rankOf(actual));
      const predTop4 = new Set(ranked.map((t, i) => [t.team, predRanks[i]]).sort((a, b) => a[1] - b[1]).slice(0, 4).map((x) => x[0]));
      const hit4 = ranked.filter((t) => t.rank <= 4 && predTop4.has(t.team)).length / 4;
      const first = ranked.find((t) => t.rank === 1)?.team;
      methods[key].push({ rho, hit4, firstInTop4: predTop4.has(first) ? 1 : 0 });
      if (pTop4) ranked.forEach((t, i) => {
        const b = cal[Math.min(9, Math.floor(pTop4[i] * 10))];
        b[0]++; b[1] += t.rank <= 4 ? 1 : 0;
      });
    };

    // 1. team list only: random schedules (what the site shows before an event)
    const r = new Map(forecastFromRoster(season, meta, ev2, { perTeam, sims, bonus: true }).map((x) => [x.team, x]));
    score("random", ranked.map((t) => r.get(t.team).meanRank), ranked.map((t) => r.get(t.team).p4));
    const nb = new Map(forecastFromRoster(season, meta, ev2, { perTeam, sims, bonus: false }).map((x) => [x.team, x]));
    score("noBonus", ranked.map((t) => nb.get(t.team).meanRank));
    // 2. the real schedule, nothing played yet (what the site shows once the schedule is out)
    const replayed = replayEvent(meta, ev2, ev.matchList.map((m) => ({ ...m, red: m.red, blue: m.blue })), 0).matches;
    const f = new Map(forecastRankings(season, [...teams], replayed, sims).map((x) => [x.team, x]));
    score("schedule", ranked.map((t) => f.get(t.team).meanRank));
    // 3. baseline: just sort by rating entering the event
    score("epa", ranked.map((t) => -(t.state.auto + t.state.teleop + t.state.endgame + t.state.solo.reduce((a, b) => a + b, 0))));
    nEvents++;
  }

  const avg = (rows, k) => rows.reduce((s, x) => s + x[k], 0) / Math.max(1, rows.length);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const summary = Object.fromEntries(Object.entries(methods).map(([k, rows]) => [k, {
    spearman: r3(avg(rows, "rho")), top4: r3(avg(rows, "hit4")), firstInTop4: r3(avg(rows, "firstInTop4")),
  }]));
  const out = {
    season, events: nEvents, sims, ...summary,
    calibration: cal.map(([n, hit], i) => ({ bin: i / 10, n, rate: n ? r3(hit / n) : null })).filter((b) => b.n),
  };
  await fs.writeFile(path.join(dir, "ranking.json"), JSON.stringify(out));
  await fs.mkdir(path.join(".cache", "ranking"), { recursive: true });
  await fs.writeFile(path.join(".cache", "ranking", `${season}.json`), JSON.stringify(out));
  return out;
}

// With --cached, seasons more than a year old reuse their last result: their
// events are finished, so the backtest can't change.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cached = process.argv.includes("--cached");
  const seasons = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a)).map(Number);
  const latest = Math.max(...seasons);
  for (const s of seasons) {
    const saved = path.join(".cache", "ranking", `${s}.json`);
    if (cached && s < latest - 1 && (await fs.stat(saved).catch(() => null))) {
      await fs.copyFile(saved, path.join("site", "data", String(s), "ranking.json"));
      console.log(s, "ranking backtest reused from cache");
      continue;
    }
    const r = await backtest(s);
    console.log(s, `${r.events} events`, JSON.stringify({ random: r.random, noBonus: r.noBonus, schedule: r.schedule, epa: r.epa }));
    console.log("   P(top4) calibration:", r.calibration.map((b) => `${b.bin.toFixed(1)}:${b.rate}(${b.n})`).join(" "));
  }
}
