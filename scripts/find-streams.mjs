// Finds livestream recordings for events FIRST has no video link for, and saves
// them to site/videos/discovered.json (committed, so the hourly build uses them).
//
// Regional organizers stream most of their events on one channel, so:
//  1. collect channels: those behind FIRST's own stream links, plus channels
//     found by a YouTube search per region (search is the expensive call);
//  2. list each channel's uploads for the season (cheap) and keep finished
//     livestreams;
//  3. give an event a stream only when the stream was live during most of the
//     event's matches AND its title names the event (a shared distinctive word,
//     and no clash like "#1" vs "#2"). A wrong video is worse than none.
//
//   node scripts/find-streams.mjs 2025 [--budget 3000]   (YouTube quota units)

import fs from "node:fs/promises";
import path from "node:path";
import { first, hasFirstApi } from "./first-api.mjs";
import { youtubeId } from "./videos.mjs";

const API = "https://www.googleapis.com/youtube/v3";
const args = process.argv.slice(2);
const budgetAt = args.indexOf("--budget");
let budget = budgetAt >= 0 ? +args.splice(budgetAt, 2)[1] : 3000;
const seasons = args.map(Number);

const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const key = process.env.YOUTUBE_API_KEY ?? (await fs.readFile(".env", "utf8").catch(() => "")).match(/^YOUTUBE_API_KEY=(\S+)/m)?.[1];

async function yt(endpoint, params, cost) {
  if (budget < cost) throw Object.assign(new Error("out of budget"), { budget: true });
  budget -= cost;
  const u = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key })) u.searchParams.set(k, v);
  const r = await (await fetch(u)).json();
  if (r.error) throw new Error(`YouTube ${endpoint}: ${r.error.message}`);
  return r;
}

const US = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "Washington DC" };

// words that don't identify an event
const STOP = new Set(("ftc first tech challenge tournament tournaments qualifier qualifiers qualifying qualification qt league leagues meet meets " +
  "championship championships regional region the of at and in event events division divisions robotics robot competition competitions " +
  "live livestream stream streaming day field fields scrimmage presented by season game decode into deep centerstage powerplay freight frenzy " +
  "ultimate goal skystone vs match matches part final finals playoffs playoff state north south east west central northern southern eastern western upper lower new high school").split(" "));
// letter-named leagues ("I-League", "I&S League", "X League") are one identifying word: "ileague", "isleague"
const letterLeagues = (s) => s.replace(/\b([a-z](?:\s*&\s*[a-z])*)[\s-]+(league|division)\b/g, (_, l, kind) => l.replace(/[\s&]/g, "") + kind)
  .replace(/\b(group|pool|division|league)\s+([a-z]\d?)\b/g, "$1$2"); // "Group H" vs "Group V"
const words = (s) => letterLeagues(String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")).split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w) && !/^20\d\d$/.test(w));
const numbers = (s) => new Set([...String(s).matchAll(/(?:#|\bno\.?\s*|\b(?:qt|meet|qualifier|tournament|league)\s*)(\d{1,2})\b/gi)].map((m) => m[1]));

export async function findStreams(season) {
  const cacheFile = path.join(".cache", "streams", `${season}.json`);
  const cache = await readJson(cacheFile, { searched: {}, channels: {}, videos: {} });
  const save = () => fs.mkdir(path.dirname(cacheFile), { recursive: true }).then(() => fs.writeFile(cacheFile, JSON.stringify(cache)));
  const from = Date.UTC(season, 7, 1), to = Date.UTC(season + 1, 7, 31);

  const listing = (await first(`${season}/events`)).events;
  const linked = await readJson(path.join("site", "data", String(season), "videos.json"), {});
  const evs = [];
  for (const e of listing) {
    const ev = await readJson(path.join("site", "data", String(season), "event", `${e.code}.json`), null);
    const times = ev?.matchList?.filter((m) => m.played && m.time).map((m) => m.time) ?? [];
    if (times.length) evs.push({ ...e, times, hasVideo: !!(linked[e.code]?.streams?.length || linked[e.code]?.uploads?.length),
      linkedWindows: linked[e.code]?.streams ?? [] });
  }

  let scanChannels = async () => {};
  try {
    // 1a. channels behind FIRST's own links
    const seedIds = [...new Set(listing.flatMap((e) => [e.liveStreamUrl, ...(e.webcasts ?? []).map((w) => w?.url ?? w)].map(youtubeId).filter(Boolean)))]
      .filter((id) => !cache.videos[id]);
    for (let i = 0; i < seedIds.length; i += 50) {
      const r = await yt("videos", { part: "snippet", id: seedIds.slice(i, i + 50).join(",") }, 1);
      for (const v of r.items) { cache.videos[v.id] ??= { seed: true }; cache.channels[v.snippet.channelId] ??= {}; }
    }
    // 2. each channel's uploads this season, then details for the new ones
    scanChannels = async () => { for (const [id, ch] of Object.entries(cache.channels)) {
      if (ch.scanned && ch.scanned > to) continue; // season over when we last looked
      if (ch.scanned && Date.now() - ch.scanned < 7 * 864e5) continue; // in-season channels: weekly
      const ids = [];
      let pageToken;
      for (let page = 0; page < 40; page++) {
        const r = await yt("playlistItems", { part: "contentDetails", playlistId: `UU${id.slice(2)}`, maxResults: 50, ...(pageToken ? { pageToken } : {}) }, 1).catch((e) => (e.budget ? Promise.reject(e) : null));
        if (!r) break;
        const items = r.items.map((i) => ({ id: i.contentDetails.videoId, at: Date.parse(i.contentDetails.videoPublishedAt) }));
        ids.push(...items.filter((i) => i.at >= from && i.at <= to + 7 * 864e5).map((i) => i.id));
        pageToken = r.nextPageToken;
        if (!pageToken || items.at(-1)?.at < from) break;
      }
      const todo = ids.filter((v) => !cache.videos[v]?.checked);
      for (let i = 0; i < todo.length; i += 50) {
        const r = await yt("videos", { part: "snippet,liveStreamingDetails,status,contentDetails", id: todo.slice(i, i + 50).join(",") }, 1);
        for (const v of r.items) {
          const live = v.liveStreamingDetails ?? {};
          const region = v.contentDetails?.regionRestriction ?? {};
          const usBlocked = (region.blocked ?? []).includes("US") || (region.allowed ? !region.allowed.includes("US") : false);
          cache.videos[v.id] = { checked: true, channel: id, title: v.snippet.title,
            start: live.actualStartTime ? Date.parse(live.actualStartTime) : null, end: live.actualEndTime ? Date.parse(live.actualEndTime) : null,
            ok: !usBlocked }; // embedding off is fine: the site opens those on YouTube
        }
      }
      ch.scanned = Date.now();
      await save();
    } };
    await scanChannels();
    // 1b. search each region that has events without video (100 units each)
    const regions = new Map();
    for (const e of evs.filter((e) => !e.hasVideo)) {
      const place = e.country === "USA" ? US[e.stateprov] ?? e.stateprov : e.country;
      regions.set(place, (regions.get(place) ?? 0) + 1);
    }
    for (const [place] of [...regions].sort((a, b) => b[1] - a[1])) {
      const q = `FIRST Tech Challenge ${place}`;
      if (cache.searched[q]) continue;
      const r = await yt("search", { part: "snippet", type: "video", eventType: "completed", maxResults: 50, q,
        publishedAfter: new Date(from).toISOString(), publishedBefore: new Date(to).toISOString() }, 100);
      for (const it of r.items) if (/ftc|first|tech|robot/i.test(`${it.snippet.title} ${it.snippet.channelTitle}`)) cache.channels[it.snippet.channelId] ??= {};
      cache.searched[q] = r.items.length;
      await scanChannels();
      await save();
    }
  } catch (e) {
    if (!e.budget) throw e;
    console.log(`  ${season}: quota budget used up; run again later to continue`);
  }
  await save();

  const match = () => {
  // 3. match streams to events without video
  // a word only counts if few event names use it ("norcal" yes, "valley" no); numbers only veto
  const df = new Map();
  for (const e of evs) for (const w of new Set(words(e.name))) df.set(w, (df.get(w) ?? 0) + 1);
  const rare = (w) => !/^\d+$/.test(w) && w.length >= 3 && (df.get(w) ?? 0) <= Math.max(3, evs.length * 0.02);
  const NOT_FTC = /\b(vex|v5rc|vrc|vexu|v5|iq|push back|fll|lego|frc|ri3d|robot in 3 days|rebuilt|airport|webcam)\b/i;
  const taken = new Set(Object.values(linked).flatMap((v) => v.streams?.map((x) => x.id) ?? [])); // already some event's video
  const streams = Object.entries(cache.videos).filter(([id, v]) => v.start && v.end && v.ok && !NOT_FTC.test(v.title) && !taken.has(id)).map(([id, v]) => ({ id, ...v }));
  // every event competes for a stream, even ones that already have video: otherwise
  // "Suburban Northwest" wins the Northeast stream once Northeast has its own
  const cands = []; // { code, id, score, inside }
  for (const e of evs) {
    const name = [...new Set(words(e.name))].filter(rare);
    const city = words(e.city ?? "").filter((w) => w.length >= 4);
    const nums = numbers(e.name);
    for (const s of streams) {
      const inside = e.times.filter((t) => t >= s.start - 60e3 && t <= s.end + 60e3).length / e.times.length;
      if (inside < 0.12) continue; // one day of a three-day event can hold under a quarter of it
      const tw = new Set(words(s.title));
      const tn = numbers(s.title);
      if (nums.size && tn.size && ![...nums].some((n) => tn.has(n))) continue; // "#1" vs "#2"
      const score = name.filter((w) => tw.has(w)).length * 2 + city.filter((w) => tw.has(w) && !name.includes(w)).length;
      if (score >= 2) cands.push({ code: e.code, id: s.id, score, inside });
    }
  }
  // each stream belongs to one event: the best-named one; a tie means we can't tell, so neither
  const byStream = Map.groupBy(cands, (c) => c.id);
  const kept = [];
  for (const cs of byStream.values()) {
    cs.sort((a, b) => b.score - a.score || b.inside - a.inside);
    if (cs.length === 1 || cs[0].score > cs[1].score) kept.push(cs[0]);
  }
  // an event may have several streams (days, fields): keep those as well named as its best,
  // and only if together they cover most of its matches
  const found = {};
  for (const [code, cs] of Map.groupBy(kept, (c) => c.code)) {
    const e = evs.find((x) => x.code === code);
    const best = Math.max(...cs.map((c) => c.score));
    const use = cs.filter((c) => c.score === best);
    const s = use.map((c) => streams.find((x) => x.id === c.id));
    const inside = (x) => e.times.filter((t) => t >= x.start - 60e3 && t <= x.end + 60e3);
    if (e.hasVideo) {
      // an event with video can still gain its other days: keep streams that cover matches
      // its current recordings don't
      const have = new Set(e.linkedWindows.flatMap((w) => e.times.filter((t) => t >= w.start - 60e3 && t <= w.end + 60e3)));
      const extra = use.filter((c, i) => inside(s[i]).filter((t) => !have.has(t)).length >= Math.max(3, e.times.length * 0.15));
      if (extra.length) found[code] = extra.map((c) => c.id);
      continue;
    }
    const covered = e.times.filter((t) => s.some((x) => t >= x.start - 60e3 && t <= x.end + 60e3)).length / e.times.length;
    if (covered >= 0.5) found[code] = use.map((c) => c.id);
  }
    return found;
  };

  // 4. events still without video: search for each by name around its dates (100 units each),
  // biggest events first, then match again with whatever channels that turned up
  let found = match();
  try {
    const left = evs.filter((e) => !e.hasVideo && !found[e.code] && !cache.searched[`event:${e.code}`]).sort((a, b) => b.times.length - a.times.length);
    for (const e of left) {
      if (Date.parse(e.dateEnd) > Date.now()) continue; // not finished: its stream may not be up yet
      const r = await yt("search", { part: "snippet", type: "video", eventType: "completed", maxResults: 10, q: `${e.name} FTC`,
        publishedAfter: new Date(Date.parse(e.dateStart) - 864e5).toISOString(), publishedBefore: new Date(Date.parse(e.dateEnd) + 4 * 864e5).toISOString() }, 100);
      for (const it of r.items) cache.channels[it.snippet.channelId] ??= {};
      cache.searched[`event:${e.code}`] = r.items.length;
      await scanChannels();
      await save();
    }
  } catch (e) {
    if (!e.budget) throw e;
  }
  await save();
  return match();
}


if (seasons.length) {
  if (!key || !hasFirstApi()) throw new Error("needs YOUTUBE_API_KEY and the FIRST API login in .env");
  const file = path.join("site", "videos", "discovered.json");
  const all = await readJson(file, {});
  for (const s of seasons) {
    all[s] ??= {};
    for (const [code, ids] of Object.entries(await findStreams(s))) all[s][code] = [...new Set([...(all[s][code] ?? []), ...ids])];
    console.log(s, `${Object.keys(all[s]).length} events matched to a stream (budget left ${budget})`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(all, null, 1) + "\n");
}
