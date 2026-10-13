// Pulls every event (with matches + teams) for a season from the FTCScout API
// and caches the raw responses in .cache/<season>/. Finished events are never
// refetched; events that are ongoing or upcoming are refetched on each run.
//
//   node scripts/fetch.mjs 2025

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEASONS, eventQuery } from "../site/js/seasons.js";

const API = "https://api.ftcscout.org/graphql";
const CONCURRENCY = 4;

export async function gql(query, variables = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
      return json.data;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function pool(items, n, fn) {
  let i = 0, done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
        if (++done % 50 === 0) console.log(`  ${done}/${items.length}`);
      }
    })
  );
}

export async function fetchSeason(season) {
  const dir = path.join(".cache", String(season));
  await fs.mkdir(dir, { recursive: true });

  const { eventsSearch } = await gql(
    `query($season: Int!) { eventsSearch(season: $season, hasMatches: true) { code finished remote } }`,
    { season }
  );
  // remote (single-team) events can't be used for 2v2 ratings
  for (let i = eventsSearch.length - 1; i >= 0; i--) if (eventsSearch[i].remote) eventsSearch.splice(i, 1);
  console.log(`${season}: ${eventsSearch.length} events with matches`);

  // upcoming events (next 3 weeks) with registered teams, for pre-event ranking predictions
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
  const { eventsSearch: upcoming } = await gql(
    `query($season: Int!, $start: Date!, $end: Date!) { eventsSearch(season: $season, hasMatches: false, start: $start, end: $end) { code finished teams { teamNumber } } }`,
    { season, start: today, end: soon }
  ).catch(() => ({ eventsSearch: [] }));
  const withTeams = upcoming.filter((e) => e.teams.length >= 4);
  if (withTeams.length) console.log(`  + ${withTeams.length} upcoming events with team lists`);
  eventsSearch.push(...withTeams);

  const todo = [];
  for (const ev of eventsSearch) {
    const file = path.join(dir, `${ev.code}.json`);
    const cached = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (!cached || !cached.finished) todo.push(ev.code);
  }
  console.log(`  fetching ${todo.length} (rest cached)`);

  const q = eventQuery(season);
  await pool(todo, CONCURRENCY, async (code) => {
    const { eventByCode } = await gql(q, { season, code });
    if (eventByCode) await fs.writeFile(path.join(dir, `${code}.json`), JSON.stringify(eventByCode));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const season = Number(process.argv[2] ?? 2025);
  await fetchSeason(season);
}
