// Matches the official clock puts just AFTER a livestream ended, at events where that stream
// covered the earlier matches (e.g. USGADUGM3: Q-10..Q-19 "after" a 93-min stream that really
// shows them). FIRST's recorded times for the later matches can be off, so look at the video:
// fit those tail matches by on-screen match rhythm anywhere in the stream, and where the fit is
// clear, file their spots in site/videos/timestamped.json (spots beat the clock in videoFor).
//
//   node scripts/refit-tails.mjs [--limit 40] [--dry-run]
//
// A trickle on youtube.com (global rule): one video at a time, ≥1.5 s between requests,
// ≥30 s between videos, and stop for good at the first bot check.

import fs from "node:fs/promises";
import path from "node:path";
import { frames, calibrate, storyboardSpec } from "./calibrate-streams.mjs";
import { videoFor } from "../site/js/ui.js";

const args = process.argv.slice(2);
const limit = +(args[args.indexOf("--limit") + 1] || 0) || Infinity;
const dry = args.includes("--dry-run");
const LEAD = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => d);

// 1. targets: uncovered matches within 3 h after the end of a stream filed to the event
const targets = [];
for (const s of [2019, 2020, 2021, 2022, 2023, 2024, 2025]) {
  const v = await readJson(path.join("site", "data", String(s), "videos.json"), {});
  for (const [code, e] of Object.entries(v)) {
    const ev = await readJson(path.join("site", "data", String(s), "event", `${code}.json`), null);
    if (!ev || !e.streams.length) continue;
    const ms = ev.matchList.filter((m) => m.played && m.time);
    for (const st of e.streams) {
      const tail = ms.filter((m) => m.time > st.end && m.time - st.end < 3 * 3600e3 && !videoFor(v, code, m.time)).sort((a, b) => a.time - b.time);
      if (tail.length >= 3) targets.push({ season: s, code, id: st.id, start: st.start, end: st.end, tail });
    }
  }
}
targets.sort((a, b) => b.tail.length - a.tail.length);
console.log(`${targets.length} streams with ≥3 matches just after they end; trying ${Math.min(limit, targets.length)}`);

// 2. are we allowed on youtube.com today? one request; a bot check stops everything
try { await storyboardSpec("vzy8si7yo_Q"); }
catch (e) { console.log("YouTube is still bot-checking this IP; not running today:", e.message); process.exit(0); }

const tsFile = path.join("site", "videos", "timestamped.json");
let placed = 0, tried = 0;
for (const t of targets.slice(0, limit)) {
  tried++;
  await sleep(30000);
  let fr;
  try { fr = await frames(t.id, { pause: 1500 }); }
  catch (e) { console.log("stopping: YouTube bot check", e.message); break; }
  if (!fr) { console.log(`  ${t.code} ${t.id}: no preview frames`); continue; }
  const len = fr.count * fr.interval;
  const t0 = t.tail[0].time, pos = t.tail.map((m) => (m.time - t0) / 1000);
  // tail match j sits at pos_j - o in the video; anywhere in it: o in [pos_last - len, pos_0]
  const r = await calibrate(fr, pos, 0, { lo: Math.round(pos.at(-1) - len), hi: 0 });
  // the tail must start after the clock-placed matches (it's the same stream, later in it)
  const clockEnd = (t.end - t.start) / 1000, tailStart = pos[0] - r.o;
  const ok = r.ok && r.lift > 1 && tailStart > clockEnd * 0.3;
  console.log(`  ${t.season} ${t.code} ${t.id}: ${t.tail.length} tail matches -> ${ok ? `placed from ${Math.round(tailStart / 60)} min` : "no clear fit"} (lift ${r.lift?.toFixed(1)}, rival ${r.rival?.toFixed(2)}, halves ${r.halves})`);
  if (!ok || dry) continue;
  const spots = {};
  t.tail.forEach((m, j) => { const at = Math.round(pos[j] - r.o) - LEAD; if (at >= 0 && at < len) spots[m.d] = at; });
  if (Object.keys(spots).length < 3) continue;
  const ts = await readJson(tsFile, {});
  ((ts[t.season] ??= {})[t.code] ??= {})[t.id] = { ...(ts[t.season][t.code][t.id] ?? {}), ...spots };
  await fs.writeFile(tsFile, JSON.stringify(ts, null, 1) + "\n");
  placed += Object.keys(spots).length;
}
console.log(`tried ${tried} streams, placed ${placed} tail matches`);
