// Downloads each event's awards from FTCScout into .cache/awards/<season>/<code>.json.
// Finished events are fetched once and kept; others are refetched each run.
//
//   node scripts/fetch-awards.mjs 2025

import fs from "node:fs/promises";
import path from "node:path";
import { gql } from "./fetch.mjs";

const CONCURRENCY = 4;
const Q = `query($season: Int!, $code: String!) { eventByCode(season: $season, code: $code) { awards { teamNumber type placement } } }`;

for (const season of process.argv.slice(2).map(Number)) {
  const evDir = path.join(".cache", String(season));
  const outDir = path.join(".cache", "awards", String(season));
  await fs.mkdir(outDir, { recursive: true });
  const todo = [];
  for (const f of await fs.readdir(evDir).catch(() => [])) {
    const ev = JSON.parse(await fs.readFile(path.join(evDir, f), "utf8"));
    if (ev.remote) continue;
    const have = await fs.stat(path.join(outDir, f)).then(() => true, () => false);
    if (!have || !ev.finished) todo.push(ev.code);
  }
  console.log(`${season}: fetching awards for ${todo.length} events (rest cached)`);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length) {
      const code = todo[i++];
      const { eventByCode } = await gql(Q, { season, code });
      await fs.writeFile(path.join(outDir, `${code}.json`), JSON.stringify(eventByCode?.awards ?? []));
    }
  }));
}
