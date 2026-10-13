// Finds uploaded event videos whose description lists a timestamp per match,
// e.g. FIRST Indiana's re-uploads of their Twitch streams:
//
//   00:54:52 Q1 - Blue: 22331, 4366; Red: 13246, 14596
//
// Those give the exact spot for every match, so no clock guessing. A video is
// tied to the event whose qualification line-ups agree with its list (teams,
// not names, decide), and saved to site/videos/timestamped.json:
//   { season: { eventCode: { videoId: { "Q-1": seconds, … } } } }
//
//   node scripts/find-timestamped.mjs 2025 [--channel UC…] [--budget 500]
// Channels scanned: site/videos/channels.json (hand-added) plus --channel.

import fs from "node:fs/promises";
import path from "node:path";

const API = "https://www.googleapis.com/youtube/v3";
const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : null; };
let budget = +(opt("--budget") ?? 500);
const extraChannel = opt("--channel");
const seasons = args.map(Number);
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const key = process.env.YOUTUBE_API_KEY ?? (await fs.readFile(".env", "utf8").catch(() => "")).match(/^YOUTUBE_API_KEY=(\S+)/m)?.[1];

async function yt(endpoint, params) {
  if (budget < 1) throw Object.assign(new Error("out of budget"), { budget: true });
  budget -= 1; // playlistItems and videos cost 1 unit a call
  const u = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key })) u.searchParams.set(k, v);
  const r = await (await fetch(u)).json();
  if (r.error) throw new Error(`YouTube ${endpoint}: ${r.error.message}`);
  return r;
}

// "01:02:03 Q12 - Blue: 1, 2; Red: 3, 4" -> { d: "Q-12", at: 3723, teams: Set }
// Playoff lines ("M3", "P3", "SF1-2", "F1", "Final 2") are kept too; teams are optional.
export function parseTimestamps(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—:|]?\s*(.+)$/);
    if (!m) continue;
    const at = (+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3], rest = m[4];
    let x, d = null;
    if ((x = rest.match(/^(?:Q|Qual(?:ification)?s?\.?)\s*#?\s*(\d{1,3})\b/i))) d = `Q-${+x[1]}`;
    else if ((x = rest.match(/^(?:SF|Semi-?finals?)\s*(\d)\s*[-.]\s*(\d)\b/i))) d = `SF${x[1]}-${x[2]}`;
    else if ((x = rest.match(/^(?:F|Finals?)\s*[-#]?\s*(\d)\b/i))) d = `F-${x[1]}`;
    else if ((x = rest.match(/^(?:M|P|Match|Playoff(?: match)?)\s*#?\s*(\d{1,2})\b/i))) d = `M-${+x[1]}`;
    if (!d) continue;
    const teams = new Set([...rest.slice(x[0].length).matchAll(/\b\d{1,5}\b/g)].map((t) => +t[0]));
    out.push({ d, at, teams });
  }
  return out;
}

const lineups = new Map();
async function eventLineups(season) {
  if (!lineups.has(season)) {
    const dir = path.join("site", "data", String(season), "event"), evs = [];
    for (const f of await fs.readdir(dir)) {
      const ev = await readJson(path.join(dir, f), null);
      if (ev?.matchList?.length) evs.push({ code: ev.code, byD: new Map(ev.matchList.map((m) => [m.d, new Set([...m.red, ...m.blue])])),
        time: new Map(ev.matchList.filter((m) => m.played && m.time).map((m) => [m.d, m.time / 1000])) });
    }
    lineups.set(season, evs);
  }
  return lineups.get(season);
}

// Which event a timestamp list belongs to. Two fingerprints, either is enough:
//  - line-ups: most quals with the same teams (when the list names them);
//  - rhythm: video time minus official start time is the same for every match
//    of the right event (the video runs continuously), while for any other
//    event the gaps between matches don't line up.
export async function matchEvent(season, stamps) {
  const quals = stamps.filter((s) => s.d.startsWith("Q-"));
  if (quals.length < 3) return null;
  const withTeams = quals.filter((s) => s.teams.size >= 2);
  let best = null;
  const fits = [];
  for (const { code, byD, time } of await eventLineups(season)) {
    let hits = 0;
    for (const q of withTeams) {
      const ours = byD.get(q.d);
      if (ours && ours.size === q.teams.size && [...q.teams].every((t) => ours.has(t))) hits++;
    }
    if (!best || hits > best.hits) best = { code, hits };
    const diffs = quals.filter((q) => time.has(q.d)).map((q) => q.at - time.get(q.d)).sort((a, b) => a - b);
    if (diffs.length >= Math.max(5, quals.length * 0.8)) {
      const med = diffs[diffs.length >> 1];
      const close = diffs.filter((x) => Math.abs(x - med) <= 30).length / diffs.length;
      fits.push({ code, close });
    }
  }
  if (withTeams.length >= 3 && best.hits >= Math.max(3, withTeams.length * 0.6)) return best.code;
  fits.sort((a, b) => b.close - a.close);
  // nearly every match within 30 s of one constant offset, and no other event comes close
  if (fits[0]?.close >= 0.8 && !(fits[1]?.close >= 0.5)) return fits[0].code;
  return null;
}

async function channelUploads(channel, from, to) {
  const ids = [];
  let pageToken;
  for (let page = 0; page < 40; page++) {
    const r = await yt("playlistItems", { part: "contentDetails", playlistId: `UU${channel.slice(2)}`, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    const items = r.items.map((i) => ({ id: i.contentDetails.videoId, at: Date.parse(i.contentDetails.videoPublishedAt) }));
    ids.push(...items.filter((i) => i.at >= from && i.at <= to).map((i) => i.id));
    pageToken = r.nextPageToken;
    if (!pageToken || items.at(-1)?.at < from) break;
  }
  return ids;
}

if (seasons.length) {
  if (!key) throw new Error("needs YOUTUBE_API_KEY in .env");
  const file = path.join("site", "videos", "timestamped.json");
  const all = await readJson(file, {});
  const channels = [...new Set([...(await readJson(path.join("site", "videos", "channels.json"), [])), ...(extraChannel ? [extraChannel] : [])])];
  for (const season of seasons) {
    const cacheFile = path.join(".cache", "timestamped", `${season}.json`);
    const cache = await readJson(cacheFile, {}); // videoId -> { code, stamps } or { none: true }
    const from = Date.UTC(season, 7, 1), to = Date.UTC(season + 1, 8, 30);
    try {
      for (const ch of channels) {
        const todo = (await channelUploads(ch, from, to)).filter((id) => !cache[id]);
        for (let i = 0; i < todo.length; i += 50) {
          const r = await yt("videos", { part: "snippet,status,contentDetails", id: todo.slice(i, i + 50).join(",") });
          for (const v of r.items) {
            const stamps = parseTimestamps(v.snippet.description);
            const region = v.contentDetails?.regionRestriction ?? {};
            const usBlocked = (region.blocked ?? []).includes("US") || (region.allowed ? !region.allowed.includes("US") : false);
            const code = stamps.length && v.status.embeddable !== false && !usBlocked ? await matchEvent(season, stamps) : null;
            const rec = { title: v.snippet.title, stamps: Object.fromEntries(stamps.map((s) => [s.d, s.at])) };
            cache[v.id] = code ? { code, ...rec } : stamps.length ? { none: true, ...rec } : { none: true };
            if (code) console.log(`  ${season} ${code} <= ${v.id} ${v.snippet.title} (${stamps.length} timestamps)`);
          }
          await fs.mkdir(path.dirname(cacheFile), { recursive: true });
          await fs.writeFile(cacheFile, JSON.stringify(cache));
        }
      }
    } catch (e) {
      if (!e.budget) throw e;
      console.log(`  ${season}: quota budget used up; run again later to continue`);
    }
    // "… - Part 2" too short to fingerprint on its own: same event as its other part
    const base = (t) => t.replace(/[\s-]*\bpart\s*\d+\b/i, "").trim();
    for (const c of Object.values(cache)) if (c.none && c.stamps && /\bpart\s*\d/i.test(c.title)) {
      const sib = Object.values(cache).find((o) => o.code && base(o.title) === base(c.title));
      if (sib) { c.code = sib.code; delete c.none; console.log(`  ${season} ${c.code} <= ${c.title} (other part of the same event)`); }
    }
    all[season] = {};
    for (const [id, c] of Object.entries(cache)) if (c.code) (all[season][c.code] ??= {})[id] = c.stamps;
    console.log(season, `${Object.keys(all[season]).length} events with per-match timestamps`);
  }
  await fs.writeFile(file, JSON.stringify(all, null, 1) + "\n");
}
