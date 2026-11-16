// Finds match video for every event and writes site/data/<season>/videos.json.
//
// Sources, best first (Bilibili clips come in through timestamped.json with a "bili:" id):
//  1. Per-match uploads FIRST links on each match (Worlds playoffs, mostly).
//  2. The event's livestream recording (FIRST event listing + overrides),
//     with each match located by its official start time. When FIRST links a channel page
//     instead of a video, that channel's recordings live during the event's matches.
//  3. Manual / community additions in site/videos/overrides.json.
// Livestream start/end times come from the YouTube Data API (YOUTUBE_API_KEY);
// FIRST data needs FTC_API_USER / FTC_API_KEY. Missing keys = that source skipped.
//
//   node scripts/videos.mjs 2025 2026

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { first, hasFirstApi } from "./first-api.mjs";

const YT = "https://www.googleapis.com/youtube/v3/videos";
const CACHE_V = 2; // bump when we start reading a new field

// Every YouTube Data API key we have: YOUTUBE_API_KEY, a comma list in YOUTUBE_API_KEYS,
// and any other Google API key (AIza…) in .env whatever its name. Each Google Cloud
// project has its own daily quota, so when one key is refused or out of quota we move on.
async function ytKeys() {
  const text = await fs.readFile(".env", "utf8").catch(() => "");
  const fromEnv = [process.env.YOUTUBE_API_KEY, ...(process.env.YOUTUBE_API_KEYS ?? "").split(",")];
  const fromFile = [...text.matchAll(/^[\w-]+=(AIza[\w-]{35})\s*$/gm)].map((m) => m[1]);
  return [...new Set([...fromEnv, ...fromFile].map((k) => k?.trim()).filter(Boolean))];
}
let ytKeyList = null, ytKeyAt = 0;

async function env(name) {
  if (process.env[name]) return process.env[name];
  const text = await fs.readFile(".env", "utf8").catch(() => "");
  return text.match(new RegExp(`^${name}=(\\S+)`, "m"))?.[1];
}

// YouTube video id from any of the URL shapes events use
// Not an FTC video: FRC (and VEX / FLL) recordings kept turning up in searches for FTC
// events, e.g. "Qualification 23 - FIRST Chesapeake District Championship" placed on
// Brazil's FTC championship. Returns what gave it away, or null. A title naming an FTC game
// or "FTC" itself always passes (FIRST in Michigan / Indiana run both programs).
const FTC_WORDS = /\b(?:FTC|FIRST Tech|Tech Challenge|Skystone|Rover Ruckus|Ultimate Goal|Freight Frenzy|Power ?Play|Center ?Stage|Into the Deep|DECODE)\b/i;
const NOT_FTC = new RegExp([
  String.raw`\bFRC\b`, String.raw`FIRST Robotics Competition`, String.raw`\b(?:VEX|VRC|FLL|LEGO)\b`,
  String.raw`\bDistrict (?:Championship|Event)\b`, String.raw`\bCHS District\b`, String.raw`\bChesapeake\b.*\bDistrict\b`, String.raw`FIRST Chesapeake Archive`, String.raw`Robotics Gameday`,
  String.raw`\b(?:19|20)\d\d\b[^|]*\bRegional\b(?!\s+Championship)`, String.raw`\bRegional\s*#\d`,
  // FRC game names
  String.raw`\b(?:REBUILT|REEFSCAPE|CRESCENDO|CHARGED UP|RAPID REACT|INFINITE RECHARGE|DEEP SPACE|POWER UP|STEAMWORKS|STRONGHOLD)\b`,
].join("|"), "i");
export function notFtc(title = "", channel = "") {
  if (FTC_WORDS.test(title)) return null;
  return `${title} ${channel}`.match(NOT_FTC)?.[0] ?? null;
}

export function youtubeId(url) {
  const m = String(url ?? "").match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m?.[1] ?? null;
}

// A channel link instead of a video link (".../@ndhsrobotics/live", ".../channel/UC…/streams",
// ".../c/FIRSTChesapeake", ".../user/x"): what to look the channel up by, or null.
export function youtubeChannel(url) {
  let s = String(url ?? "");
  if (youtubeId(s) || !/youtube\.com\//i.test(s)) return null;
  try { s = decodeURI(s); } catch {}
  let m = s.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
  if (m) return { id: m[1] };
  m = s.match(/youtube\.com\/@([^/?#\s]+)/i);
  if (m) return { handle: m[1] };
  m = s.match(/youtube\.com\/(c|user)\/([^/?#\s]+)/i);
  if (m) return { [m[1].toLowerCase() === "user" ? "user" : "custom"]: m[2] };
  return null;
}

// One YouTube Data API call (googleapis.com only) with the same key rotation as youtubeDetails.
// null when no key works: callers then skip quietly.
const YTAPI = "https://www.googleapis.com/youtube/v3";
let ytUnits = 0; // quota spent this run (list calls cost 1 unit each)
async function ytApi(endpoint, params) {
  ytKeyList ??= await ytKeys();
  if (!ytKeyList.length || ytDown) return null;
  for (;;) {
    const u = new URL(`${YTAPI}/${endpoint}`);
    for (const [k, v] of Object.entries({ ...params, key: ytKeyList[ytKeyAt] })) u.searchParams.set(k, v);
    ytUnits++;
    const json = await fetch(u).then((r) => r.json()).catch((e) => ({ error: { message: e.message } }));
    if (!json.error) return json;
    console.warn(`YouTube API key ${ytKeyAt + 1}/${ytKeyList.length}: ${String(json.error.message).replace(/<[^>]+>/g, "")}`);
    if (++ytKeyAt >= ytKeyList.length) { ytDown = true; return null; }
  }
}

// Channel id for a channel link; handles are cached for good (null = no such channel).
async function resolveChannel(ref, handles) {
  if (ref.id) return ref.id;
  const key = ref.handle ? `@${ref.handle}` : ref.user ? `user/${ref.user}` : `c/${ref.custom}`;
  if (key in handles) return handles[key];
  // /c/ names: usually the same as the channel's @handle, else a legacy username
  const tries = ref.handle ? [{ forHandle: ref.handle }] : ref.user ? [{ forUsername: ref.user }] : [{ forHandle: ref.custom }, { forUsername: ref.custom }];
  for (const q of tries) {
    const r = await ytApi("channels", { part: "id", ...q });
    if (!r) return undefined; // API down: try again next run
    if (r.items?.[0]?.id) return (handles[key] = r.items[0].id);
  }
  return (handles[key] = null);
}

// Recordings for events whose FIRST stream link is a channel, not a video. One channel often
// streams several events on different days, so a recording only counts for an event when it
// was live during that event's matches (and, when one recording overlaps two of the channel's
// events at once, only if its title names one of them). Finished events are cached.
//   links: [{ code, name, url, dateStart, dateEnd }]
// Returns { pending: code -> [candidate ids] (need details), match(code, details) -> ids }.
async function channelStreams(season, links) {
  const dir = path.join(".cache", "yt-channels");
  const handlesFile = path.join(dir, "handles.json"), doneFile = path.join(dir, `events-${season}.json`);
  const handles = await readJson(handlesFile, {});
  const done = await readJson(doneFile, {}); // finished event code -> matched ids
  const now = Date.now();
  const cached = {}, pending = {}, info = {};
  const byChannel = new Map(); // channel id -> [event links]
  for (const l of links) {
    if (done[l.code]) { cached[l.code] = done[l.code]; continue; }
    const start = Date.parse(l.dateStart), end = Date.parse(l.dateEnd) + 864e5;
    if (!(start < now)) continue; // not started yet
    const ev = await readJson(path.join("site", "data", String(season), "event", `${l.code}.json`), null);
    const times = (ev?.matchList ?? []).filter((m) => m.played && m.time).map((m) => m.time);
    if (!times.length) continue; // nothing played yet: nothing to place
    const id = await resolveChannel(youtubeChannel(l.url), handles);
    if (!id) continue;
    info[l.code] = { ...l, start, end, times, channel: id, finished: end < now - 3 * 864e5 };
    if (!byChannel.has(id)) byChannel.set(id, []);
    byChannel.get(id).push(info[l.code]);
  }
  // list each channel's uploads (newest first) back to a week before its earliest event:
  // a stream's publish time can be when it was scheduled, days before it went live
  for (const [id, evs] of byChannel) {
    const from = Math.min(...evs.map((e) => e.start)) - 7 * 864e5;
    const vids = [];
    let pageToken, page = 0;
    do {
      const r = await ytApi("playlistItems", { part: "contentDetails", playlistId: `UU${id.slice(2)}`, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
      if (!r) break;
      for (const it of r.items ?? []) vids.push({ id: it.contentDetails?.videoId, at: Date.parse(it.contentDetails?.videoPublishedAt) });
      pageToken = r.nextPageToken;
      if (vids.length && vids.at(-1).at < from) break;
    } while (pageToken && ++page < 10);
    for (const e of evs) {
      pending[e.code] = vids.filter((v) => v.id && v.at >= e.start - 7 * 864e5 && v.at <= e.end + 2 * 864e5).map((v) => v.id);
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(handlesFile, JSON.stringify(handles, null, 1));

  const match = async (details) => {
    // which events each recording was live during (enough of their matches inside it)
    const hits = {};
    for (const [code, ids] of Object.entries(pending)) {
      const e = info[code];
      for (const id of ids) {
        const v = details[id];
        if (!v?.start || v.missing) continue;
        const end = v.end ?? (v.live ? now : v.start + (v.seconds ?? 0) * 1000);
        const n = e.times.filter((t) => t >= v.start - 5 * 60e3 && t <= end).length;
        if (n >= Math.min(3, e.times.length) && n >= e.times.length * 0.25) (hits[id] ??= []).push(code);
      }
    }
    const found = {};
    for (const [id, codes] of Object.entries(hits)) {
      let keep = codes;
      if (codes.length > 1) keep = codes.filter((c) => titleNames(details[id].title, info[c].name, codes.map((x) => info[x].name)));
      for (const c of keep) (found[c] ??= []).push(id);
    }
    // cache finished events (an empty answer too), unless the API gave out partway
    if (!ytDown) for (const [code, e] of Object.entries(info)) if (e.finished && pending[code]) done[code] = found[code] ?? [];
    await fs.writeFile(doneFile, JSON.stringify(done, null, 1));
    return { ...cached, ...found };
  };
  return { pending, cached, match };
}

// Does a recording's title pick out this event among others streamed at the same time?
// Looks for the number or word that tells the event names apart ("Meet 5" vs "Meet 6").
function titleNames(title = "", name, others) {
  const toks = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const t = toks(title), mine = toks(name);
  const distinct = [...mine].filter((w) => others.some((o) => o !== name && !toks(o).has(w)));
  return distinct.length > 0 && distinct.every((w) => t.has(w));
}

async function readJson(file, fallback) {
  return fs.readFile(file, "utf8").then(JSON.parse).catch(() => fallback);
}

// Details for many videos, cached: finished streams never change.
// When the YouTube API refuses (e.g. daily quota used up), the rest of the run
// uses cached details only, so a deploy still goes out; uncached videos wait
// for the next run.
let ytDown = false;
// Details are also kept in git (cache/youtube/<season>.json) so a machine with no API key
// or an empty .cache (e.g. the home server that builds oddbot.org) still knows every video;
// without them every YouTube video was dropped there.
async function youtubeDetails(ids, cacheFile) {
  const shared = path.join("cache", "youtube", path.basename(cacheFile));
  const cache = { ...(await readJson(shared, {})), ...(await readJson(cacheFile, {})) };
  ytKeyList ??= await ytKeys();
  const todo = [...new Set(ids)].filter((id) => !cache[id] || cache[id].live || cache[id].v !== CACHE_V);
  if (ytKeyList.length && todo.length && !ytDown) {
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      let json;
      for (;;) {
        ytUnits++;
        const res = await fetch(`${YT}?part=liveStreamingDetails,contentDetails,status,snippet&id=${batch.join(",")}&key=${ytKeyList[ytKeyAt]}`);
        json = await res.json();
        if (!json.error) break;
        console.warn(`YouTube API key ${ytKeyAt + 1}/${ytKeyList.length}: ${json.error.message.replace(/<[^>]+>/g, "")}`);
        if (++ytKeyAt >= ytKeyList.length) break;
      }
      if (json.error) {
        console.warn(`YouTube API: no working key left (using cached details; ${todo.length - i} videos skipped this run)`);
        ytDown = true;
        break;
      }
      const found = new Set();
      for (const v of json.items ?? []) {
        found.add(v.id);
        const live = v.liveStreamingDetails ?? {};
        const region = v.contentDetails?.regionRestriction ?? {};
        cache[v.id] = {
          v: CACHE_V,
          // blocked for US viewers (copyright claims on stream music, mostly)
          usBlocked: (region.blocked ?? []).includes("US") || (region.allowed ? !region.allowed.includes("US") : false),
          title: v.snippet?.title ?? "",
          start: live.actualStartTime ? Date.parse(live.actualStartTime) : null,
          end: live.actualEndTime ? Date.parse(live.actualEndTime) : null,
          live: v.snippet?.liveBroadcastContent === "live" || (live.actualStartTime && !live.actualEndTime),
          embeddable: v.status?.embeddable !== false,
          seconds: isoSeconds(v.contentDetails?.duration),
        };
      }
      for (const id of batch) if (!found.has(id)) cache[id] = { v: CACHE_V, missing: true }; // private or deleted
    }
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(cache));
  }
  // keep the shared copy current (sorted keys: small, stable git diffs)
  await fs.mkdir(path.dirname(shared), { recursive: true });
  await fs.writeFile(shared, JSON.stringify(Object.fromEntries(Object.keys(cache).sort().map((k) => [k, cache[k]]))) + "\n");
  return cache;
}

// FIRST gives match times in the event's local time with no zone marker;
// convert "2026-04-30T09:10:02.2" in America/Chicago to UTC milliseconds.
export function localToUtc(naive, timeZone) {
  const asUtc = Date.parse(`${naive}Z`);
  if (!timeZone || Number.isNaN(asUtc)) return asUtc;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - (shown - Math.floor(asUtc / 1000) * 1000); // subtract the zone's offset at that moment
}

const isoSeconds = (d) => {
  const m = String(d ?? "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)) : null;
};

const TOA = "https://theorangealliance.org/api";
async function toaStreams(season) {
  const key = `${String(season).slice(2)}${String(season + 1).slice(2)}`; // 2025 -> "2526"
  const out = {};
  // free key from a myTOA account (theorangealliance.org/account); skipped when unset
  const toaKey = await env("TOA_API_KEY");
  if (!toaKey) return out;
  const toaHeaders = { "X-TOA-Key": toaKey, "X-Application-Origin": "FTCstats", "User-Agent": "FTCstats (https://oddbot.org)" };
  try {
    const [streams, events] = await Promise.all([
      fetch(`${TOA}/streams`, { headers: toaHeaders }).then((r) => r.json()),
      fetch(`${TOA}/event?season_key=${key}`, { headers: toaHeaders }).then((r) => r.json()),
    ]);
    const code = new Map(events.map((e) => [e.event_key, e.first_event_code]));
    for (const st of streams) {
      const c = code.get(st.event_key), id = youtubeId(st.url);
      if (c && id) (out[c] ??= []).push(id);
    }
  } catch (e) { console.warn("TOA streams skipped:", e.message); }
  return out;
}

export async function buildVideos(season) {
  const out = path.join("site", "data", String(season), "videos.json");
  const overrides = (await readJson(path.join("site", "videos", "overrides.json"), {}))[season] ?? {};
  const events = {}; // code -> { streams: Set(ids), uploads: [{ t: match start ms, id }] }
  const add = (code) => (events[code] ??= { streams: new Set(), uploads: [] });
  const chanLinks = []; // FIRST stream links that point at a channel, not a video

  if (hasFirstApi()) {
    const listing = await first(`${season}/events`).catch(() => null);
    for (const e of listing?.events ?? []) {
      for (const url of [e.liveStreamUrl, ...(e.webcasts ?? []).map((w) => w?.url ?? w)]) {
        const id = youtubeId(url);
        if (id) add(e.code).streams.add(id);
        else if (youtubeChannel(url)) chanLinks.push({ code: e.code, name: e.name, url, dateStart: e.dateStart, dateEnd: e.dateEnd });
      }
    }
    // per-match uploads: FIRST links a clip per match for some events (the Championship,
    // premier events, …) — ask every event; finished events are cached, they don't change
    // (matched to our matches by start time, since playoff numbering differs between sources)
    const cacheDir = path.join(".cache", "first-matches", String(season));
    await fs.mkdir(cacheDir, { recursive: true });
    const evs = (listing?.events ?? []).filter((e) => Date.parse(e.dateStart) < Date.now());
    const fetchOne = async (e) => {
      const file = path.join(cacheDir, `${e.code}.json`);
      const done = Date.parse(e.dateEnd) < Date.now() - 3 * 864e5;
      let r = done ? await readJson(file, null) : null;
      if (!r) {
        r = await first(`${season}/matches/${e.code}`).catch(() => null);
        // a finished event FIRST has no matches for (or errors on) stays that way: cache the
        // empty answer too, or every rebuild waits out the retries again
        if (done) await fs.writeFile(file, JSON.stringify({ matches: (r?.matches ?? []).map((m) => ({ videoURL: m.videoURL, actualStartTime: m.actualStartTime })) }));
      }
      return r;
    };
    for (let i = 0; i < evs.length; i += 8) {
      const batch = evs.slice(i, i + 8);
      const rs = await Promise.all(batch.map(fetchOne));
      batch.forEach((e, j) => {
        for (const m of rs[j]?.matches ?? []) {
          const id = youtubeId(m.videoURL);
          if (id && m.actualStartTime) add(e.code).uploads.push({ t: localToUtc(m.actualStartTime, e.timezone), id });
        }
      });
    }
  }
  for (const [code, o] of Object.entries(overrides)) {
    for (const url of o.streams ?? []) { const id = youtubeId(url); if (id) add(code).streams.add(id); }
  }
  // events whose stream link is a channel page: that channel's recordings from the event's days
  const chan = await channelStreams(season, chanLinks);
  // uploads whose description times every match (scripts/find-timestamped.mjs): exact spots;
  // plus livestream matches whose start was read off the overlay (scripts/ocr-calibrate-streams.mjs)
  const stamped = (await readJson(path.join("site", "videos", "timestamped.json"), {}))[season] ?? {};
  const ocrSpots = (await readJson(path.join("site", "videos", "ocr-spots.json"), {}))[season] ?? {};
  for (const [code, vids] of [...Object.entries(stamped), ...Object.entries(ocrSpots)]) {
    const ev = await readJson(path.join("site", "data", String(season), "event", `${code}.json`), null);
    const time = new Map((ev?.matchList ?? []).filter((m) => m.time).map((m) => [m.d, m.time]));
    for (const [id, stamps] of Object.entries(vids)) {
      for (const [d, at] of Object.entries(stamps)) if (time.has(d)) add(code).uploads.push({ t: time.get(d), id, at });
    }
  }
  // The Orange Alliance's hand-maintained stream list (current season only)
  for (const [code, ids] of Object.entries(await toaStreams(season))) for (const id of ids) add(code).streams.add(id);
  // streams found by scripts/find-streams.mjs for events FIRST has no link for
  const discovered = (await readJson(path.join("site", "videos", "discovered.json"), {}))[season] ?? {};
  for (const [code, ids] of Object.entries(discovered)) for (const id of ids) add(code).streams.add(id);

  // per-stream clock corrections, seconds: how much EARLIER matches appear in the
  // recording than their official start times say (scoring-PC clock wrong, encoder
  // delay); negative = later. Measured by reading the overlay's match clock.
  // calibrated.json is written by scripts/calibrate-streams.mjs (match rhythm), ocr-calibrated.json
  // by scripts/ocr-calibrate-streams.mjs (reads the overlay: more exact, so it wins over rhythm);
  // offsets.json (hand-measured) wins over both
  const offsets = {
    ...(await readJson(path.join("site", "videos", "calibrated.json"), {}))[season],
    ...(await readJson(path.join("site", "videos", "ocr-calibrated.json"), {}))[season],
    ...(await readJson(path.join("site", "videos", "offsets.json"), {}))[season],
  };

  // Bilibili videos ("bili:BV…" or "bili:BV…/p3" for page 3 of a multi-part upload, filed in
  // timestamped.json) have no YouTube details to look up: kept as they are
  const isBili = (id) => String(id).startsWith("bili:");
  const allIds = Object.values(events).flatMap((e) => [...e.streams, ...e.uploads.map((u) => u.id)]).filter((id) => !isBili(id));
  allIds.push(...Object.values(chan.pending).flat(), ...Object.values(chan.cached).flat());
  const yt = await youtubeDetails(allIds, path.join(".cache", "videos", `${season}.json`));
  const fromChannels = await chan.match(yt);
  for (const [code, ids] of Object.entries(fromChannels)) for (const id of ids) add(code).streams.add(id);
  if (chanLinks.length) console.log(`${season}: channel links ${chanLinks.length}, recordings placed for ${Object.values(fromChannels).filter((x) => x.length).length} events (${ytUnits} YouTube units this run so far)`);

  // keep recordings we can place matches in (start and end known); ones whose owner
  // turned off embedding are kept with ext: 1 and open on YouTube instead
  const result = {};
  for (const [code, e] of Object.entries(events)) {
    const streams = [...e.streams]
      .map((id) => ({ id, ...yt[id] }))
      .filter((v) => v.start && !v.missing && !v.usBlocked && !notFtc(v.title))
      .map((v) => ({ ...v, start: v.start + (offsets[v.id] ?? 0) * 1000 }))
      .map((v) => ({ id: v.id, start: v.start, end: Math.min(v.end ?? Infinity, v.start + Math.min(v.seconds ?? 43200, 43200) * 1000), title: v.title, ...(v.embeddable ? {} : { ext: 1 }),
        // cal: its clock offset was measured, so links can start right before the match
        ...(offsets[v.id] != null ? { cal: 1 } : {}) }));
    // notFtc: a last check on every recording, however it got into the lists above
    const uploads = e.uploads.filter((u) => isBili(u.id) || (yt[u.id] && !yt[u.id].missing && !yt[u.id].usBlocked && !notFtc(yt[u.id].title)))
      .map((u) => (isBili(u.id) ? { ...u, platform: "bilibili" } : yt[u.id].embeddable ? u : { ...u, ext: 1 }));
    if (streams.length || uploads.length) result[code] = { streams, uploads };
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(result));
  await splitVideos(path.dirname(out), result);
  return result;
}

// one small file per event (videos/<code>.json), so a page loads only the events it shows
export async function splitVideos(dir, result) {
  await fs.rm(path.join(dir, "videos"), { recursive: true, force: true });
  await fs.mkdir(path.join(dir, "videos"), { recursive: true });
  for (const [code, e] of Object.entries(result)) await fs.writeFile(path.join(dir, "videos", `${code}.json`), JSON.stringify(e));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const s of process.argv.slice(2).map(Number)) {
    const r = await buildVideos(s);
    const ev = Object.values(r);
    console.log(s, `${ev.length} events with video: ${ev.filter((e) => e.streams.length).length} with a usable stream recording, ${ev.reduce((a, e) => a + e.uploads.length, 0)} per-match uploads`);
  }
}
