// Official alliance selections from the FIRST API, for every event that played
// playoffs: site/data/<season>/alliances.json = { CODE: [[captain, pick1, pick2, backup], ...] }
// (index = seed - 1). Finished events are cached in .cache/alliances/; the site
// falls back to working seeds out from the matches when an event is missing.
//
//   node scripts/alliances.mjs 2025 2026

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { first, hasFirstApi } from "./first-api.mjs";

const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);

export async function buildAlliances(season) {
  const out = path.join("site", "data", String(season), "alliances.json");
  if (!hasFirstApi()) return readJson(out, {});
  const cacheFile = path.join(".cache", "alliances", `${season}.json`);
  const cache = await readJson(cacheFile, {});
  const events = await readJson(path.join("site", "data", String(season), "events.json"), []);
  const list = Array.isArray(events) ? events : events.events ?? [];
  for (const e of list) {
    if (cache[e.code] && e.finished) continue;
    const ev = await readJson(path.join("site", "data", String(season), "event", `${e.code}.json`), null);
    if (!ev?.matchList?.some((m) => m.level && m.level !== "Quals" && m.played)) continue;
    const r = await first(`${season}/alliances/${e.code}`).catch(() => null);
    if (!r) continue;
    cache[e.code] = (r.alliances ?? [])
      .sort((a, b) => a.number - b.number)
      .map((a) => [a.captain, a.round1, a.round2, a.round3, a.backup].map((t) => t?.teamNumber).filter(Boolean));
  }
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  const result = Object.fromEntries(Object.entries(cache).filter(([, a]) => a.length));
  await fs.writeFile(out, JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const s of process.argv.slice(2).map(Number)) {
    const r = await buildAlliances(s);
    console.log(s, `${Object.keys(r).length} events with official alliances`);
  }
}
