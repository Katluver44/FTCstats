// Checks our advancement points (ev.adv in site/data/<season>/event/<code>.json,
// from site/js/advancement.js) against FIRST's published Advancement Points
// reports on ftc-events.firstinspires.org. Run after a build; exits 1 on any mismatch.
//
// The reports are HTML pages (FIRST's API has no points endpoint). They are cached in
// .cache/advreports/<season>/<code>.html and fetched at most once, one request every
// 2 s; any 429 or bot-check page stops the run without retrying.
//
//   npm run check-adv

import fs from "node:fs/promises";
import path from "node:path";

const SEASON = 2025;
// regression set: Qualifiers, Championships (two of them dual-division) and League Tournaments
const EVENTS = ["USCOCMP", "USVTHIQ", "USMNHEQ", "USMIGRQ", "USTXAUSQ", "USNYLICMP", "USFLCMP", "USMNCMP",
  "USORIMLT", "USNJUCLT2", "USFLGCLT", "USMIAVLT1"];
const CATS = ["total", "judging", "playoff", "selection", "qual"];

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, " ");

// report rows: rank, team, name, total, judging, playoff, selection, qualification, # advanced
export function parseReport(html) {
  const text = decode(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "|").replace(/\s*\|[\s|]*/g, "|"));
  const i = text.indexOf("|# Advanced|");
  if (i < 0) return null;
  const toks = text.slice(i + 12).split("|");
  const rows = [];
  for (let k = 0; k + 8 < toks.length && /^\d+$/.test(toks[k]); k += 9) {
    const r = toks.slice(k, k + 9);
    rows.push({ rank: +r[0], team: +r[1], name: r[2], total: +r[3], judging: +r[4], playoff: +r[5], selection: +r[6], qual: +r[7] });
  }
  return rows;
}

let lastFetch = 0;
async function report(code) {
  const file = path.join(".cache", "advreports", String(SEASON), `${code}.html`);
  const cached = await fs.readFile(file, "utf8").catch(() => null);
  if (cached) return cached;
  const wait = lastFetch + 2000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(`https://ftc-events.firstinspires.org/${SEASON}/${code}/advancementpoints`, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
  });
  const html = await res.text();
  if (res.status === 429 || /captcha|unusual traffic|are you a robot|access denied/i.test(html)) {
    console.error(`Stopped: ${res.status} / bot check from ftc-events for ${code}. Not retrying; try again tomorrow.`);
    process.exit(2);
  }
  if (!res.ok) throw new Error(`ftc-events ${res.status} for ${code}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, html);
  return html;
}

let failed = 0;
for (const code of EVENTS) {
  const theirs = parseReport(await report(code));
  const ev = JSON.parse(await fs.readFile(path.join("site", "data", String(SEASON), "event", `${code}.json`), "utf8").catch(() => "null"));
  if (!theirs?.length) { console.log(`${code}: report has no rows`); failed++; continue; }
  if (!ev?.adv) { console.log(`${code}: no ev.adv in the event file (run npm run build)`); failed++; continue; }
  const ours = new Map(ev.adv.rows.map(([team, total, judging, playoff, selection, qual], i) => [team, { team, total, judging, playoff, selection, qual, pos: i + 1 }]));
  const bad = [];
  let orderOk = 0;
  for (const r of theirs) {
    const m = ours.get(r.team);
    if (!m) {
      // FIRST lists registered teams that never played, with 0 points; we leave them out
      if (CATS.some((k) => r[k])) bad.push(`${r.team}: missing here, FIRST has ${r.total}`);
      continue;
    }
    const diffs = CATS.filter((k) => m[k] !== r[k]);
    if (diffs.length) bad.push(`${r.team}: ${diffs.map((k) => `${k} ours ${m[k]} FIRST ${r[k]}`).join(", ")}`);
    if (m.pos === r.rank) orderOk++;
  }
  const extra = [...ours.values()].filter((m) => !theirs.some((r) => r.team === m.team) && m.total);
  for (const m of extra) bad.push(`${m.team}: ${m.total} points here, not in FIRST's report`);
  const matched = theirs.filter((r) => ours.has(r.team)).length;
  console.log(`${code}: ${bad.length ? "MISMATCH" : "ok"} ${matched - bad.filter((b) => !/missing|not in/.test(b)).length}/${matched} teams exact in every category; same rank order for ${orderOk}/${matched}`);
  for (const b of bad.slice(0, 15)) console.log(`   ${b}`);
  if (bad.length) failed++;
}
console.log(failed ? `${failed} event(s) differ from FIRST's reports` : `All ${EVENTS.length} events match FIRST's reports`);
process.exit(failed ? 1 : 0);
