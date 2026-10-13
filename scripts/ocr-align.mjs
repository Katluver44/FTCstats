// Places matches in a video by reading the scoreboard overlay: YouTube's 320x180 preview
// thumbnails (one every 10 s) show "Qualification 12 of 40" and the match clock. Each
// readable frame says where that match is in the video; the shift most readings agree
// on (at least 3) is the answer. Settles what match rhythm alone can't (one match cycle
// looks like the next), and checks the event: the "of 40" must be its qual count.
//
//   import { ocrAlign } from "./ocr-align.mjs"; await ocrAlign(videoId, event) -> { o, reads, agree } | null
// macOS only (sips + the Vision framework via scripts/ocr/ocr.js).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { storyboardSpec } from "./calibrate-streams.mjs";

const run = promisify(execFile);
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36" };

// "2:24" -> seconds left on the clock
const clock = (t) => { const m = t.match(/^([0-2])[:.](\d\d)$/); return m ? +m[1] * 60 + +m[2] : null; };

// Every readable "Qualification N of M" / "Playoff Match N" frame in a video, cached
// (finished videos don't change): [{ t: seconds into the video, d, of, left }]
export async function ocrReads(id, { every = 3 } = {}) {
  const cacheFile = path.join(".cache", "ocr", `${id}.json`);
  const cached = await fs.readFile(cacheFile, "utf8").then(JSON.parse).catch(() => null);
  if (cached) return cached;
  const spec = await storyboardSpec(id);
  const lv = spec?.find((l) => l.interval > 0 && l.w >= 300);
  if (!lv) return null;
  const per = lv.cols * lv.rows, sheets = Math.ceil(lv.count / per), step = lv.interval / 1000;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
  const files = [];
  for (let n = 0; n < sheets; n += every) {
    const r = await fetch(lv.url(n), { headers: UA }).catch(() => null);
    if (!r?.ok) continue;
    const jpg = path.join(dir, `${n}.jpg`), png = path.join(dir, `${n}.png`);
    await fs.writeFile(jpg, Buffer.from(await r.arrayBuffer()));
    await run("sips", ["-s", "format", "png", "-Z", String(lv.w * lv.cols * 2), jpg, "--out", png]);
    files.push({ n, png });
  }
  const reads = [];
  for (let i = 0; i < files.length; i += 20) {
    const { stdout } = await run("osascript", ["-l", "JavaScript", path.resolve("scripts/ocr/ocr.js"), ...files.slice(i, i + 20).map((f) => f.png)], { maxBuffer: 64e6 });
    for (const line of stdout.trim().split("\n")) {
      const { file, lines } = JSON.parse(line);
      const n = files.find((f) => f.png === file).n;
      const tiles = {};
      for (const l of lines) (tiles[Math.floor(l.x * lv.cols) + lv.cols * Math.floor(l.y * lv.rows)] ??= []).push(l.text);
      for (const [t, texts] of Object.entries(tiles)) {
        const all = texts.join(" | ");
        // OCR misreads "of" as "ef", "d" for digits etc.; only clean numbers count
        const q = all.match(/Qual\w*\s+(\d{1,3})\s+\w{1,3}\s+(\d{1,3})\b/i), p = all.match(/Playoff\s+Match\s+(\d{1,2})\b/i);
        if (!q && !p) continue;
        const left = texts.map(clock).find((x) => x != null) ?? null;
        reads.push({ t: (n * per + +t) * step, d: q ? `Q-${+q[1]}` : `M-${+p[1]}`, of: q ? +q[2] : null, left });
      }
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(reads));
  return reads;
}

// Shift o that puts the event's matches where the overlay says they are (match j at
// video time pos[j] - o, pos measured from the event's first match).
export async function ocrAlign(id, ev, opts) {
  const reads = await ocrReads(id, opts);
  if (!reads) return null;
  const ms = ev.matchList.filter((m) => m.played && m.time);
  const t0 = Math.min(...ms.map((m) => m.time));
  const pos = new Map(ms.map((m) => [m.d, (m.time - t0) / 1000]));
  const quals = ms.filter((m) => m.d.startsWith("Q-")).length;
  // wrong event: its qual count disagrees with what the overlay says
  const ofs = reads.map((r) => r.of).filter((x) => x != null);
  const ofMatch = ofs.length ? ofs.filter((x) => x === quals).length / ofs.length : null;
  // each read -> estimated shift o (match j at video time pos[j] - o)
  const est = [];
  for (const r of reads) {
    if (!pos.has(r.d)) continue;
    const T = r.t;
    // auto period (clock 2:29..2:01) gives the start to the second; otherwise somewhere in the match
    const startAt = r.left != null && r.left < 150 && r.left > 120 ? T - (150 - r.left) : T - 80;
    est.push({ o: pos.get(r.d) - startAt, exact: r.left != null && r.left < 150 && r.left > 120 });
  }
  if (est.length < 3) return { reads: reads.length, est: est.length, ofMatch, o: null };
  // the shift most estimates agree with (within 2 min), then the median of those, exact ones first
  let best = null;
  for (const e of est) {
    const agree = est.filter((x) => Math.abs(x.o - e.o) <= 120);
    if (!best || agree.length > best.length) best = agree;
  }
  const exact = best.filter((x) => x.exact).map((x) => x.o).sort((a, b) => a - b);
  const all = best.map((x) => x.o).sort((a, b) => a - b);
  const o = exact.length >= 2 ? exact[exact.length >> 1] : all[all.length >> 1];
  return { o: Math.round(o), agree: best.length, est: est.length, exact: exact.length, reads: reads.length, ofMatch };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [season, code, id] = process.argv.slice(2);
  const ev = JSON.parse(await fs.readFile(path.join("site", "data", season, "event", `${code}.json`), "utf8"));
  console.log(JSON.stringify(await ocrAlign(id, ev)));
}

// Per-match spots read straight off the overlay, no single shift needed: works for edited
// uploads (dead time cut) too. A match starts where its label first shows (minus the
// clock's elapsed time when the auto clock is visible). Trusted when the labels mostly
// run in order and the "of N" is this event's qual count.
export async function ocrSpots(id, ev, opts) {
  const reads = await ocrReads(id, opts);
  if (!reads?.length) return null;
  const ms = ev.matchList.filter((m) => m.played);
  const have = new Set(ms.map((m) => m.d));
  const quals = ms.filter((m) => m.d.startsWith("Q-")).length;
  const ofs = reads.map((r) => r.of).filter((x) => x != null);
  const ofMatch = ofs.length ? ofs.filter((x) => x === quals).length / ofs.length : null;
  // the clock says how far in a frame is: 2:30-2:00 auto, then 8 s pickup, then teleop 2:00-0:00
  const elapsed = (left) => (left > 120 ? 150 - left : 158 - left);
  const byD = {};
  for (const r of reads.filter((r) => have.has(r.d))) (byD[r.d] ??= []).push(r);
  const first = {};
  for (const [d, rs] of Object.entries(byD)) {
    const timed = rs.filter((r) => r.left != null && r.left > 0 && r.left < 150).map((r) => r.t - elapsed(r.left)).sort((a, b) => a - b);
    // earliest start two clock readings agree on (a paused or restarted match shows a later
    // second start; a single misread digit is ignored); with no clock seen, the label's first
    // sighting minus half a match
    const agreed = timed.find((x, i) => timed.some((y, j) => j !== i && Math.abs(x - y) <= 12));
    first[d] = agreed ?? (timed.length ? timed[timed.length >> 1] : Math.min(...rs.map((r) => r.t)) - 80);
  }
  // in order: quals by number, then playoffs, should appear at increasing times
  const order = (d) => (d.startsWith("Q-") ? +d.slice(2) : 1000 + +d.slice(2));
  const seq = Object.entries(first).sort((a, b) => order(a[0]) - order(b[0])).map(([, t]) => t);
  let inOrder = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) inOrder++;
  const ordered = seq.length > 1 ? inOrder / (seq.length - 1) : 0;
  const spots = Object.fromEntries(Object.entries(first).map(([d, t]) => [d, Math.max(0, Math.round(t) - 20)]));
  return { spots, found: Object.keys(spots).length, of: ms.length, ordered, ofMatch };
}
