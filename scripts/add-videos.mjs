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
import { pageDetailsMany } from "./yt-page.mjs";
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
  // `match`: the official match id when a search worked it out from the schedule (a team's
  // "our 3rd match" upload); still checked against the event's matches and dates below
  cands = (f.videos ?? []).map((v) => ({ id: youtubeId(v.videoId) ?? v.videoId, code: v.code, note: v.title ?? "",
    match: /^(Q-\d+|SF\d-\d|F-\d|M-\d+)$/.test(v.match ?? "") ? v.match : null }));
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
    const d = titleMatch(v.title, true);
    if (!d) continue;
    const dm = v.title.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/); // "1/10/26" -> 2026-01-10
    const date = dm ? `${dm[3].length === 2 ? "20" + dm[3] : dm[3]}-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}` : null;
    const key = (date ? date + " " : "") + v.title.replace(/\b(?:Qualification|Qual|Q|Playoff(?:\s*Match)?|Match|M|Semi-?final|Finals?)[\s#-]*\d+(?:[-, ]\s*\d)?/gi, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    (groups.get(key) ?? groups.set(key, []).get(key)).push({ ...v, d });
  }
  const dir = path.join("site", "data", String(season), "event");
  const evs = [];
  for (const f of await fs.readdir(dir)) { const e = await readJson(path.join(dir, f), null); if (e?.matchList?.length) evs.push(e); }
  for (const [key, g] of groups) {
    const w = words(key), first = Math.min(...g.map((v) => v.at));
    const date = key.match(/^(\d{4}-\d\d-\d\d) /)?.[1];
    const fits = evs.filter((e) => first >= Date.parse(e.start) - 864e5 && first <= Date.parse(e.end) + 60 * 864e5)
      .filter((e) => !date || (date >= e.start.slice(0, 10) && date <= e.end.slice(0, 10))) // the title's date must be the event's
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
let i = 0;
for (; i < ids.length; i += 50) {
  const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails,contentDetails,status&id=${ids.slice(i, i + 50).join(",")}&key=${key}`;
  const r = await (await fetch(u)).json();
  if (r.error && /quota/i.test(r.error.message)) break;
  if (r.error) throw new Error(`YouTube: ${r.error.message}`);
  for (const v of r.items ?? []) info[v.id] = v;
}
if (i < ids.length) { // API quota used up: YouTube's own player data instead
  console.log(`  API quota used up; reading ${ids.length - i} videos from YouTube's pages`);
  const got = await pageDetailsMany(ids.slice(i), { log: console.log });
  const later = new Set(got.__blocked ?? []);
  delete got.__blocked;
  Object.assign(info, got);
  if (later.size) { console.log(`  ${later.size} videos left for the next run`); cands = cands.filter((c) => !later.has(c.id)); }
}

const evCache = new Map();
const event = async (code) => {
  if (!evCache.has(code)) evCache.set(code, await readJson(path.join("site", "data", String(season), "event", `${code}.json`), null));
  return evCache.get(code);
};
// "Qualification 12", "Qual 12", "Q12", "Q-01", "Playoff M-03", "Playoff 3", "Playoff Match 3", "Match 3", "Semifinal 1-2", "Final 2"
function titleMatch(t, bareM = false) {
  let x;
  if ((x = t.match(/\b(?:Qualifications?|Quals?|QM|Q)[\s#-]*(?:(?:Match|Number|No\.?)\s*#?\s*)?(\d{1,3})\b/i))) return `Q-${+x[1]}`; // "Qualification Match 8", "QM 8", "Quals 18"
  if ((x = t.match(/\bSemi-?(?:final)?s?\s*-?\s*(\d)\s*[-, ]\s*(?:game\s*|match\s*)?(\d)\b/i))) return `SF${x[1]}-${x[2]}`; // "Semifinal 1-2", "Semis-1-1", "Semi 2-2"
  if ((x = t.match(/\bSF\s*(\d)\s*(?:[-.]|M|\s)\s*(\d)\b/i))) return `SF${x[1]}-${x[2]}`; // "SF2-1", "SF2M1"
  if ((x = t.match(/\bFinals?\s*(?:game\s*|match\s*)?#?\s*(\d)\b/i)) || (x = t.match(/\bF-?(\d)\b/))) return `F-${x[1]}`; // "Finals 2", "F2", "F-2"
  if (/tie-?breaker|replay/i.test(t)) return null; // replays are numbered differently
  if ((x = t.match(/\b(?:Playoff\s*)?M-(\d{1,2})\b/)) || (x = t.match(/\bPlayoff\s+M(\d{1,2})\b/i))) return `M-${+x[1]}`;
  if (bareM && (x = t.match(/\bM(\d{1,2})\b/))) return `M-${+x[1]}`; // "… Tournament M3" on a per-match channel
  if ((x = t.match(/\b(?:Playoff(?:\s*Match)?|Match)\s*#?\s*(\d{1,2})\b/i))) return `M-${+x[1]}`;
  return null;
}

const tsFile = path.join("site", "videos", "timestamped.json"), ovFile = path.join("site", "videos", "overrides.json"), chFile = path.join("site", "videos", "channels.json");
const upFile = path.join("site", "videos", "uploads.json");
const ts = await readJson(tsFile, {}), ov = await readJson(ovFile, {}), chs = await readJson(chFile, []), up = await readJson(upFile, {});
ts[season] ??= {}; ov[season] ??= {}; up[season] ??= {};
const lives = {}; // code -> [{ c, title, inside: Set(times), total }]
const reroute = []; // rejected here, but maybe the same-named event of another season/meet
const tally = { timestamped: 0, perMatch: 0, livestream: 0, upload: 0, rejected: 0 };
const why = (c, msg) => { tally.rejected++; console.log(`  ✗ ${c.id} ${c.code ?? ""}: ${msg}`); };

// channels that uploaded a run of bare "Match N" videos for one event (6+ numbers, past 10):
// an event's own numbering, not a team's "my 5th match"
const matchRun = new Set();
{
  const runs = new Map();
  for (const c of cands) {
    const v = info[c.id], t = v?.snippet?.title ?? "";
    const x = t.match(/\bmatch\s*#?\s*(\d{1,3})\b/i);
    if (!x || /playoff|semi|final|elim/i.test(t)) continue;
    const k = `${c.code} ${v.snippet.channelId}`;
    (runs.get(k) ?? runs.set(k, new Set()).get(k)).add(+x[1]);
  }
  for (const [k, ns] of runs) if (ns.size >= 6 && Math.max(...ns) > 10) matchRun.add(k);
}
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
  let d = titleMatch(title, c.trusted) ?? c.match;
  if (c.match && d !== c.match && /^Q-/.test(c.match) && /^M-/.test(d ?? "")) d = c.match; // "Match 5" read as playoff
  // a bare "Match 5" from a team's own channel is usually *their* 5th match, not Q-5:
  // trust it only from channels that upload every match of an event (--per-match-channel)
  // …unless the same channel uploaded a whole run of "Match N" for this event: then it's the event's numbering
  if (d && !c.trusted && d !== c.match && !/\b(?:Qualification|Qual|QM\s*\d|Q[\s#-]*\d|Playoff|Elimination|Semi|SF\s*\d|F-?\d\b|Finals?|M-\d)/i.test(title) && !matchRun.has(`${c.code} ${v.snippet.channelId}`)) d = null;
  // a run of bare "Match N" (no playoff words) is the qualification schedule
  if (d?.startsWith("M-") && matchRun.has(`${c.code} ${v.snippet.channelId}`) && !/playoff|semi|final|elim|M-\d/i.test(title)) d = `Q-${d.slice(2)}`;
  // "Match 3" at a league meet (no playoffs) is qualification 3
  if (d?.startsWith("M-") && ev && !/playoff/i.test(title) && !ev.matchList.some((m) => m.d.startsWith("M-"))) d = `Q-${d.slice(2)}`;
  const seconds = v.contentDetails?.duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const len = seconds ? (+(seconds[1] ?? 0)) * 3600 + (+(seconds[2] ?? 0)) * 60 + +(seconds[3] ?? 0) : 0;
  if (d && len && len < 20 * 60 && ev) {
    const pub = Date.parse(v.snippet.publishedAt), from = Date.parse(ev.start) - 864e5, to = Date.parse(ev.end) + 240 * 864e5; // teams often upload a season's matches months later
    if (!ev.matchList.some((m) => m.d === d)) { why(c, `${ev.code} has no match ${d}`); reroute.push({ c, v, d }); continue; }
    if (pub < from || pub > to) { why(c, `published ${v.snippet.publishedAt.slice(0, 10)}, not near ${ev.code} (${ev.start})`); reroute.push({ c, v, d }); continue; }
    const owner = Object.entries(ts[season]).find(([code, vids]) => code !== ev.code && vids[c.id]);
    if (owner) { why(c, `already ${owner[0]}'s video`); continue; }
    (ts[season][ev.code] ??= {})[c.id] = { [d]: 0 };
    tally.perMatch++; console.log(`  ✓ ${ev.code} ${d} ${title}`); continue;
  }
  // 3. a livestream recording: judged together with the event's other streams below
  if (live.actualStartTime && live.actualEndTime) {
    if (!ev) { why(c, "livestream but no event code given"); continue; }
    const s = Date.parse(live.actualStartTime) - 60e3, e = Date.parse(live.actualEndTime) + 60e3;
    const times = ev.matchList.filter((m) => m.played && m.time).map((m) => m.time);
    const inside = new Set(times.filter((t) => t >= s && t <= e));
    (lives[ev.code] ??= []).push({ c, v, title, inside, total: times.length });
    continue;
  }
  // 4. a long recording with no clock: kept for calibrate-uploads.mjs, which finds where
  // the event's match rhythm sits in it
  if (ev && len > 45 * 60) {
    const pub = Date.parse(v.snippet.publishedAt);
    if (pub < Date.parse(ev.start) - 864e5 || pub > Date.parse(ev.end) + 240 * 864e5) { why(c, `published ${v.snippet.publishedAt.slice(0, 10)}, not near ${ev.code} (${ev.start})`); reroute.push({ c, v, long: true }); continue; }
    const u = (up[season][ev.code] ??= []);
    if (!u.includes(c.id)) u.push(c.id);
    tally.upload++; console.log(`  … ${ev.code} long upload, needs calibrate-uploads: ${title}`); continue;
  }
  why(c, `no timestamps, not a livestream, no event to place it in: ${title}`);
}
// livestreams: a stream of another year or event overlaps none of this event's matches,
// so any real overlap counts. A playoffs-only day, a finals stream or one part of a split
// stream holds few matches and is still the right video.
for (const [code, ls] of Object.entries(lives)) {
  for (const l of ls) {
    const need = l.total <= 4 ? 1 : 2;
    if (l.inside.size < need) { why(l.c, `only ${l.inside.size} of ${code}'s ${l.total} matches happened while it was live`); reroute.push({ c: l.c, v: l.v, live: true }); continue; }
    const o = (ov[season][code] ??= {});
    o.streams = [...new Set([...(o.streams ?? []), `https://youtu.be/${l.c.id}`])];
    tally.livestream++; console.log(`  ✓ ${code} livestream, ${l.inside.size} of ${l.total} matches inside: ${l.title}`);
  }
}
// Wrong year / wrong meet isn't wrong video: it's usually the same-named event of another
// season (or the next meet). File it where it fits: same name, and live during that event's
// matches (livestream) or published within two months after it (upload / single match).
if (reroute.length) {
  const STOP = new Set("ftc first tech challenge tournament qualifier qualifiers qualifying qualification league leagues meet meets championship championships regional region the of at and in event division robotics robot competition live stream livestream day scrimmage presented by season decode premier state north south east west central high school invitational interleague into deep centerstage powerplay power play freight frenzy ultimate goal skystone part".split(" "));
  const words = (t) => [...new Set(String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b([a-z](?:\s*&\s*[a-z])*)[\s-]+(league|division)\b/g, (_, l, k) => l.replace(/[\s&]/g, "") + k)
    .replace(/\b(group|pool|division|league)\s+([a-z]\d?)\b/g, "$1$2")
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
  const nums = (t) => new Set([...String(t).matchAll(/(?:#|\bno\.?\s*|\b(?:qt|meet|qualifier|tournament|league)\s*)(\d{1,2})\b/gi)].map((m) => +m[1]));
  // a meet's video isn't the league tournament's (and vice versa), nor a qualifier's a scrimmage's
  const KINDS = ["meet", "tournament", "qualifier|qt\\b", "scrimmage", "championship|champs"];
  const kinds = (t) => KINDS.filter((k) => new RegExp(`\\b(${k})`, "i").test(t));
  const idx = [];
  for (const s2 of await fs.readdir(path.join("site", "data")).then((d) => d.filter((x) => /^\d{4}$/.test(x)))) {
    for (const f of await fs.readdir(path.join("site", "data", s2, "event")).catch(() => [])) {
      const e = await readJson(path.join("site", "data", s2, "event", f), null);
      const times = (e?.matchList ?? []).filter((m) => m.played && m.time).map((m) => m.time);
      if (times.length) idx.push({ season: +s2, code: e.code, name: e.name, start: e.start, end: e.end, times, ds: new Set(e.matchList.map((m) => m.d)), w: words(e.name), n: nums(e.name) });
    }
  }
  // words in many event names ("norcal", "texas", "iowa") don't identify an event
  const df = new Map();
  for (const e of idx) for (const w of e.w) df.set(w, (df.get(w) ?? 0) + 1);
  const rare = (w) => (df.get(w) ?? 0) <= 12;
  for (const { c, v, live, d, long } of reroute) {
    const tw = new Set(words(v.snippet.title)), tn = nums(v.snippet.title);
    const ls = v.liveStreamingDetails ?? {}, pub = Date.parse(v.snippet.publishedAt);
    const fits = idx.filter((e) => !(e.season === season && e.code === c.code)).map((e) => {
      const sharedW = e.w.filter((x) => tw.has(x)), shared = sharedW.length;
      if (shared < Math.min(2, e.w.length) || !sharedW.some(rare)) return null;
      if (e.n.size && tn.size && ![...e.n].some((x) => tn.has(x))) return null; // "Meet 3" vs "Meet 2"
      const ke = kinds(e.name), kt = kinds(v.snippet.title);
      if (ke.length && kt.length && !ke.some((k) => kt.includes(k))) return null; // "Meet 3" vs "Tournament"
      if (live) {
        const a = Date.parse(ls.actualStartTime) - 60e3, b = Date.parse(ls.actualEndTime) + 60e3;
        if (e.times.filter((t) => t >= a && t <= b).length < (e.times.length <= 4 ? 1 : 2)) return null;
      } else {
        if (pub < Date.parse(e.start) - 864e5 || pub > Date.parse(e.end) + 60 * 864e5) return null;
        if (d && !e.ds.has(d)) return null;
      }
      return { e, shared };
    }).filter(Boolean).sort((a, b) => b.shared - a.shared);
    if (!fits.length || (fits[1] && fits[1].shared === fits[0].shared)) continue;
    const { e } = fits[0], s2 = e.season;
    if (live) { const o = ((ov[s2] ??= {})[e.code] ??= {}); o.streams = [...new Set([...(o.streams ?? []), `https://youtu.be/${c.id}`])]; }
    else if (d) { if (Object.entries((ts[s2] ??= {})).some(([k, vids]) => k !== e.code && vids[c.id])) continue; (ts[s2][e.code] ??= {})[c.id] = { [d]: 0 }; }
    else if (long) { const u = ((up[s2] ??= {})[e.code] ??= []); if (!u.includes(c.id)) u.push(c.id); }
    else continue;
    tally.rerouted = (tally.rerouted ?? 0) + 1;
    console.log(`  ↪ ${c.id} is ${s2} ${e.code} (${e.name}), not ${season} ${c.code}: ${v.snippet.title.slice(0, 70)}`);
  }
}
let newCh = 0;
for (const ch of channels) if (!chs.includes(ch)) { chs.push(ch); newCh++; }

const dry = process.argv.includes("--dry-run"); // report only, write nothing
// other scripts (calibrate-uploads) may have written these files while we checked videos:
// merge what we have into what's there now rather than overwrite it
const merge = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])];
  if (a && b && typeof a === "object" && typeof b === "object") { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = k in o ? merge(o[k], v) : v; return o; }
  return b;
};
const save = async (file, ours) => fs.writeFile(file, JSON.stringify(merge(await readJson(file, Array.isArray(ours) ? [] : {}), ours), null, 1) + "\n");
if (!dry) { await save(tsFile, ts); await save(ovFile, ov); await save(chFile, chs); await save(upFile, up); }
console.log(`${season}: ${tally.timestamped} timestamped, ${tally.perMatch} single-match, ${tally.livestream} livestreams added, ${tally.upload} uploads to calibrate; ${tally.rejected} rejected, ${tally.rerouted ?? 0} of those filed under another season/event; ${newCh} new channels`);
console.log("next: node scripts/videos.mjs", season);
