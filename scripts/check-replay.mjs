// Does replaying a finished event in the browser reproduce the build's stored
// pre-match predictions? (They should match closely: same model, same start.)
//   node scripts/check-replay.mjs 2025
import fs from "node:fs";
import path from "node:path";
import { replayEvent } from "../site/js/live.js";

const season = Number(process.argv[2] ?? 2025);
const dir = path.join("site", "data", String(season));
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json")));
let n = 0, sum = 0, max = 0, flips = 0;
for (const f of fs.readdirSync(path.join(dir, "event"))) {
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "event", f)));
  if (!ev.finished) continue;
  const replayed = replayEvent(meta, ev, ev.matchList).matches;
  ev.matchList.forEach((m, i) => {
    const a = m.pred?.pRed, b = replayed[i].pred?.pRed;
    if (!m.played || a == null || b == null) return;
    const d = Math.abs(a - b);
    n++; sum += d; max = Math.max(max, d);
    if ((a > 0.5) !== (b > 0.5)) flips++;
  });
}
console.log(`${season}: ${n} matches, mean |diff| ${(sum / n).toFixed(4)}, max ${max.toFixed(3)}, winner flips ${flips}`);
