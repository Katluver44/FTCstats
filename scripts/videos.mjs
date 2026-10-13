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
async function youtubeDetails(ids, cacheFile) {
  const cache = await readJson(cacheFile, {});
  const key = await env("YOUTUBE_API_KEY");
  const todo = [...new Set(ids)].filter((id) => !cache[id] || cache[id].live || cache[id].v !== CACHE_V);
  if (key && todo.length) {
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      const res = await fetch(`${YT}?part=liveStreamingDetails,contentDetails,status,snippet&id=${batch.join(",")}&key=${key}`);
      const json = await res.json();
      if (json.error) throw new Error(`YouTube API: ${json.error.message}`);
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
    // per-match uploads: FIRST only fills these in for the Championship
    // (matched to our matches by start time, since playoff numbering differs between sources)
    for (const e of listing?.events ?? []) {
      if (!/^FTCCMP/.test(e.code) && !/FIRST Championship/i.test(e.typeName ?? "")) continue;
      const r = await first(`${season}/matches/${e.code}`).catch(() => null);
      for (const m of r?.matches ?? []) {
        const id = youtubeId(m.videoURL);
        if (id && m.actualStartTime) add(e.code).uploads.push({ t: localToUtc(m.actualStartTime, e.timezone), id });
      }
    }
  }
  for (const [code, o] of Object.entries(overrides)) {
    for (const url of o.streams ?? []) { const id = youtubeId(url); if (id) add(code).streams.add(id); }
  }
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

  // keep only recordings we can place matches in (start and end known, embeddable)
  const result = {};
  for (const [code, e] of Object.entries(events)) {
    const streams = [...e.streams]
      .map((id) => ({ id, ...yt[id] }))
      .filter((v) => v.start && v.embeddable && !v.missing && !v.usBlocked)
      .map((v) => ({ ...v, start: v.start + (offsets[v.id] ?? 0) * 1000 }))
      .map((v) => ({ id: v.id, start: v.start, end: Math.min(v.end ?? Infinity, v.start + Math.min(v.seconds ?? 43200, 43200) * 1000), title: v.title }));
    const uploads = e.uploads.filter((u) => yt[u.id] && !yt[u.id].missing && yt[u.id].embeddable && !yt[u.id].usBlocked);
    if (streams.length || uploads.length) result[code] = { streams, uploads };
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const s of process.argv.slice(2).map(Number)) {
    const r = await buildVideos(s);
    const ev = Object.values(r);
    console.log(s, `${ev.length} events with video: ${ev.filter((e) => e.streams.length).length} with a usable stream recording, ${ev.reduce((a, e) => a + e.uploads.length, 0)} per-match uploads`);
  }
}
