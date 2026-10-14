// Looks at EVERY video of every channel that has ever given us an FTC video, across all
// seasons, and proposes an event for each livestream recording and long upload it finds.
// Proposals go to add-videos.mjs, which checks each against the official match times.
//
// A stream is proposed for an event when the event's matches happened while it was live
// and either its title names the event (shared distinctive words), or the channel's home
// region (where its already-confirmed videos are) has exactly one event live at that time.
//
//   node scripts/scan-channels.mjs [--channels extra.json …] [--out dir] [--budget 8000]
//   for s in 2019 … 2025; do node scripts/add-videos.mjs $s --file dir/cands-$s.json; done
//
// Channel uploads are cached in .cache/channels/ (finished videos don't change).

import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
let budget = +opt("--budget", 8000);
const outDir = opt("--out", ".cache/channels/out");
const force = args.includes("--force"); // rescan channels scanned this week too
const extra = [];
for (let i; (i = args.indexOf("--channels")) >= 0;) extra.push(args.splice(i, 2)[1]);
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const key = process.env.YOUTUBE_API_KEY ?? (await fs.readFile(".env", "utf8").catch(() => "")).match(/^YOUTUBE_API_KEY=(\S+)/m)?.[1];
const SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

async function yt(endpoint, params) {
  if (budget < 1) throw Object.assign(new Error("out of budget"), { budget: true });
  budget--;
  const u = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key })) u.searchParams.set(k, v);
  const r = await (await fetch(u)).json();
  if (r.error) throw Object.assign(new Error(`YouTube ${endpoint}: ${r.error.message}`), { budget: /quota/i.test(r.error.message) });
  return r;
}
const isoSeconds = (d) => { const m = String(d ?? "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)) : 0; };
const ytId = (u) => String(u).match(/(?:v=|youtu\.be\/|live\/|embed\/)([\w-]{11})/)?.[1] ?? (/^[\w-]{11}$/.test(u) ? u : null);

// ---- channels to scan
const channels = new Set(await readJson(path.join("site", "videos", "channels.json"), []));
for (const s of SEASONS) {
  const c = await readJson(path.join(".cache", "streams", `${s}.json`), { videos: {} });
  for (const v of Object.values(c.videos)) if (v.channel && v.start && v.end && v.ok) channels.add(v.channel);
}
for (const f of extra) {
  const j = await readJson(f, {});
  for (const c of j.channels ?? []) if (/^UC[\w-]{22}$/.test(c.channelId ?? "")) channels.add(c.channelId);
}
// channels of every video we already use (found by hand, FIRST links …)
const used = new Map(); // videoId -> [{ season, code }]
const note = (s, code, id) => id && !String(id).startsWith("bili:") && (used.get(id) ?? used.set(id, []).get(id)).push({ season: +s, code });
const ov = await readJson(path.join("site", "videos", "overrides.json"), {});
const disc = await readJson(path.join("site", "videos", "discovered.json"), {});
const ts = await readJson(path.join("site", "videos", "timestamped.json"), {});
const up = await readJson(path.join("site", "videos", "uploads.json"), {});
for (const [s, evs] of Object.entries(ov)) for (const [code, o] of Object.entries(evs)) for (const u of o.streams ?? []) note(s, code, ytId(u));
for (const [s, evs] of Object.entries(disc)) for (const [code, ids] of Object.entries(evs)) for (const id of ids) note(s, code, id);
for (const [s, evs] of Object.entries(ts)) for (const [code, vids] of Object.entries(evs)) for (const id of Object.keys(vids)) note(s, code, id);
for (const [s, evs] of Object.entries(up)) for (const [code, ids] of Object.entries(evs)) for (const id of ids) note(s, code, id);
for (const s of SEASONS) {
  const v = await readJson(path.join("site", "data", String(s), "videos.json"), {});
  for (const [code, e] of Object.entries(v)) for (const x of [...e.streams, ...e.uploads]) note(s, code, x.id);
}
// owners of used videos we don't know yet: 50 per unit
const owner = await readJson(path.join(".cache", "channels", "owners.json"), {});
try {
  const todo = [...used.keys()].filter((id) => !(id in owner));
  for (let i = 0; i < todo.length; i += 50) {
    const r = await yt("videos", { part: "snippet", id: todo.slice(i, i + 50).join(",") });
    for (const id of todo.slice(i, i + 50)) owner[id] = null;
    for (const v of r.items) owner[v.id] = v.snippet.channelId;
  }
} catch (e) { if (!e.budget) throw e; }
await fs.mkdir(path.join(".cache", "channels"), { recursive: true });
await fs.writeFile(path.join(".cache", "channels", "owners.json"), JSON.stringify(owner));
for (const c of Object.values(owner)) if (c) channels.add(c);
console.log(`${channels.size} channels to scan`);

// ---- every upload of every channel (cached; rescanned weekly)
async function scan(ch) {
  const file = path.join(".cache", "channels", `${ch}.json`);
  const c = await readJson(file, { scanned: 0, videos: {} });
  if (!force && Date.now() - c.scanned < 7 * 864e5) return c;
  // the channel's streams and videos tabs, every page (YouTube's own pages: no quota)
  const fresh = [];
  for (const tab of ["streams", "videos"]) {
    for (const v of await channelTab(ch, tab)) {
      if (c.videos[v.id]?.len != null) continue; // seen: details don't change
      c.videos[v.id] = { title: v.title };
      fresh.push(v.id);
    }
  }
  for (let i = 0; i < fresh.length; i += 50) {
    const r = await yt("videos", { part: "snippet,liveStreamingDetails,contentDetails", id: fresh.slice(i, i + 50).join(",") });
    for (const v of r.items) {
      c.videos[v.id].at = Date.parse(v.snippet.publishedAt);
      c.videos[v.id].stamps = /\b\d{1,2}:\d\d(?::\d\d)?\b[^\n]{0,20}\b(?:Q|Qual|Qualification)[\s#-]*\d/i.test(v.snippet.description ?? "");
      const live = v.liveStreamingDetails ?? {}, region = v.contentDetails?.regionRestriction ?? {};
      Object.assign(c.videos[v.id], { len: isoSeconds(v.contentDetails?.duration),
        start: live.actualStartTime ? Date.parse(live.actualStartTime) : null, end: live.actualEndTime ? Date.parse(live.actualEndTime) : null,
        usBlocked: (region.blocked ?? []).includes("US") || (region.allowed ? !region.allowed.includes("US") : false) });
    }
  }
  c.scanned = Date.now();
  await fs.writeFile(file, JSON.stringify(c));
  return c;
}


const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36", "Accept-Language": "en-US,en", Cookie: "SOCS=CAI; CONSENT=YES+1" };
const walk = (o, k, out = []) => { if (o && typeof o === "object") { if (o[k]) out.push(o[k]); for (const v of Object.values(o)) walk(v, k, out); } return out; };
async function channelTab(ch, tab) {
  const out = [];
  const html = await fetch(`https://www.youtube.com/channel/${ch}/${tab}`, { headers: UA }).then((r) => r.text()).catch(() => "");
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return out;
  const d = JSON.parse(m[1]);
  // the selected tab's items; the next page's token is in the LAST continuation item
  // (the first one found can point back at page one)
  const root = walk(d, "tabRenderer").find((t) => t.selected)?.content ?? d;
  const next = (o) => walk(o, "continuationItemRenderer").at(-1)?.continuationEndpoint?.continuationCommand?.token;
  const seen = new Set();
  const take2 = (o) => { let fresh = 0; for (const v of walk(o, "lockupViewModel")) if (v.contentId && !seen.has(v.contentId)) { seen.add(v.contentId); fresh++; out.push({ id: v.contentId, title: v.metadata?.lockupMetadataViewModel?.title?.content ?? "" }); } return fresh; };
  take2(root);
  let tok = next(root);
  for (let i = 0; tok && i < 400; i++) {
    const r = await fetch("https://www.youtube.com/youtubei/v1/browse", { method: "POST", headers: { ...UA, "Content-Type": "application/json" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20240726.00.00", hl: "en" } }, continuation: tok }) }).then((x) => x.json()).catch(() => null);
    if (!r || !take2(r)) break; // nothing new: end of the list
    tok = next(r);
  }
  return out;
}

// ---- events of every season
const STOP = new Set(("ftc first tech challenge tournament qualifier qualifiers qualifying qualification qt league leagues meet meets championship championships " +
  "regional region the of at and in event events division robotics robot competition live livestream stream streaming day field scrimmage presented by season " +
  "game decode into deep centerstage center stage powerplay power play freight frenzy ultimate goal skystone vs match matches part final finals playoffs playoff " +
  "state north south east west central northern southern eastern western upper lower new high school usa").split(" "));
const words = (s) => [...new Set(String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b([a-z](?:\s*&\s*[a-z])*)[\s-]+(league|division)\b/g, (_, l, k) => l.replace(/[\s&]/g, "") + k)
  .replace(/\b(group|pool|division|league)\s+([a-z]\d?)\b/g, "$1$2")
  .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
const nums = (t) => new Set([...String(t).matchAll(/(?:#|\bno\.?\s*|\b(?:qt|meet|qualifier|tournament|league)\s*)(\d{1,2})\b/gi)].map((m) => +m[1]));
const regionOf = (loc) => { const p = String(loc ?? "").split(",").map((x) => x.trim()).filter(Boolean); return p.at(-1) === "USA" ? `US-${p.at(-2)}` : p.at(-1) ?? "?"; };
const evs = [];
for (const s of SEASONS) {
  const vids = await readJson(path.join("site", "data", String(s), "videos.json"), {});
  for (const f of await fs.readdir(path.join("site", "data", String(s), "event")).catch(() => [])) {
    const e = await readJson(path.join("site", "data", String(s), "event", f), null);
    const times = (e?.matchList ?? []).filter((m) => m.played && m.time).map((m) => m.time).sort((a, b) => a - b);
    if (!times.length) continue;
    evs.push({ season: s, code: e.code, name: e.name, region: regionOf(e.loc), start: Date.parse(e.start), end: Date.parse(e.end) + 864e5,
      times, w: words(`${e.name} ${String(e.loc ?? "").split(",")[0]}`), n: nums(e.name), have: vids[e.code] });
  }
}
const df = new Map();
for (const e of evs) for (const w of e.w) df.set(w, (df.get(w) ?? 0) + 1);
const rare = (w) => (df.get(w) ?? 0) <= 15;
const covered = (e, t) => { const v = e.have; return !!v && (v.uploads.some((u) => Math.abs(u.t - t) < 90e3) || v.streams.some((s) => t >= s.start && t <= s.end)); };

// ---- propose
const cands = Object.fromEntries(SEASONS.map((s) => [s, []]));
const perMatch = new Map(); // channel -> number of per-match titles
const stampCh = new Set();
const NOT_FTC = /\b(vex|v5rc|vrc|vexu|fll|lego|frc|rebuilt|reefscape|crescendo|charged up|rapid react|infinite recharge)\b/i;
let n = 0;
// list channels a few at a time (each is many page requests); details calls share the budget
const scanned = new Map();
try {
  const todo = [...channels];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let ch; (ch = todo.shift());) scanned.set(ch, await scan(ch));
  }));
} catch (e) { if (!e.budget) throw e; console.log(`quota budget used up after ${scanned.size} channels; run again to continue`); }
try {
  for (const ch of channels) {
    const c = scanned.get(ch);
    if (!c) continue;
    n++;
    // the channel's home: regions of events its videos are already filed under
    const home = new Set([...used].filter(([id]) => c.videos[id]).flatMap(([, xs]) => xs.map((x) => evs.find((e) => e.season === x.season && e.code === x.code)?.region)).filter(Boolean));
    for (const [id, v] of Object.entries(c.videos)) {
      if (v.usBlocked || NOT_FTC.test(v.title)) continue;
      if (/\b(?:Qualification|Qual|Q)[\s#-]*\d{1,3}\b|\bPlayoff\b/i.test(v.title) && v.len && v.len < 20 * 60) perMatch.set(ch, (perMatch.get(ch) ?? 0) + 1);
      if (v.stamps) stampCh.add(ch);
      if (used.has(id)) continue;
      const tw = new Set(words(v.title)), tn = nums(v.title);
      const nameScore = (e) => {
        if (e.n.size && tn.size && ![...e.n].some((x) => tn.has(x))) return -1;
        const sh = e.w.filter((x) => tw.has(x));
        return sh.some(rare) ? sh.length : 0;
      };
      let fits = [];
      if (v.start && v.end) {
        fits = evs.map((e) => {
          const inside = e.times.filter((t) => t >= v.start - 60e3 && t <= v.end + 60e3);
          if (inside.length < (e.times.length <= 4 ? 1 : 2)) return null;
          return { e, inside: inside.length, fresh: inside.filter((t) => !covered(e, t)).length, score: nameScore(e) };
        }).filter((x) => x && x.score >= 0);
      } else if (v.len >= 45 * 60) {
        fits = evs.filter((e) => v.at >= e.start - 864e5 && v.at <= e.end + 30 * 864e5).map((e) => ({ e, inside: 0, fresh: 1, score: nameScore(e) }));
      } else continue;
      if (!fits.length) continue;
      fits.sort((a, b) => b.score - a.score || b.inside - a.inside);
      let pick = null;
      if (fits[0].score >= 1 && (!fits[1] || fits[1].score < fits[0].score)) pick = fits[0];
      else if (v.start && home.size) { // name says nothing: the one event live in the channel's home region
        const local = fits.filter((x) => home.has(x.e.region));
        if (local.length === 1 && fits[0].score === 0) pick = local[0];
      }
      if (!pick || !pick.fresh) continue;
      cands[pick.e.season].push({ videoId: id, code: pick.e.code, title: v.title, why: `${ch} ${pick.score ? "name" : "home region"} ${pick.inside} inside` });
    }
  }
} catch (e) { if (!e.budget) throw e; }

await fs.mkdir(outDir, { recursive: true });
for (const s of SEASONS) if (cands[s].length) await fs.writeFile(path.join(outDir, `cands-${s}.json`), JSON.stringify({ videos: cands[s] }, null, 1));
await fs.writeFile(path.join(outDir, "per-match-channels.json"), JSON.stringify([...perMatch].filter(([, k]) => k >= 10).sort((a, b) => b[1] - a[1]), null, 1));
await fs.writeFile(path.join(outDir, "timestamp-channels.json"), JSON.stringify([...stampCh], null, 1));
console.log(SEASONS.map((s) => `${s}:${cands[s].length}`).join(" "), `| ${[...perMatch].filter(([, k]) => k >= 10).length} per-match channels, ${stampCh.size} with timestamped descriptions | budget left ${budget}`);
