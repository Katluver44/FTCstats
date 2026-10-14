// Lines each livestream recording up with the official match start times.
//
// YouTube's seek-bar preview thumbnails ("storyboards") hold a small frame every
// 10 s of a video, packed into sheets, so a whole event day is ~20 small images.
// We know when every match started (official clock), so we know which frames
// *should* show a match in progress. Slide that schedule along the frames and
// keep the shift at which the "during a match" frames look most unlike the rest
// (scoreboard up, robots moving, field cleared). Works for any overlay or none,
// because it only needs *something* on screen to differ during matches.
//
// Writes site/videos/calibrated.json { season: { videoId: seconds } }: how many
// seconds EARLIER matches appear in the recording than the official times say
// (same sign as offsets.json, which holds hand-measured values and wins).
//
//   node scripts/calibrate-streams.mjs 2025 [--only id,id] [--force] [--verbose]
//
// macOS only: the JPEG sheets are decoded with `sips`.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : null; };
const force = flag("--force"), verbose = flag("--verbose");
const only = opt("--only")?.split(",");
const seasons = args.map(Number);

const MATCH_SECONDS = 158; // 30 s auto + 8 s pickup + 2:00 driver period
const RANGE = 600;         // search ±10 minutes
const readJson = (f, fallback) => fs.readFile(f, "utf8").then(JSON.parse).catch(() => fallback);
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "Accept-Language": "en" };

// ---- storyboard frames ---------------------------------------------------

export async function storyboardSpec(id) {
  const html = await (await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: UA })).text();
  // YouTube's "unusual traffic" page isn't a video without previews: stop, don't cache a miss
  if (!html.includes("ytInitialPlayerResponse")) throw new Error("YouTube is rate-limiting watch pages; run again later");
  // the "Sign in to confirm you're not a bot" page also has a player response, minus the
  // previews; without this check every blocked video would be cached as "no storyboard"
  if (/"status":"LOGIN_REQUIRED"/.test(html) && /confirm you.{0,3}re not a bot/i.test(html)) throw new Error("YouTube is asking to confirm we're not a bot (rate-limited); run again later");
  const m = html.match(/"playerStoryboardSpecRenderer":\{"spec":"([^"]+)"/);
  if (!m) return null;
  const [base, ...levels] = JSON.parse(`"${m[1]}"`).split("|");
  return levels.map((l, L) => {
    const [w, h, count, cols, rows, interval, name, sigh] = l.split("#");
    return { L, w: +w, h: +h, count: +count, cols: +cols, rows: +rows, interval: +interval,
      url: (n) => `${base.replace("$L", L).replace("$N", name.replace("$M", n))}&sigh=${sigh}` };
  });
}

// BMP (as written by sips) -> { w, h, px: RGB Uint8Array, top-down }
function readBmp(buf) {
  const off = buf.readUInt32LE(10), w = buf.readInt32LE(18), hRaw = buf.readInt32LE(22), bpp = buf.readUInt16LE(28);
  const h = Math.abs(hRaw), bytes = bpp / 8, stride = Math.ceil((w * bytes) / 4) * 4;
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = off + (hRaw > 0 ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const s = row + x * bytes, d = (y * w + x) * 3;
      px[d] = buf[s + 2]; px[d + 1] = buf[s + 1]; px[d + 2] = buf[s];
    }
  }
  return { w, h, px };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "storyboard-"));
let tmpN = 0;
async function decodeJpeg(bytes) {
  const n = tmpN++, jpg = path.join(tmp, `${n}.jpg`), bmp = path.join(tmp, `${n}.bmp`);
  await fs.writeFile(jpg, bytes);
  await run("sips", ["-s", "format", "bmp", jpg, "--out", bmp]);
  const img = readBmp(await fs.readFile(bmp));
  await Promise.all([fs.rm(jpg), fs.rm(bmp)]);
  return img;
}

// Frames of the 80x45 level, each downsampled 2x to 40x22 RGB. Not kept on disk
// (5 MB a stream); the per-stream result is what gets cached.
export async function frames(id) {
  const spec = await storyboardSpec(id);
  const lv = spec?.find((l) => l.interval > 0 && l.w >= 80);
  if (!lv) return null;
  const W = Math.floor(lv.w / 2), H = Math.floor(lv.h / 2), dims = W * H * 3;
  const data = new Uint8Array(lv.count * dims);
  const perSheet = lv.cols * lv.rows;
  for (let n = 0; n * perSheet < lv.count; n++) {
    const res = await fetch(lv.url(n), { headers: UA });
    if (!res.ok) return null;
    const img = await decodeJpeg(Buffer.from(await res.arrayBuffer()));
    const tw = Math.floor(img.w / lv.cols), th = Math.floor(img.h / lv.rows);
    for (let i = 0; i < perSheet; i++) {
      const k = n * perSheet + i;
      if (k >= lv.count) break;
      const x0 = (i % lv.cols) * tw, y0 = Math.floor(i / lv.cols) * th;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += img.px[((y0 + 2 * y + dy) * img.w + x0 + 2 * x + dx) * 3 + c];
        data[k * dims + (y * W + x) * 3 + c] = s >> 2;
      }
    }
  }
  return { count: lv.count, interval: lv.interval / 1000, dims, data };
}

// ---- alignment -------------------------------------------------------------

// Score every shift o (seconds) by how strongly the frames separate into
// "in a match" vs not when match j occupies [pos_j - o, pos_j - o + MATCH_SECONDS).
// Score = sum over pixels of squared correlation with that in/out labelling.
function scan(fr, pos, lo, hi, len = MATCH_SECONDS) {
  const { count: n, interval, dims, data } = fr;
  const mean = new Float64Array(dims), sd = new Float64Array(dims);
  for (let k = 0; k < n; k++) for (let d = 0; d < dims; d++) mean[d] += data[k * dims + d];
  for (let d = 0; d < dims; d++) mean[d] /= n;
  for (let k = 0; k < n; k++) for (let d = 0; d < dims; d++) sd[d] += (data[k * dims + d] - mean[d]) ** 2;
  for (let d = 0; d < dims; d++) sd[d] = Math.sqrt(sd[d] / n) + 8; // +8: ignore near-constant pixels
  const z = new Float32Array(n * dims);
  for (let k = 0; k < n; k++) for (let d = 0; d < dims; d++) z[k * dims + d] = (data[k * dims + d] - mean[d]) / sd[d];

  const sum = new Float64Array(dims);
  let inside = new Uint8Array(n), c = 0;
  const scores = [];
  for (let o = lo; o <= hi; o++) {
    const next = new Uint8Array(n);
    for (const p of pos) {
      const a = Math.max(0, Math.ceil((p - o) / interval)), b = Math.min(n - 1, Math.ceil((p - o + len) / interval) - 1);
      for (let k = a; k <= b; k++) next[k] = 1;
    }
    for (let k = 0; k < n; k++) if (next[k] !== inside[k]) {
      const sgn = next[k] ? 1 : -1;
      c += sgn;
      for (let d = 0; d < dims; d++) sum[d] += sgn * z[k * dims + d];
    }
    inside = next;
    let s2 = 0;
    for (let d = 0; d < dims; d++) s2 += sum[d] * sum[d];
    scores.push(c > 0 && c < n ? s2 / (c * (n - c) / n) / n / dims : 0);
  }
  return scores; // index i <-> shift lo + i
}

function peak(scores, lo) {
  let i = 0;
  for (let j = 1; j < scores.length; j++) if (scores[j] > scores[i]) i = j;
  const sorted = [...scores].sort((a, b) => a - b), median = sorted[sorted.length >> 1];
  let second = 0;
  for (let j = 0; j < scores.length; j++) if (Math.abs(j - i) > 60) second = Math.max(second, scores[j]);
  return { o: lo + i, score: scores[i], lift: (scores[i] - median) / median, rival: second / scores[i] };
}

// lo..hi: shifts to try. A recording can be much shorter than its live window
// (the pre-show, or a dropped connection, isn't saved), so hi reaches past that gap.
export async function calibrate(fr, pos, gap = 0, range = null) {
  const lo = range?.lo ?? -RANGE, hi = range?.hi ?? Math.max(0, Math.round(gap)) + RANGE;
  // how long a match *looks* like a match varies (some scoreboards stay up minutes
  // after the buzzer), and a wrong length drags the shift, so fit it too
  let all, len;
  for (const L of [158, 220, 300, 400, 500]) {
    const r = peak(scan(fr, pos, lo, hi, L), lo);
    if (!all || r.score > all.score) { all = r; len = L; }
  }
  // both halves of the matches that land inside the video, refit near the best shift, must agree
  // (matches outside a partial video would make a half-day fit meaningless)
  const inVideo = pos.filter((p) => p - all.o >= 0 && p - all.o <= fr.count * fr.interval);
  const half = Math.floor(inVideo.length / 2);
  const near = { lo: all.o - 300, hi: all.o + 300 };
  const a = inVideo.length >= 10 ? peak(scan(fr, inVideo.slice(0, half), near.lo, near.hi, len), near.lo).o : null;
  const b = inVideo.length >= 10 ? peak(scan(fr, inVideo.slice(half), near.lo, near.hi, len), near.lo).o : null;
  const ok = inVideo.length >= 6 && all.lift > 0.5 && all.rival < 0.9 && // matches every ~7 min make near-rival peaks normal; the halves check is the real test
    all.o > lo + 30 && all.o < hi - 30 &&
    (a == null || (Math.abs(a - all.o) <= 60 && Math.abs(b - all.o) <= 60)); // streams drift a little over a day
  return { ...all, len, halves: [a, b], matches: inVideo.length, ok };
}

// ---- driver ------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const outFile = path.join("site", "videos", "calibrated.json");
  const out = await readJson(outFile, {});
  for (const season of seasons) {
    const videos = await readJson(path.join("site", "data", String(season), "videos.json"), {});
    const yt = await readJson(path.join(".cache", "videos", `${season}.json`), {}); // raw stream start, before any offset
    const cacheFile = path.join(".cache", "calibration", `${season}.json`);
    const cache = await readJson(cacheFile, {});
    const byStream = new Map(); // id -> official match times (ms) inside it
    for (const [code, v] of Object.entries(videos)) {
      const ev = await readJson(path.join("site", "data", String(season), "event", `${code}.json`), null);
      for (const s of v.streams) {
        const raw = yt[s.id];
        if (!raw?.start || (only && !only.includes(s.id))) continue;
        const end = raw.end ?? raw.start + (raw.seconds ?? 0) * 1000;
        const times = (ev?.matchList ?? []).filter((m) => m.played && m.time && m.time >= raw.start - RANGE * 1000 && m.time <= end + RANGE * 1000).map((m) => m.time);
        const gap = raw.end && raw.seconds ? (raw.end - raw.start) / 1000 - raw.seconds : 0; // live longer than the saved video
        byStream.set(s.id, { start: raw.start, gap, times: [...(byStream.get(s.id)?.times ?? []), ...times] });
      }
    }
    let done = 0, fixed = 0;
    const todo = [...byStream].filter(([id]) => force || !cache[id]);
    const saveCache = () => fs.mkdir(path.dirname(cacheFile), { recursive: true }).then(() => fs.writeFile(cacheFile, JSON.stringify(cache)));
    const worker = async () => {
      for (let job; (job = todo.shift()); ) {
        const [id, { start, gap, times }] = job;
        const fr = await frames(id).catch((e) => (console.warn(id, e.message), null));
        if (!fr) { cache[id] = { error: "no storyboard" }; continue; }
        const pos = times.map((t) => (t - start) / 1000).sort((a, b) => a - b);
        cache[id] = { ...(await calibrate(fr, pos, gap)), gap: Math.round(gap) };
        if (verbose) console.log(id, JSON.stringify(cache[id]));
        if (++done % 25 === 0) { await saveCache(); console.log(`  ${season}: ${done} more streams done, ${todo.length} to go`); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await saveCache();
    out[season] = {};
    for (const [id, r] of Object.entries(cache)) if (byStream.has(id) && r.ok) { out[season][id] = r.o; fixed++; }
    const big = Object.values(out[season]).filter((o) => Math.abs(o) > 20).length;
    console.log(`${season}: ${fixed} of ${byStream.size} streams calibrated (${big} off by more than 20 s)`);
  }
  await fs.writeFile(outFile, JSON.stringify(out, null, 1) + "\n");
  await fs.rm(tmp, { recursive: true, force: true });
}
