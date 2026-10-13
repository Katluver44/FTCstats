// Places matches in long event uploads that have no timestamps (site/videos/uploads.json,
// filled by add-videos.mjs). We don't know when such a video starts, so slide the
// event's official match schedule across the whole video's preview thumbnails and keep
// the spot where in-match frames stand out most (same method as calibrate-streams.mjs,
// same checks: a clear peak, and both halves of the day agreeing).
// Accepted videos get a spot per match in site/videos/timestamped.json.
//
//   node scripts/calibrate-uploads.mjs 2025 [--verbose]
// macOS only (sips), like calibrate-streams.mjs.

import fs from "node:fs/promises";
import path from "node:path";
import { frames, calibrate } from "./calibrate-streams.mjs";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const seasons = args.filter((a) => /^\d{4}$/.test(a)).map(Number);
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const LEAD = 20;

const up = await readJson(path.join("site", "videos", "uploads.json"), {});
const tsFile = path.join("site", "videos", "timestamped.json");
const ts = await readJson(tsFile, {});
for (const season of seasons) {
  const cacheFile = path.join(".cache", "calibration", `uploads-${season}.json`);
  const cache = await readJson(cacheFile, {});
  ts[season] ??= {};
  let placed = 0, tried = 0;
  for (const [code, ids] of Object.entries(up[season] ?? {})) {
    const ev = await readJson(path.join("site", "data", String(season), "event", `${code}.json`), null);
    const ms = (ev?.matchList ?? []).filter((m) => m.played && m.time).sort((a, b) => a.time - b.time);
    if (ms.length < 6) continue;
    const t0 = ms[0].time;
    const pos = ms.map((m) => (m.time - t0) / 1000);
    for (const id of ids) {
      tried++;
      if (!cache[id]) {
        const fr = await frames(id).catch(() => null);
        if (!fr) { cache[id] = { error: "no storyboard" }; continue; }
        const len = fr.count * fr.interval;
        // first match sits somewhere in the video: shift o puts it at -o, so o in [-len, 0]
        cache[id] = { ...(await calibrate(fr, pos, 0, { lo: -Math.round(len), hi: 600 })), len: Math.round(len) };
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(cache));
      }
      const r = cache[id];
      if (verbose) console.log(code, id, JSON.stringify(r));
      if (!r.ok) continue;
      const spots = {};
      ms.forEach((m, j) => { const at = Math.round(pos[j] - r.o) - LEAD; if (at >= 0 && at < r.len) spots[m.d] = at; });
      if (Object.keys(spots).length >= ms.length * 0.5) { (ts[season][code] ??= {})[id] = spots; placed++; }
    }
  }
  console.log(`${season}: ${placed} of ${tried} uploads placed`);
}
await fs.writeFile(tsFile, JSON.stringify(ts, null, 1) + "\n");
