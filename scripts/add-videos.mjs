// Adds event videos found by hand (or by a search), checking each one first.
//
//   node scripts/add-videos.mjs 2025 <url|id>[@EVENTCODE] …
//   node scripts/add-videos.mjs 2025 --file candidates.json   ({ videos: [{ videoId, code }], channels: [{ channelId }] })
//
// Each video is filed by what it is:
//  - description times every match ("0:54:52 Q1 …")  -> site/videos/timestamped.json
//    (the event is decided by line-ups / match rhythm, not by the given code)
//  - one match per video ("Qualification 12 - …")     -> timestamped.json at 0:00, if published near the event
//  - livestream recording                              -> site/videos/overrides.json, if it was live
//    during at least half of the event's matches
//  - a long upload with no timestamps                 -> site/videos/uploads.json, for calibrate-uploads.mjs
// Channels are added to site/videos/channels.json, which find-timestamped.mjs scans.

import fs from "node:fs/promises";
import path from "node:path";
import { youtubeId } from "./videos.mjs";
import { parseTimestamps, matchEvent } from "./find-timestamped.mjs";

const args = process.argv.slice(2);
const season = +args.shift();
const fileAt = args.indexOf("--file");
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const key = process.env.YOUTUBE_API_KEY ?? (await fs.readFile(".env", "utf8").catch(() => "")).match(/^YOUTUBE_API_KEY=(\S+)/m)?.[1];
if (!season || !key) throw new Error("usage: node scripts/add-videos.mjs <season> <url|id>[@CODE]… | --file f.json  (needs YOUTUBE_API_KEY)");

let cands = [], channels = [];
if (fileAt >= 0) {
  const f = await readJson(args[fileAt + 1], {});
  cands = (f.videos ?? []).map((v) => ({ id: youtubeId(v.videoId) ?? v.videoId, code: v.code, note: v.title ?? "" }));
  channels = (f.channels ?? []).map((c) => c.channelId).filter((c) => /^UC[\w-]{22}$/.test(c));
} else {
  cands = args.map((a) => { const [u, code] = a.split("@"); return { id: youtubeId(u) ?? u, code }; });
}
cands = cands.filter((c) => /^[\w-]{11}$/.test(c.id ?? ""));

// details, 50 per call (1 quota unit each)
const info = {};
const ids = [...new Set(cands.map((c) => c.id))];
for (let i = 0; i < ids.length; i += 50) {
  const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails,contentDetails,status&id=${ids.slice(i, i + 50).join(",")}&key=${key}`;
  const r = await (await fetch(u)).json();
  if (r.error) throw new Error(`YouTube: ${r.error.message}`);
  for (const v of r.items ?? []) info[v.id] = v;
}

const evCache = new Map();
const event = async (code) => {
  if (!evCache.has(code)) evCache.set(code, await readJson(path.join("site", "data", String(season), "event", `${code}.json`), null));
  return evCache.get(code);
};
// "Qualification 12", "Qual 12", "Q12", "Playoff Match 3", "Match 3", "Semifinal 1-2", "Final 2"
function titleMatch(t) {
  let x;
  if ((x = t.match(/\b(?:Qualification|Qual|Q)\s*#?\s*(\d{1,3})\b/i))) return `Q-${+x[1]}`;
  if ((x = t.match(/\bSemi-?final\s*(\d)\s*[-, ]\s*(?:game\s*|match\s*)?(\d)\b/i))) return `SF${x[1]}-${x[2]}`;
  if ((x = t.match(/\bFinals?\s*(?:game\s*|match\s*)?#?\s*(\d)\b/i))) return `F-${x[1]}`;
  if ((x = t.match(/\b(?:Playoff\s*)?Match\s*#?\s*(\d{1,2})\b/i))) return `M-${+x[1]}`;
  return null;
}

const tsFile = path.join("site", "videos", "timestamped.json"), ovFile = path.join("site", "videos", "overrides.json"), chFile = path.join("site", "videos", "channels.json");
const upFile = path.join("site", "videos", "uploads.json");
const ts = await readJson(tsFile, {}), ov = await readJson(ovFile, {}), chs = await readJson(chFile, []), up = await readJson(upFile, {});
ts[season] ??= {}; ov[season] ??= {}; up[season] ??= {};
const tally = { timestamped: 0, perMatch: 0, livestream: 0, upload: 0, rejected: 0 };
const why = (c, msg) => { tally.rejected++; console.log(`  ✗ ${c.id} ${c.code ?? ""}: ${msg}`); };

for (const c of cands) {
  const v = info[c.id];
  if (!v) { why(c, "private, deleted or not found"); continue; }
  const region = v.contentDetails?.regionRestriction ?? {};
  if (v.status?.embeddable === false || (region.blocked ?? []).includes("US") || (region.allowed && !region.allowed.includes("US"))) { why(c, "can't be embedded / blocked in the US"); continue; }
  const title = v.snippet.title, live = v.liveStreamingDetails ?? {};
  if (/\b(vex|frc|fll|lego|rebuilt)\b/i.test(title)) { why(c, `not FTC: ${title}`); continue; }

  // 1. timestamps in the description
  const stamps = parseTimestamps(v.snippet.description);
  if (stamps.filter((s) => s.d.startsWith("Q-")).length >= 3) {
    const code = await matchEvent(season, stamps);
    if (code) {
      (ts[season][code] ??= {})[c.id] = Object.fromEntries(stamps.map((s) => [s.d, s.at]));
      tally.timestamped++; console.log(`  ✓ ${code} timestamps (${stamps.length}) ${title}`); continue;
    }
  }
  const ev = c.code ? await event(c.code) : null;
  // 2. a single match
  const d = titleMatch(title);
  const seconds = v.contentDetails?.duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const len = seconds ? (+(seconds[1] ?? 0)) * 3600 + (+(seconds[2] ?? 0)) * 60 + +(seconds[3] ?? 0) : 0;
  if (d && len && len < 20 * 60 && ev) {
    const pub = Date.parse(v.snippet.publishedAt), from = Date.parse(ev.start) - 864e5, to = Date.parse(ev.end) + 60 * 864e5;
    if (!ev.matchList.some((m) => m.d === d)) { why(c, `${ev.code} has no match ${d}`); continue; }
    if (pub < from || pub > to) { why(c, `published ${v.snippet.publishedAt.slice(0, 10)}, not near ${ev.code} (${ev.start})`); continue; }
    (ts[season][ev.code] ??= {})[c.id] = { [d]: 0 };
    tally.perMatch++; console.log(`  ✓ ${ev.code} ${d} ${title}`); continue;
  }
  // 3. a livestream recording that was live during the event's matches
  if (live.actualStartTime && live.actualEndTime) {
    if (!ev) { why(c, "livestream but no event code given"); continue; }
    const s = Date.parse(live.actualStartTime) - 60e3, e = Date.parse(live.actualEndTime) + 60e3;
    const times = ev.matchList.filter((m) => m.played && m.time).map((m) => m.time);
    const inside = times.filter((t) => t >= s && t <= e).length / (times.length || 1);
    if (inside < 0.5) { why(c, `live ${live.actualStartTime.slice(0, 16)}, only ${Math.round(inside * 100)}% of ${ev.code}'s matches inside`); continue; }
    const o = (ov[season][ev.code] ??= {});
    o.streams = [...new Set([...(o.streams ?? []), `https://youtu.be/${c.id}`])];
    tally.livestream++; console.log(`  ✓ ${ev.code} livestream, ${Math.round(inside * 100)}% of matches inside: ${title}`); continue;
  }
  // 4. a long recording with no clock: kept for calibrate-uploads.mjs, which finds where
  // the event's match rhythm sits in it
  if (ev && len > 45 * 60) {
    const pub = Date.parse(v.snippet.publishedAt);
    if (pub < Date.parse(ev.start) - 864e5 || pub > Date.parse(ev.end) + 120 * 864e5) { why(c, `published ${v.snippet.publishedAt.slice(0, 10)}, not near ${ev.code} (${ev.start})`); continue; }
    const u = (up[season][ev.code] ??= []);
    if (!u.includes(c.id)) u.push(c.id);
    tally.upload++; console.log(`  … ${ev.code} long upload, needs calibrate-uploads: ${title}`); continue;
  }
  why(c, `no timestamps, not a livestream, no event to place it in: ${title}`);
}
let newCh = 0;
for (const ch of channels) if (!chs.includes(ch)) { chs.push(ch); newCh++; }

await fs.writeFile(tsFile, JSON.stringify(ts, null, 1) + "\n");
await fs.writeFile(ovFile, JSON.stringify(ov, null, 1) + "\n");
await fs.writeFile(chFile, JSON.stringify(chs, null, 1) + "\n");
await fs.writeFile(upFile, JSON.stringify(up, null, 1) + "\n");
console.log(`${season}: ${tally.timestamped} timestamped, ${tally.perMatch} single-match, ${tally.livestream} livestreams added, ${tally.upload} uploads to calibrate; ${tally.rejected} rejected; ${newCh} new channels`);
console.log("next: node scripts/videos.mjs", season);
