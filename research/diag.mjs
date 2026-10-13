// Where is the model miscalibrated? Groups pre-match predictions by situation.
import { prepare, simulate } from "../scripts/build.mjs";
const seasons = (process.argv[2] ?? "2022,2023,2024,2025").split(",").map(Number);
const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
const groups = new Map();
const add = (g, p, o) => { const a = groups.get(g) ?? { n: 0, b: 0, p: 0, o: 0 }; a.n++; a.b += (p - o) ** 2; a.p += p; a.o += o; groups.set(g, a); };
const logit = (p) => Math.log(p / (1 - p));
// logistic-regression-ish: how much should the logit be stretched?
const stretch = new Map();
const addS = (g, p, o) => { const a = stretch.get(g) ?? []; a.push([logit(Math.min(0.999, Math.max(0.001, p))), o]); stretch.set(g, a); };
function fitScale(arr) { let best = [1, 1e9]; for (let s = 0.5; s <= 1.8; s += 0.02) { let b = 0; for (const [l, o] of arr) b += (1 / (1 + Math.exp(-s * l)) - o) ** 2; if (b < best[1]) best = [s, b]; } return best[0].toFixed(2); }
for (const season of seasons) {
  const ctx = await prepare(season);
  const seen = new Map(), evCount = new Map();
  simulate(ctx.matches, { ...ctx, params: JSON.parse(process.env.P ?? "{}") }, (x, pre, model, before) => {
    const o = outcome(x);
    const p = pre.pRed;
    // flip to favourite's view so bias is meaningful
    const pf = p >= 0.5 ? p : 1 - p, of = p >= 0.5 ? o : 1 - o;
    let minSeen = 99, rookies = 0, firstEvent = 0;
    for (const t of [...x.red, ...x.blue]) {
      const k = `${x.ev.code}/${t}`; const m = seen.get(k) ?? 0; minSeen = Math.min(minSeen, m); seen.set(k, m + 1);
      if (ctx.priors.size && !ctx.priors.has(t)) rookies++;
      if ((before.get(t).n) < 12) firstEvent++;
    }
    const tags = [
      "all", `season ${season}`, x.elim ? "elim" : "qual",
      `minSeen ${Math.min(minSeen, 4)}`, `rookies ${Math.min(rookies, 2)}`, `newish(n<12) ${Math.min(firstEvent, 3)}`,
      `type ${x.ev.type}`,
      `strength ${["low", "mid", "high"][Math.min(2, Math.floor((pre.red.np + pre.blue.np) / (2 * model.avgAllianceNp()) * 1.5))]}`,
      `fav ${Math.floor(pf * 10) / 10}`,
    ];
    for (const g of tags) { add(g, pf, of); addS(g, p, o); }
  });
}
console.log("group".padEnd(30), "n".padStart(6), "brier", " predFav", " actFav", " bestLogitScale");
for (const [g, a] of [...groups].sort()) console.log(g.padEnd(30), String(a.n).padStart(6), (a.b / a.n).toFixed(4), (a.p / a.n).toFixed(3).padStart(8), (a.o / a.n).toFixed(3).padStart(7), fitScale(stretch.get(g)).padStart(7));
