// How noisy is the endgame target itself? For each (team, official event) the
// robot's own (solo) endgame points per qual match: split-half reliability of
// the event mean (odd vs even matches, Spearman-Brown corrected), and the
// expected |target noise| = 0.8 * SD/sqrt(n) as a fraction of the target SD.
// Uses the solo part only (2023-2025 endgame is ~all solo).
import { ctxs, EPA_SEASONS, epaTargets } from "../lib.mjs";

const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
for (const ctx of await ctxs(EPA_SEASONS)) {
  const eg = ctx.soloComps.map((c, j) => (c === "endgame" ? j : -1)).filter((j) => j >= 0);
  const tgt = new Map();
  for (const e of epaTargets(ctx).events) for (const p of e.pairs) tgt.set(`${e.code}:${p.team}`, { w: e.w, target: p.endgame });
  const per = new Map();
  for (const x of ctx.matches) {
    if (x.elim) continue;
    for (const side of ["red", "blue"]) {
      const s = x.actual[side].solo, nums = x[side];
      if (!s || !eg.every((j) => s[j]?.length === nums.length)) continue;
      nums.forEach((t, i) => {
        const k = `${x.ev.code}:${t}`; if (!tgt.has(k)) return;
        if (!per.has(k)) per.set(k, []);
        per.get(k).push(eg.reduce((q, j) => q + s[j][i], 0));
      });
    }
  }
  const A = [], B = [], W = [];
  let se = 0, ws = 0, tm = 0;
  for (const [k, xs] of per) {
    const { w } = tgt.get(k);
    const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
    se += w * 0.8 * sd / Math.sqrt(n); ws += w; tm += w * m;
    const odd = xs.filter((_, i) => i % 2), even = xs.filter((_, i) => !(i % 2));
    if (odd.length >= 2) { A.push(odd.reduce((a, b) => a + b, 0) / odd.length); B.push(even.reduce((a, b) => a + b, 0) / even.length); W.push(w); }
  }
  tm /= ws;
  let sdT = 0; for (const [k, xs] of per) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; sdT += tgt.get(k).w * (m - tm) ** 2; }
  sdT = Math.sqrt(sdT / ws);
  const ma = A.reduce((a, b) => a + b, 0) / A.length, mb = B.reduce((a, b) => a + b, 0) / B.length;
  let ab = 0, aa = 0, bb = 0; A.forEach((a, i) => { ab += (a - ma) * (B[i] - mb); aa += (a - ma) ** 2; bb += (B[i] - mb) ** 2; });
  const r = ab / Math.sqrt(aa * bb), rel = 2 * r / (1 + r);
  console.log(`${ctx.season}  solo-endgame event means: pairs ${per.size}  mean ${f(tm, 2)}  SD ${f(sdT, 2)}  split-half r ${f(r)}  reliability ${f(rel)}  E|noise| ${f(se / ws, 2)} = ${f(se / ws / sdT)} of SD  max corr with any predictor ~ sqrt(rel) ${f(Math.sqrt(rel))}`);
}
