// Adds event videos found by hand (or by a search), checking each one first.
//
//   node scripts/add-videos.mjs 2025 <url|id>[@EVENTCODE] …
//   node scripts/add-videos.mjs 2025 --file candidates.json   ({ videos: [{ videoId, code }], channels: [{ channelId }] })
//   node scripts/add-videos.mjs 2025 --per-match-channel UC…   (a channel with one upload per match)
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
} else if (!args.includes("--per-match-channel")) {
  cands = args.map((a) => { const [u, code] = a.split("@"); return { id: youtubeId(u) ?? u, code }; });
}
// --per-match-channel UC…: a channel that uploads one video per match. Titles that differ
// only by match number are one event; tie each group to the event whose name it shares,
// whose dates fit, and that has those match numbers.
const pmAt = args.indexOf("--per-match-channel");
if (pmAt >= 0) {
  const ch = args[pmAt + 1], vids = [];
  let tok = "";
  for (let p = 0; p < 40; p++) {
    const r = await (await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=UU${ch.slice(2)}&key=${key}${tok ? `&pageToken=${tok}` : ""}`)).json();
    if (r.error) throw new Error(`YouTube: ${r.error.message}`);
    for (const i of r.items) vids.push({ id: i.snippet.resourceId.videoId, title: i.snippet.title, at: Date.parse(i.snippet.publishedAt) });
    if (!(tok = r.nextPageToken)) break;
  }
  const STOP = new Set("ftc first tech challenge decode match matches qualification qual playoff playoffs final finals semifinal game the and of at for into deep".split(" "));
  const words = (t) => new Set(t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
  const groups = new Map();
  for (const v of vids) {
    const d = titleMatch(v.title);
    if (!d) continue;
    const key = v.title.replace(/\b(?:Qualification|Qual|Q|Playoff(?:\s*Match)?|Match|M|Semi-?final|Finals?)[\s#-]*\d+(?:[-, ]\s*\d)?/gi, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    (groups.get(key) ?? groups.set(key, []).get(key)).push({ ...v, d });
  }
  const dir = path.join("site", "data", String(season), "event");
  const evs = [];
  for (const f of await fs.readdir(dir)) { const e = await readJson(path.join(dir, f), null); if (e?.matchList?.length) evs.push(e); }
  for (const [key, g] of groups) {
    const w = words(key), first = Math.min(...g.map((v) => v.at));
    const fits = evs.filter((e) => first >= Date.parse(e.start) - 864e5 && first <= Date.parse(e.end) + 60 * 864e5)
      .map((e) => ({ e, shared: [...words(e.name)].filter((x) => w.has(x)).length, has: g.filter((v) => e.matchList.some((m) => m.d === v.d)).length / g.length }))
      .filter((x) => x.shared >= 1 && x.has >= 0.8).sort((a, b) => b.shared - a.shared);
    if (!fits.length || (fits[1] && fits[1].shared === fits[0].shared)) { console.log(`  ? ${g.length} videos "${key}": ${fits.length ? "ambiguous" : "no event"}`); continue; }
    console.log(`  → ${fits[0].e.code} <= ${g.length} videos "${key}"`);
    for (const v of g) cands.push({ id: v.id, code: fits[0].e.code, trusted: true });
  }
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
// "Qualification 12", "Qual 12", "Q12", "Q-01", "Playoff M-03", "Playoff 3", "Playoff Match 3", "Match 3", "Semifinal 1-2", "Final 2"
function titleMatch(t) {
  let x;
  if ((x = t.match(/\b(?:Qualification|Qual|Q)[\s#-]*(\d{1,3})\b/i))) return `Q-${+x[1]}`;
  if ((x = t.match(/\bSemi-?final\s*(\d)\s*[-, ]\s*(?:game\s*|match\s*)?(\d)\b/i))) return `SF${x[1]}-${x[2]}`;
  if ((x = t.match(/\bFinals?\s*(?:game\s*|match\s*)?#?\s*(\d)\b/i))) return `F-${x[1]}`;
  if (/tie-?breaker|replay/i.test(t)) return null; // replays are numbered differently
  if ((x = t.match(/\b(?:Playoff\s*)?M-(\d{1,2})\b/))) return `M-${+x[1]}`;
  if ((x = t.match(/\b(?:Playoff(?:\s*Match)?|Match)\s*#?\s*(\d{1,2})\b/i))) return `M-${+x[1]}`;
  return null;
}

const tsFile = path.join("site", "videos", "timestamped.json"), ovFile = path.join("site", "videos", "overrides.json"), chFile = path.join("site", "videos", "channels.json");
const upFile = path.join("site", "videos", "uploads.json");
const ts = await readJson(tsFile, {}), ov = await readJson(ovFile, {}), chs = await readJson(chFile, []), up = await readJson(upFile, {});
ts[season] ??= {}; ov[season] ??= {}; up[season] ??= {};
const lives = {}; // code -> [{ c, title, inside: Set(times), total }]
const tally = { timestamped: 0, perMatch: 0, livestream: 0, upload: 0, rejected: 0 };
const why = (c, msg) => { tally.rejected++; console.log(`  ✗ ${c.id} ${c.code ?? ""}: ${msg}`); };

for (const c of cands) {
  const v = info[c.id];
  if (!v) { why(c, "private, deleted or not found"); continue; }
  const region = v.contentDetails?.regionRestriction ?? {};
  // embedding turned off is fine (the site opens those on YouTube); blocked in the US is not
  if ((region.blocked ?? []).includes("US") || (region.allowed && !region.allowed.includes("US"))) { why(c, "blocked in the US"); continue; }
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
  let d = titleMatch(title);
  // a bare "Match 5" from a team's own channel is usually *their* 5th match, not Q-5:
  // trust it only from channels that upload every match of an event (--per-match-channel)
  if (d && !c.trusted && !/\b(?:Qualification|Qual|Q[\s#-]*\d|Playoff|Elimination|Semi-?final|Finals?|M-\d)/i.test(title)) d = null;
  // "Match 3" at a league meet (no playoffs) is qualification 3
  if (d?.startsWith("M-") && ev && !/playoff/i.test(title) && !ev.matchList.some((m) => m.d.startsWith("M-"))) d = `Q-${d.slice(2)}`;
  const seconds = v.contentDetails?.duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const len = seconds ? (+(seconds[1] ?? 0)) * 3600 + (+(seconds[2] ?? 0)) * 60 + +(seconds[3] ?? 0) : 0;
  if (d && len && len < 20 * 60 && ev) {
    const pub = Date.parse(v.snippet.publishedAt), from = Date.parse(ev.start) - 864e5, to = Date.parse(ev.end) + 60 * 864e5;
    if (!ev.matchList.some((m) => m.d === d)) { why(c, `${ev.code} has no match ${d}`); continue; }
    if (pub < from || pub > to) { why(c, `published ${v.snippet.publishedAt.slice(0, 10)}, not near ${ev.code} (${ev.start})`); continue; }
    (ts[season][ev.code] ??= {})[c.id] = { [d]: 0 };
    tally.perMatch++; console.log(`  ✓ ${ev.code} ${d} ${title}`); continue;
  }
  // 3. a livestream recording: judged together with the event's other streams below
  if (live.actualStartTime && live.actualEndTime) {
    if (!ev) { why(c, "livestream but no event code given"); continue; }
    const s = Date.parse(live.actualStartTime) - 60e3, e = Date.parse(live.actualEndTime) + 60e3;
    const times = ev.matchList.filter((m) => m.played && m.time).map((m) => m.time);
    const inside = new Set(times.filter((t) => t >= s && t <= e));
    (lives[ev.code] ??= []).push({ c, title, inside, total: times.length });
    continue;
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
// livestreams: each must hold a real share of the event's matches (one day of two is
// ~half), and together they must cover at least 30% (a late-starting stream still
// gives the right video for the matches it has: a match only uses a stream it falls inside)
for (const [code, ls] of Object.entries(lives)) {
  const real = ls.filter((l) => l.inside.size / (l.total || 1) >= 0.15);
  const union = new Set(real.flatMap((l) => [...l.inside])).size / (ls[0].total || 1);
  for (const l of ls) {
    const share = Math.round((l.inside.size / (l.total || 1)) * 100);
    if (!real.includes(l)) { why(l.c, `only ${share}% of ${code}'s matches happened while it was live`); continue; }
    if (union < 0.3) { why(l.c, `${code}'s streams together cover only ${Math.round(union * 100)}% of its matches`); continue; }
    const o = (ov[season][code] ??= {});
    o.streams = [...new Set([...(o.streams ?? []), `https://youtu.be/${l.c.id}`])];
    tally.livestream++; console.log(`  ✓ ${code} livestream, ${share}% of matches inside: ${l.title}`);
  }
}
let newCh = 0;
for (const ch of channels) if (!chs.includes(ch)) { chs.push(ch); newCh++; }

await fs.writeFile(tsFile, JSON.stringify(ts, null, 1) + "\n");
await fs.writeFile(ovFile, JSON.stringify(ov, null, 1) + "\n");
await fs.writeFile(chFile, JSON.stringify(chs, null, 1) + "\n");
await fs.writeFile(upFile, JSON.stringify(up, null, 1) + "\n");
console.log(`${season}: ${tally.timestamped} timestamped, ${tally.perMatch} single-match, ${tally.livestream} livestreams added, ${tally.upload} uploads to calibrate; ${tally.rejected} rejected; ${newCh} new channels`);
console.log("next: node scripts/videos.mjs", season);
