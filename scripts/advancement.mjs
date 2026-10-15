// Caches the FIRST API data the build needs for advancement points:
//   .cache/first-events/<season>.json        FIRST's event list (for division -> parent links)
//   .cache/first-rankings/<season>/<code>.json  official qual rankings, for League Tournaments
//       (FIRST ranks them by the combined league ranking, which FTCScout doesn't have)
//       and for division events
//   .cache/advancement/<season>/<code>.json     the official advanced list (slots, declines)
// Only finished advancing events, each fetched once. Skips quietly without FIRST API credentials.
//
//   node scripts/advancement.mjs 2025 2026

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { first, hasFirstApi } from "./first-api.mjs";
import { ADVANCING_TYPES, advRules, eventAdvancement, qualStats } from "../site/js/advancement.js";
import { playoffs } from "../site/js/playoffs.js";

const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const exists = (f) => fs.stat(f).then(() => true, () => false);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// FIRST's division code -> parent code, from its event list (cached; refreshed while the season has unfinished events)
export async function divisionParents(season) {
  const f = path.join(".cache", "first-events", `${season}.json`);
  const list = await readJson(f, null);
  return new Map((list ?? []).filter((e) => e.divisionCode).map((e) => [e.code, e.divisionCode]));
}

export async function fetchAdvancement(season) {
  if (!advRules(season) || !hasFirstApi()) return;
  const dir = path.join(".cache", String(season));
  const events = [];
  for (const f of await fs.readdir(dir).catch(() => [])) {
    const ev = await readJson(path.join(dir, f), null);
    if (ev && !ev.remote && ADVANCING_TYPES.has(ev.type)) events.push({ code: ev.code, type: ev.type, finished: ev.finished, played: ev.matches.some((m) => m.hasBeenPlayed) });
  }
  const evFile = path.join(".cache", "first-events", `${season}.json`);
  if (!(await exists(evFile)) || events.some((e) => !e.finished)) {
    const r = await first(`${season}/events`).catch((e) => (console.warn(`  FIRST events list: ${e.message}`), null));
    if (r?.events) {
      await fs.mkdir(path.dirname(evFile), { recursive: true });
      await fs.writeFile(evFile, JSON.stringify(r.events.map((e) => ({ code: e.code, divisionCode: e.divisionCode, typeName: e.typeName }))));
    }
  }
  const parents = await divisionParents(season);
  let fetched = 0;
  for (const e of events) {
    if (!e.finished || !e.played) continue;
    const isDivision = parents.has(e.code);
    const todo = [];
    if (e.type === "LeagueTournament" || isDivision) todo.push(["first-rankings", `${season}/rankings/${e.code}`]);
    if (!isDivision) todo.push(["advancement", `${season}/advancement/${e.code}`]);
    for (const [kind, p] of todo) {
      const f = path.join(".cache", kind, String(season), `${e.code}.json`);
      if (await exists(f)) continue;
      const r = await first(p).catch((err) => (console.warn(`  ${p}: ${err.message}`), undefined));
      if (r === undefined) continue; // error: try again next run
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify(r ?? {}));
      fetched++;
      await pause(150);
    }
  }
  console.log(`${season}: advancement data fetched for ${fetched} new event files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const s of process.argv.slice(2).map(Number)) await fetchAdvancement(s);
}

// ---- used by build.mjs ----

// division codes of each parent event: FIRST's divisionCode links, or (no FIRST data) the
// parent's code plus a non-numeric suffix on the same start date (USFLCMP -> USFLCMPLAWR, USFLCMPSCOT)
export async function divisionsOf(season, events) {
  const parents = await divisionParents(season);
  const byCode = new Map(events.map((e) => [e.code, e]));
  const out = new Map();
  const add = (p, c) => { if (!out.has(p)) out.set(p, []); out.get(p).push(c); };
  if (parents.size) {
    for (const [c, p] of parents) if (byCode.has(c) && byCode.has(p)) add(p, c);
  } else {
    for (const p of events) for (const c of events) {
      if (c.code !== p.code && c.code.startsWith(p.code) && !/^\d/.test(c.code.slice(p.code.length)) && c.start === p.start && c.type === p.type) add(p.code, c.code);
    }
  }
  return out;
}

// ev.adv for a finished event. units: [{ code, teamList, matchList }] (the event itself, or each
// division); finals: the parent's { teamList, matchList } for dual-division events.
// official: the season's alliances.json (FIRST's alliance selections).
// -> { rows: [[team, total, judging, playoff, selection, qual]], slots, advanced, declined } or null
export async function buildAdv(season, ev, units, finals, official = {}) {
  const cache = (kind, code) => readJson(path.join(".cache", kind, String(season), `${code}.json`), null);
  const awards = await readJson(path.join(".cache", "awards", String(season), `${ev.code}.json`), []);
  const advData = await cache("advancement", ev.code);
  const divisional = !!finals;
  const unitsIn = [];
  let stats = new Map();
  for (const u of units) {
    let ranks = u.teamList.filter((t) => t.rank != null).map((t) => [t.team, t.rank]);
    // League Tournaments are ranked by the combined league ranking; divisions use FIRST's own too
    if (ev.type === "LeagueTournament" || divisional) {
      const fr = await cache("first-rankings", u.code);
      if (fr?.rankings?.length) ranks = fr.rankings.map((r) => [r.teamNumber, r.rank]);
      else if (ev.type === "LeagueTournament") return null; // FTCScout's LT-only ranks would give wrong points
    }
    const p = playoffs(u.matchList, u.teamList, official[u.code], { finished: true });
    const alliances = official[u.code]?.length ? official[u.code] : (p?.alliances ?? []).map((a) => a.teams);
    const results = (p?.alliances ?? []).flatMap((a) => a.teams.map((t) => [t, a.result]));
    unitsIn.push({ ranks, alliances, results });
    stats = new Map([...stats, ...qualStats(u.matchList)]);
  }
  let finalsIn = null;
  if (divisional) {
    const p = playoffs(finals.matchList, finals.teamList, null, { finished: true });
    finalsIn = (p?.alliances ?? []).flatMap((a) => a.teams.map((t) => [t, a.result]));
  }
  const roster = units.flatMap((u) => u.teamList.map((t) => t.team));
  const rows = eventAdvancement({ season, units: unitsIn, finals: finalsIn, awards, stats, roster });
  if (!rows.length) return null;
  const list = advData?.advancement ?? [];
  return {
    rows: rows.map((r) => [r.team, r.total, r.judging, r.playoff, r.selection, r.qual]),
    slots: advData?.slots ?? null,
    advanced: list.filter((a) => !a.declined).map((a) => a.team),
    declined: list.filter((a) => a.declined).map((a) => a.team),
  };
}
