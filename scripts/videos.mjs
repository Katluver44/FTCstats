// Finds match video for every event and writes site/data/<season>/videos.json.
//
// Sources, best first:
//  1. Per-match uploads FIRST links on each match (Worlds playoffs, mostly).
//  2. The event's livestream recording (FIRST event listing + overrides),
//     with each match located by its official start time.
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

async function env(name) {
  if (process.env[name]) return process.env[name];
  const text = await fs.readFile(".env", "utf8").catch(() => "");
  return text.match(new RegExp(`^${name}=(\\S+)`, "m"))?.[1];
}

// YouTube video id from any of the URL shapes events use
export function youtubeId(url) {
  const m = String(url ?? "").match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m?.[1] ?? null;
}

async function readJson(file, fallback) {
  return fs.readFile(file, "utf8").then(JSON.parse).catch(() => fallback);
}

// Details for many videos, cached: finished streams never change.
// When the YouTube API refuses (e.g. daily quota used up), the rest of the run
// uses cached details only, so a deploy still goes out; uncached videos wait
// for the next run.
let ytDown = false;
async function youtubeDetails(ids, cacheFile) {
  const cache = await readJson(cacheFile, {});
  const key = await env("YOUTUBE_API_KEY");
  const todo = [...new Set(ids)].filter((id) => !cache[id] || cache[id].live || cache[id].v !== CACHE_V);
  if (key && todo.length && !ytDown) {
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      const res = await fetch(`${YT}?part=liveStreamingDetails,contentDetails,status,snippet&id=${batch.join(",")}&key=${key}`);
      const json = await res.json();
      if (json.error) {
        console.warn(`YouTube API: ${json.error.message.replace(/<[^>]+>/g, "")} (using cached details; ${todo.length - i} videos skipped this run)`);
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
  const toaHeaders = { "X-TOA-Key": toaKey, "X-Application-Origin": "FTCstats", "User-Agent": "FTCstats (https://ftcstats-photos.vercel.app)" };
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

  if (hasFirstApi()) {
    const listing = await first(`${season}/events`).catch(() => null);
    for (const e of listing?.events ?? []) {
      for (const url of [e.liveStreamUrl, ...(e.webcasts ?? []).map((w) => w?.url ?? w)]) {
        const id = youtubeId(url);
        if (id) add(e.code).streams.add(id);
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
        if (r && done) await fs.writeFile(file, JSON.stringify({ matches: (r.matches ?? []).map((m) => ({ videoURL: m.videoURL, actualStartTime: m.actualStartTime })) }));
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
  // uploads whose description times every match (scripts/find-timestamped.mjs): exact spots
  const stamped = (await readJson(path.join("site", "videos", "timestamped.json"), {}))[season] ?? {};
  for (const [code, vids] of Object.entries(stamped)) {
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
  // calibrated.json is written by scripts/calibrate-streams.mjs; offsets.json (hand-measured) wins
  const offsets = {
    ...(await readJson(path.join("site", "videos", "calibrated.json"), {}))[season],
    ...(await readJson(path.join("site", "videos", "offsets.json"), {}))[season],
  };

  const allIds = Object.values(events).flatMap((e) => [...e.streams, ...e.uploads.map((u) => u.id)]);
  const yt = await youtubeDetails(allIds, path.join(".cache", "videos", `${season}.json`));

  // keep recordings we can place matches in (start and end known); ones whose owner
  // turned off embedding are kept with ext: 1 and open on YouTube instead
  const result = {};
  for (const [code, e] of Object.entries(events)) {
    const streams = [...e.streams]
      .map((id) => ({ id, ...yt[id] }))
      .filter((v) => v.start && !v.missing && !v.usBlocked)
      .map((v) => ({ ...v, start: v.start + (offsets[v.id] ?? 0) * 1000 }))
      .map((v) => ({ id: v.id, start: v.start, end: Math.min(v.end ?? Infinity, v.start + Math.min(v.seconds ?? 43200, 43200) * 1000), title: v.title, ...(v.embeddable ? {} : { ext: 1 }) }));
    const uploads = e.uploads.filter((u) => yt[u.id] && !yt[u.id].missing && !yt[u.id].usBlocked)
      .map((u) => (yt[u.id].embeddable ? u : { ...u, ext: 1 }));
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
