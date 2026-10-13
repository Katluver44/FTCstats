// Checks our ranking-score math against FIRST's official numbers.
//   node scripts/check-rs.mjs 2024
import fs from "node:fs";
import path from "node:path";
import { replayEvent, forecastRankings } from "../site/js/live.js";

const season = Number(process.argv[2] ?? 2025);
const dir = path.join("site", "data", String(season));
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json")));
const events = JSON.parse(fs.readFileSync(path.join(dir, "events.json")))
  .filter((e) => (season >= 2026 || /Championship|Qualifier/.test(e.type)) && e.played > 6).slice(0, 25);
let ok = 0, n = 0;
for (const e of events) {
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "event", `${e.code}.json`)));
  const { matches } = replayEvent(meta, ev, ev.matchList);
  for (const r of forecastRankings(season, ev.teamList.map((t) => t.team), matches, 1)) {
    const off = ev.teamList.find((t) => t.team === r.team).rp;
    if (off == null || r.currentRs == null) continue;
    n++;
    if (Math.abs(off - r.currentRs) < 0.01) ok++;
  }
}
console.log(`${season}: ${ok}/${n} ranking scores match official (${events.length} events)`);
// fail the deploy if our ranking math has drifted from FIRST's
if (n >= 50 && ok / n < 0.9) {
  console.error("Ranking scores no longer match official results; check winRp/tieRp in site/js/seasons.js");
  process.exit(1);
}
