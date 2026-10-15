// How many played matches the site can show video for, per season and overall.
// Reads the built site/data (run `npm run videos` first). Lists the events with the
// most uncovered matches so a video hunt knows where to look.
//
//   node scripts/video-coverage.mjs [--gaps N] [--json out.json]

import fs from "node:fs";
import { videoFor } from "../site/js/ui.js";

const args = process.argv.slice(2);
const gapsN = Number(args[args.indexOf("--gaps") + 1]) || 0;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const seasons = JSON.parse(fs.readFileSync("site/data/seasons.json", "utf8")).map?.((s) => s.season ?? s) ?? [];
const all = { matches: 0, covered: 0 };
const gaps = [];
for (const season of seasons) {
  const dir = `site/data/${season}`;
  if (!fs.existsSync(`${dir}/events.json`)) continue;
  const videos = fs.existsSync(`${dir}/videos.json`) ? JSON.parse(fs.readFileSync(`${dir}/videos.json`, "utf8")) : {};
  let matches = 0, covered = 0;
  for (const file of fs.readdirSync(`${dir}/event`)) {
    const ev = JSON.parse(fs.readFileSync(`${dir}/event/${file}`, "utf8"));
    const played = (ev.matchList ?? []).filter((m) => m.played);
    const have = played.filter((m) => videoFor(videos, ev.code, m.time)).length;
    matches += played.length; covered += have;
    if (played.length > have) {
      const days = [...new Set(played.map((m) => m.time && new Date(m.time).toISOString().slice(0, 10)).filter(Boolean))];
      gaps.push({ season, code: ev.code, name: ev.name, loc: ev.loc, type: ev.type, matches: played.length, missingMatches: played.length - have, haveVideo: have > 0, matchDays: days });
    }
  }
  all.matches += matches; all.covered += covered;
  console.log(season, `${covered}/${matches} matches with video (${(100 * covered / (matches || 1)).toFixed(1)}%)`);
}
console.log("all", `${all.covered}/${all.matches} (${(100 * all.covered / all.matches).toFixed(1)}%); 50% needs ${Math.max(0, Math.ceil(all.matches / 2) - all.covered)} more`);
gaps.sort((a, b) => b.missingMatches - a.missingMatches);
if (gapsN) for (const g of gaps.slice(0, gapsN)) console.log(g.season, g.code, g.missingMatches, g.haveVideo ? "(partial)" : "", g.name, g.matchDays.join(","));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(gaps, null, 1));
