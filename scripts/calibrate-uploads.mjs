// Places matches in long event uploads that have no timestamps (site/videos/uploads.json,
// filled by add-videos.mjs). We don't know when such a video starts, so slide the
// event's official match schedule across the whole video's preview thumbnails and keep
// the spot where in-match frames stand out most (same method as calibrate-streams.mjs,
// same checks: a clear peak, and both halves of the day agreeing).
// Accepted videos get a spot per match in site/videos/timestamped.json.
//
//   node scripts/calibrate-uploads.mjs 2025 [--verbose]
// macOS only (sips), like calibrate-streams.mjs.

import fs from "node:fs/promises";
import path from "node:path";
import { frames, calibrate } from "./calibrate-streams.mjs";
import { ocrAlign, ocrSpots } from "./ocr-align.mjs";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const seasons = args.filter((a) => /^\d{4}$/.test(a)).map(Number);
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const LEAD = 20;

const up = await readJson(path.join("site", "videos", "uploads.json"), {});
const tsFile = path.join("site", "videos", "timestamped.json");
const ts = {}; // only what this run places; merged into the file at the end
const approxFit = (x) => !x.error && x.halves?.[0] != null && x.halves?.[1] != null && Math.abs(x.halves[0] - x.halves[1]) < 300 && x.lift > 3 && x.rival > 0.9 && x.o != null;
for (const season of seasons) {
  const cacheFile = path.join(".cache", "calibration", `uploads-${season}.json`);
  const cache = await readJson(cacheFile, {});
  ts[season] ??= {};
  let placed = 0, tried = 0;
  const fits = []; // { code, id, r, ms, pos }
  for (const [code, ids] of Object.entries(up[season] ?? {})) {
    const ev = await readJson(path.join("site", "data", String(season), "event", `${code}.json`), null);
    const ms = (ev?.matchList ?? []).filter((m) => m.played && m.time).sort((a, b) => a.time - b.time);
    if (ms.length < 6) continue;
    const t0 = ms[0].time;
    const pos = ms.map((m) => (m.time - t0) / 1000);
    for (const id of ids) {
      tried++;
      const k = `${id}@${code}`; // same video, different event = different fit
      if (!cache[k]) {
        const fr = await frames(id).catch(() => null);
        if (!fr) { cache[k] = { error: "no storyboard" }; continue; }
        const len = fr.count * fr.interval;
        // match j sits at pos[j] - o in the video. A full recording starts before the first
        // match (o in [-len, 0]); a later part ("Part 4") starts mid-event (o up to the event's span)
        cache[k] = { ...(await calibrate(fr, pos, 0, { lo: -Math.round(len), hi: Math.round(pos.at(-1)) + 600 })), len: Math.round(len) };
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(cache));
      }
      // rhythm not sure (one match cycle looks like the next): read the overlay instead
      if (!cache[k].ok && !cache[k].error && cache[k].ocr === undefined) {
        cache[k].ocr = await ocrAlign(id, { matchList: ms }).catch(() => null);
        await fs.writeFile(cacheFile, JSON.stringify(cache));
      }
      const o = cache[k].ocr;
      const ocrOk = o?.o != null && o.agree >= 5 && o.agree / o.est >= 0.4 && (o.ofMatch == null || o.ofMatch >= 0.6);
      if (verbose) console.log(code, id, JSON.stringify({ ...cache[k], halves: undefined }));
      // edited uploads (gaps cut) have no single shift; the overlay still says where each match is
      let direct = null;
      if (!ocrOk && !cache[k].ok && o) {
        direct = await ocrSpots(id, { matchList: ms });
        if (!(direct && direct.found >= Math.min(6, ms.length * 0.4) && direct.ordered >= 0.85 && (direct.ofMatch == null || direct.ofMatch >= 0.6))) direct = null;
      }
      if (direct) fits.push({ code, id, r: { score: 1 + direct.found, ok: true }, ms, pos, via: "overlay-direct", spots: direct.spots });
      else if (ocrOk) fits.push({ code, id, r: { ...cache[k], o: o.o, ok: true, score: 1 + o.agree }, ms, pos, via: "overlay" });
      else if (cache[k].ok) fits.push({ code, id, r: cache[k], ms, pos, via: "rhythm" });
      // a strong rhythm fit whose only doubt is a near-equal rival one match cycle away (both
      // halves of the day agree): placed anyway, at most about one match off (Arjun's call)
      else if (approxFit(cache[k])) fits.push({ code, id, r: { ...cache[k], ok: true, score: cache[k].score * 0.5 }, ms, pos, via: "rhythm-approx" });
    }
  }
  // a video that fits several events (same venue, morning and afternoon sessions) goes to
  // the one it fits clearly best, or to none
  for (const [id, fs_] of Map.groupBy(fits, (f) => f.id)) {
    // overlay readings beat rhythm; within a kind, the clearly better fit wins
    fs_.sort((a, b) => b.via.startsWith("overlay") - a.via.startsWith("overlay") || (a.via === "rhythm-approx") - (b.via === "rhythm-approx") || b.r.score - a.r.score);
    if (fs_[1] && fs_[1].via !== fs_[0].via) fs_.length = 1;
    if (fs_[1] && fs_[1].r.score > fs_[0].r.score * 0.8) { if (verbose) console.log(`  ${id}: fits ${fs_.map((f) => f.code).join(" and ")} about equally, skipped`); continue; }
    const { code, r, ms, pos } = fs_[0];
    let spots = fs_[0].spots;
    if (!spots) { spots = {}; ms.forEach((m, j) => { const at = Math.round(pos[j] - r.o) - LEAD; if (at >= 0 && at < r.len) spots[m.d] = at; }); }
    if (Object.keys(spots).length >= Math.min(6, ms.length * 0.4)) { (ts[season][code] ??= {})[id] = spots; placed++; if (verbose) console.log(`  placed ${id} -> ${code} (${fs_[0].via})`); }
  }
  console.log(`${season}: ${placed} of ${tried} uploads placed`);
}
// merge this run's placements into the file as it is now (other scripts edit it meanwhile)
const now = await readJson(tsFile, {});
for (const [s, evs] of Object.entries(ts)) for (const [code, vids] of Object.entries(evs)) Object.assign(((now[s] ??= {})[code] ??= {}), vids);
await fs.writeFile(tsFile, JSON.stringify(now, null, 1) + "\n");
