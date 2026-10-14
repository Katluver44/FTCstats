// Measures livestream clock offsets by reading the scoreboard overlay ("Qualification 12
// of 40" + the match clock) in YouTube's preview thumbnails, for streams the rhythm fit in
// calibrate-streams.mjs couldn't settle (most of them: one match cycle looks like the next).
// Same acceptance rules as calibrate-uploads.mjs: 5+ readings agree, at least 40% of all
// readings, and the overlay's "of N" is this event's qual count.
//
// Writes site/videos/ocr-calibrated.json { season: { videoId: seconds } }, same meaning and
// sign as calibrated.json (how many seconds EARLIER matches appear in the recording than
// the official times say). videos.mjs applies it over calibrated.json; offsets.json wins.
// A single offset can't follow a stream that paused, cut out or drifted, so it also writes
// site/videos/ocr-spots.json { season: { event: { videoId: { "Q-12": seconds } } } }: the
// exact spot (5 s before the start) of every match whose auto clock was read clearly.
//
//   node scripts/ocr-calibrate-streams.mjs 2025 [2024 …] [--all] [--limit N] [--verbose]
//     --all    also re-measure streams the rhythm fit already accepted
//
// Gentle on YouTube: one stream at a time, and it stops at the first sign of YouTube's
// "confirm you're not a bot" page (progress is cached; run it again later).
// macOS only (sips + Vision via scripts/ocr/ocr.js).

import fs from "node:fs/promises";
import path from "node:path";
import { ocrAlign, ocrReads } from "./ocr-align.mjs";

const args = process.argv.slice(2);
const all = args.includes("--all"), verbose = args.includes("--verbose");
const li = args.indexOf("--limit"), limit = li >= 0 ? +args[li + 1] : Infinity;
const seasons = args.filter((a) => /^\d{4}$/.test(a)).map(Number);
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const outFile = path.join("site", "videos", "ocr-calibrated.json");
const out = await readJson(outFile, {});
const spotsFile = path.join("site", "videos", "ocr-spots.json");
const spotsOut = await readJson(spotsFile, {});
const LEAD = 5; // seconds before the match starts, as for measured streams on the site
const hand = await readJson(path.join("site", "videos", "offsets.json"), {});
let tried = 0;

for (const season of seasons) {
  const videos = await readJson(path.join("site", "data", String(season), "videos.json"), {});
  const raw = await readJson(path.join(".cache", "videos", `${season}.json`), {}); // stream start before any offset
  const rhythm = await readJson(path.join(".cache", "calibration", `${season}.json`), {});
  const cacheFile = path.join(".cache", "calibration", `ocr-streams-${season}.json`);
  const cache = await readJson(cacheFile, {});
  out[season] ??= {};
  spotsOut[season] ??= {};

  const jobs = [];
  for (const [code, v] of Object.entries(videos)) {
    for (const s of v.streams) {
      const r = raw[s.id];
      if (!r?.start || hand[season]?.[s.id] != null) continue;
      if (!all && rhythm[s.id]?.ok) continue;
      jobs.push({ code, id: s.id, start: r.start, end: r.end ?? r.start + (r.seconds ?? 0) * 1000 });
    }
  }
  let blocked = false, accepted = 0;
  for (const job of jobs) {
    const key = `${job.id}@${job.code}`;
    if (!(key in cache)) {
      if (tried >= limit) break;
      tried++;
      const ev = await readJson(path.join("site", "data", String(season), "event", `${job.code}.json`), null);
      // only the matches inside this stream's window (a multi-day event has one stream a day)
      const ms = windowMatches(ev, job);
      if (ms.length < 6) { cache[key] = { skip: "fewer than 6 matches in the window" }; continue; }
      try {
        const r = await ocrAlign(job.id, { matchList: ms }, { every: 1 });
        // ocrAlign: match j at video time (time_j - t0)/1000 - o, t0 = first match in the list.
        // Our links: video time = (time_j - start)/1000 - offset, so offset = o + (t0 - start)/1000.
        const t0 = Math.min(...ms.map((m) => m.time));
        cache[key] = r ? { ...r, offset: r.o == null ? null : Math.round(r.o + (t0 - job.start) / 1000) } : { error: "no storyboard" };
      } catch (e) {
        if (/rate-limit|not a bot|LOGIN_REQUIRED/i.test(e.message)) { blocked = true; break; }
        cache[key] = { error: e.message.slice(0, 120) };
      }
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(cache));
      if (verbose) console.log(season, job.code, job.id, JSON.stringify(cache[key]));
      await sleep(1500);
    }
    const r = cache[key];
    const ok = r?.offset != null && r.agree >= 5 && r.agree / r.est >= 0.4 && (r.ofMatch == null || r.ofMatch >= 0.6);
    if (ok) {
      out[season][job.id] = r.offset; accepted++;
      // exact per-match spots: 2+ auto-clock reads within 20 s of each other, and within
      // 5 min of where the offset puts the match (guards against misread match numbers)
      const reads = await ocrReads(job.id).catch(() => null);
      const ev = await readJson(path.join("site", "data", String(season), "event", `${job.code}.json`), null);
      const starts = {};
      for (const x of reads ?? []) if (x.left > 120 && x.left < 150) (starts[x.d] ??= []).push(x.t - (150 - x.left));
      const spots = {};
      for (const m of windowMatches(ev, job)) {
        const xs = (starts[m.d] ?? []).sort((a, b) => a - b);
        if (xs.length < 2 || xs.at(-1) - xs[0] > 20) continue;
        const at = xs[xs.length >> 1], expect = (m.time - job.start) / 1000 - r.offset;
        if (Math.abs(at - expect) <= 300) spots[m.d] = Math.max(0, Math.round(at - LEAD));
      }
      if (Object.keys(spots).length) (spotsOut[season][job.code] ??= {})[job.id] = spots;
    }
  }
  console.log(`${season}: ${accepted} streams placed by the overlay (${jobs.length} candidates)${blocked ? " — stopped: YouTube is asking to confirm we're not a bot; run again later" : ""}`);
  if (blocked) break;
}
await fs.writeFile(outFile, JSON.stringify(out, null, 1) + "\n");
await fs.writeFile(spotsFile, JSON.stringify(spotsOut) + "\n");

// the event's played matches inside a stream's window (a multi-day event has one stream a day)
function windowMatches(ev, job) {
  return (ev?.matchList ?? []).filter((m) => m.played && m.time && m.time >= job.start - 1800e3 && m.time <= job.end + 1800e3);
}
