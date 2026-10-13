// Searches YouTube for every event that still has no video, by name, and writes the
// plausible results as candidates for add-videos.mjs (which checks each one against
// the event's match times before anything is used).
//
//   node scripts/search-events.mjs 2025 [--limit 900] --out candidates.json
//   node scripts/add-videos.mjs 2025 --file candidates.json
//
// Uses YouTube's own search page (no API key, no quota). A result is kept only when its
// title shares the event's distinctive words (or its venue city), it is from the season,
// and it is long (a full recording) or names a single match.

import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const limAt = args.indexOf("--limit");
const limit = limAt >= 0 ? +args.splice(limAt, 2)[1] : 2000;
const outAt = args.indexOf("--out");
const outFile = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const shardAt = args.indexOf("--shard");
const [shard, shards] = shardAt >= 0 ? args.splice(shardAt, 2)[1].split("/").map(Number) : [0, 1];
const season = +args[0];
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36", "Accept-Language": "en-US,en", Cookie: "SOCS=CAI; CONSENT=YES+1" };
const walk = (o, key, out = []) => { if (o && typeof o === "object") { if (o[key]) out.push(o[key]); for (const v of Object.values(o)) walk(v, key, out); } return out; };
const txt = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q) {
  for (let tries = 0; tries < 3; tries++) {
    const html = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`, { headers: UA, signal: AbortSignal.timeout(15000) })
      .then((r) => r.text()).catch(() => "");
    const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
    if (m) return walk(JSON.parse(m[1]), "videoRenderer").map((v) => ({ id: v.videoId, title: txt(v.title), channel: txt(v.ownerText), when: txt(v.publishedTimeText), len: txt(v.lengthText) }));
    await sleep(5000 * (tries + 1)); // blocked or rate-limited: back off
  }
  return [];
}

const STOP = new Set(("ftc first tech challenge tournament qualifier qualifiers qualifying qualification league leagues meet meets championship championships " +
  "regional region the of at and in event division robotics robot competition live stream day scrimmage presented by season decode premier " +
  "state north south east west central high school invitational interleague").split(" "));
const words = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b([a-z](?:\s*&\s*[a-z])*)[\s-]+(league|division)\b/g, (_, l, k) => l.replace(/[\s&]/g, "") + k)
  .replace(/\b(group|pool|division|league)\s+([a-z]\d?)\b/g, "$1$2") // "Group H" vs "Group V"
  .split(/[^a-z0-9]+/).filter((w) => w && w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
const seconds = (len) => len.split(":").reduce((a, x) => a * 60 + +x, 0);
const perMatch = /\b(?:Qualification|Qual|Q)[\s#-]*\d{1,3}\b|\bPlayoff\b|\bElimination\b/i;
const NOT_FTC = /\b(vex|v5rc|vrc|vexu|iq|fll|lego|frc|rebuilt|reefscape|crescendo|charged up)\b/i;

const LOOKS_FTC = /\b(ftc|first tech|tech challenge|robotics?|decode|into the deep|centerstage|power ?play|freight frenzy|ultimate goal|skystone)\b/i;
const GAMES = { 2019: /skystone/i, 2020: /ultimate goal/i, 2021: /freight frenzy/i, 2022: /power ?play/i, 2023: /center ?stage/i, 2024: /into the deep/i, 2025: /decode/i };
// names another season's game, or a year outside this season
const otherSeason = (t) => Object.entries(GAMES).some(([y, re]) => +y !== season && re.test(t)) ||
  [...t.matchAll(/\b(20[12]\d)\b/g)].some((m) => +m[1] !== season && +m[1] !== season + 1);
const videos = await readJson(path.join("site", "data", String(season), "videos.json"), {});
const dir = path.join("site", "data", String(season), "event");
const evs = [];
for (const f of await fs.readdir(dir)) {
  const e = await readJson(path.join(dir, f), null);
  const n = (e?.matchList ?? []).filter((m) => m.played).length;
  if (n && !videos[e.code]) {
    const raw = await readJson(path.join(".cache", String(season), `${e.code}.json`), {});
    evs.push({ code: e.code, name: e.name, n, city: raw.location?.city ?? "", start: e.start });
  }
}
evs.sort((a, b) => b.n - a.n);
const out = { videos: [], searched: [] };
let done = 0;
const prev = outFile ? await readJson(outFile, { videos: [], searched: [] }) : { videos: [], searched: [] };
out.videos = prev.videos; out.searched = prev.searched ?? [];
for (const e of evs.slice(0, limit).filter((e, i) => i % shards === shard && !out.searched.includes(e.code))) {
  const t0 = Date.now();
  const name = words(e.name), city = words(e.city);
  const seen = new Set();
  for (const q of [`${e.name} FTC`, `${e.name} ${e.city} FTC ${season}`]) {
    for (const r of await search(q)) {
      if (seen.has(r.id) || NOT_FTC.test(r.title) || otherSeason(r.title)) continue;
      seen.add(r.id);
      const tw = new Set(words(r.title));
      const shared = name.filter((w) => tw.has(w)).length + city.filter((w) => tw.has(w) && !name.includes(w)).length;
      const need = Math.min(2, name.length || 1); // "Westfield QT" needs westfield; "Gulf Coast League" needs both
      // FTC-looking title or channel, or the title carries the event's whole name ("Bucharest Twin Cup 2025 | Day 3")
      const fullName = name.length >= 2 && name.every((w) => tw.has(w));
      if (!fullName && !LOOKS_FTC.test(`${r.title} ${r.channel}`)) continue;
      const long = r.len && seconds(r.len) >= 45 * 60, live = !r.len; // no length = livestream page
      if (shared >= need && (long || live || perMatch.test(r.title))) out.videos.push({ videoId: r.id, code: e.code, title: r.title });
    }
    await sleep(400);
  }
  out.searched.push(e.code);
  if (Date.now() - t0 > 15000) process.stderr.write(`  slow: ${e.code} ${Math.round((Date.now() - t0) / 1000)}s\n`);
  if (++done % 10 === 0 && outFile) await fs.writeFile(outFile, JSON.stringify(out)); // partial results survive
  if (done % 50 === 0) process.stderr.write(`  ${done}/${Math.min(limit, evs.length)} events searched, ${out.videos.length} candidates\n`);
}
if (outFile) await fs.writeFile(outFile, JSON.stringify(out)); else console.log(JSON.stringify(out));
