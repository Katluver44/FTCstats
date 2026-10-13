// Diagnostics for the auto EPA: where does the bias come from?
// node research/tune-auto/diag.mjs '<auto override json>'
import { ctxs, EPA_SEASONS, epaRun, epaMetrics, epaTargets } from "../lib.mjs";
const auto = JSON.parse(process.argv[2] || "{}");
const all = await ctxs(EPA_SEASONS);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const stats = (ps) => { const n = ps.length; if (!n) return "n 0"; const b = ps.reduce((s, p) => s + p.err, 0) / n, m = ps.reduce((s, p) => s + Math.abs(p.err), 0) / n; return `n ${String(n).padStart(5)} bias ${f(b).padStart(6)} mae ${f(m).padStart(5)}`; };
for (const c of all) {
  const run = await epaRun(c, { auto }, ["auto"]);
  const m = epaMetrics(c, run, "auto");
  const ps = m.pairs;
  // event order per team (by first-match index)
  const firstIdx = new Map();
  c.matches.forEach((x, i) => { for (const t of [...x.red, ...x.blue]) { const k = `${x.ev.code}:${t}`; if (!firstIdx.has(k)) firstIdx.set(k, i); } });
  const evOrd = new Map(), byTeam = new Map();
  for (const p of ps) { if (!byTeam.has(p.team)) byTeam.set(p.team, []); byTeam.get(p.team).push(p); }
  for (const [, l] of byTeam) l.sort((a, b) => firstIdx.get(`${a.ev}:${a.team}`) - firstIdx.get(`${b.ev}:${b.team}`)).forEach((p, i) => evOrd.set(p, i));
  const cutT = ps.map((p) => p.target).sort((a, b) => b - a)[Math.floor(ps.length * 0.05)];
  const cutP = ps.map((p) => p.pred).sort((a, b) => b - a)[Math.floor(ps.length * 0.05)];
  console.log(`${c.season}  all ${stats(ps)}`);
  console.log(`   top5% by target ${stats(ps.filter((p) => p.target >= cutT))} | top5% by pred ${stats(ps.filter((p) => p.pred >= cutP))}`);
  for (const k of [0, 1, 2, 3]) console.log(`   team's event #${k + 1}${k === 3 ? "+" : " "} ${stats(ps.filter((p) => (k === 3 ? evOrd.get(p) >= 3 : evOrd.get(p) === k)))}`);
  const third = Math.floor(c.matches.length / 3);
  for (const [lab, lo, hi] of [["early", 0, third], ["mid", third, 2 * third], ["late", 2 * third, 1e9]]) console.log(`   season ${lab.padEnd(5)} ${stats(ps.filter((p) => { const i = firstIdx.get(`${p.ev}:${p.team}`); return i >= lo && i < hi; }))}`);
  console.log(`   worlds ${stats(ps.filter((p) => p.type === "FIRSTChampionship"))}`);
}
