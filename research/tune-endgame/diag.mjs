// Endgame diagnostics: what is the endgame target made of, how noisy is it,
// and how do trivial baselines do on the same (team, event) pairs?
//   node research/tune-endgame/diag.mjs [--params p.json]
import fs from "node:fs";
import { ctxs, EPA_SEASONS, epaRun, epaPairs, epaTargets } from "../lib.mjs";

const argv = process.argv.slice(2);
const pi = argv.indexOf("--params");
const over = pi >= 0 ? JSON.parse(fs.readFileSync(argv[pi + 1], "utf8")) : {};
const OFF = new Set(["OffSeason"]);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");

function wStats(ps, predOf) {
  let W = 0, ae = 0, e = 0, n = 0;
  const tm = ps.reduce((s, p) => s + p.w * p.target, 0) / ps.reduce((s, p) => s + p.w, 0);
  const sd = Math.sqrt(ps.reduce((s, p) => s + p.w * (p.target - tm) ** 2, 0) / ps.reduce((s, p) => s + p.w, 0));
  const xs = [], ys = [], ws = [];
  for (const p of ps) {
    const q = predOf(p); if (!Number.isFinite(q)) continue;
    W += p.w; ae += p.w * Math.abs(q - p.target); e += p.w * (q - p.target); n++;
    xs.push(q); ys.push(p.target); ws.push(p.w);
  }
  const Wx = ws.reduce((a, b) => a + b, 0), mx = xs.reduce((s, x, i) => s + ws[i] * x, 0) / Wx, my = ys.reduce((s, x, i) => s + ws[i] * x, 0) / Wx;
  let ab = 0, aa = 0, bb = 0; xs.forEach((x, i) => { ab += ws[i] * (x - mx) * (ys[i] - my); aa += ws[i] * (x - mx) ** 2; bb += ws[i] * (ys[i] - my) ** 2; });
  return { n, mae: ae / W, nmae: ae / W / sd, bias: e / W, corr: ab / Math.sqrt(aa * bb) };
}

for (const ctx of await ctxs(EPA_SEASONS)) {
  const { soloComps, matches } = ctx;
  const egSpecs = soloComps.map((c, j) => (c === "endgame" ? j : -1)).filter((j) => j >= 0);
  // composition: endgame points, solo share
  let egTot = 0, soloTot = 0, nAl = 0;
  const perRobot = []; // all per-robot solo endgame values (quals)
  for (const x of matches) {
    if (OFF.has(x.ev.type) || x.elim) continue;
    for (const side of ["red", "blue"]) {
      const a = x.actual[side]; egTot += a.endgame; nAl++;
      if (a.solo && egSpecs.every((j) => a.solo[j]?.length === x[side].length)) {
        const s = x[side].map((_, i) => egSpecs.reduce((q, j) => q + a.solo[j][i], 0));
        soloTot += s.reduce((p, q) => p + q, 0); perRobot.push(...s);
      }
    }
  }
  const hist = new Map(); for (const v of perRobot) hist.set(v, (hist.get(v) ?? 0) + 1);
  const top = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v, c]) => `${v}:${(100 * c / perRobot.length).toFixed(0)}%`).join(" ");

  // baselines: walk matches, snapshot each team's history at its first match of each event
  const st = new Map(); // team -> { soloSum, soloN, shSum, shN, lastEv, evSolo: Map }
  const snap = new Map();
  const tgByEv = new Map(epaTargets(ctx).events.map((e) => [e.code, new Map(e.pairs.map((p) => [p.team, p.endgame]))]));
  const lastTarget = new Map(); // team -> endgame target at its last finished official event
  const evOrder = [];
  let curEvTeams = new Map(); // event code -> set of teams seen
  for (const x of matches) {
    if (OFF.has(x.ev.type)) continue;
    for (const side of ["red", "blue"]) for (const t of x[side]) {
      const k = `${x.ev.code}:${t}`;
      if (!snap.has(k)) {
        const s = st.get(t);
        // last event: the team's most recent previous event's target
        let last = NaN;
        if (s?.evs) for (let i = s.evs.length - 1; i >= 0; i--) { const v = tgByEv.get(s.evs[i])?.get(t); if (v != null) { last = v; break; } }
        snap.set(k, s ? { seasonMean: s.n ? s.sum / s.n : NaN, recent: s.ema, last, nPrev: s.evs.length, cum: s.n } : { seasonMean: NaN, recent: NaN, last: NaN, nPrev: 0, cum: 0 });
        if (!st.has(t)) st.set(t, { sum: 0, n: 0, ema: NaN, evs: [] });
        const ss = st.get(t); if (ss.evs.at(-1) !== x.ev.code) ss.evs.push(x.ev.code);
      }
    }
    if (x.elim) continue;
    for (const side of ["red", "blue"]) {
      const a = x.actual[side], nums = x[side];
      const rec = a.solo && egSpecs.every((j) => a.solo[j]?.length === nums.length);
      if (!rec) continue;
      let shared = a.endgame; for (const j of egSpecs) shared -= a.solo[j].reduce((p, q) => p + q, 0);
      nums.forEach((t, i) => {
        const v = egSpecs.reduce((q, j) => q + a.solo[j][i], 0) + shared / nums.length;
        const s = st.get(t); s.sum += v; s.n++; s.ema = Number.isFinite(s.ema) ? s.ema + 0.15 * (v - s.ema) : v;
      });
    }
  }
  const run = await epaRun(ctx, over, ["endgame"]);
  const ps = epaPairs(ctx, run, "endgame").map((p) => ({ ...p, ...snap.get(`${p.ev}:${p.team}`) }));
  const later = ps.filter((p) => p.nPrev > 0 && Number.isFinite(p.last));
  const first = ps.filter((p) => !(p.nPrev > 0));
  const wm = ps.reduce((s, p) => s + p.w * p.target, 0) / ps.reduce((s, p) => s + p.w, 0);
  const sorted = ps.map((p) => p.target).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
  console.log(`\n=== ${ctx.season}  endgame avg/alliance ${f(egTot / nAl)}  solo share ${f(100 * soloTot / egTot, 0)}%  per-robot solo values (quals): ${top}`);
  console.log(`  pairs ${ps.length}: first-event ${first.length}, later ${later.length}; target mean ${f(wm)} median ${f(med)}`);
  const row = (name, list, fn) => { const s = wStats(list, fn); console.log(`  ${name.padEnd(34)} n ${String(s.n).padStart(5)}  MAE ${f(s.mae).padStart(5)}  nMAE ${f(s.nmae, 3)}  bias ${f(s.bias).padStart(6)}  corr ${f(s.corr, 3)}`); };
  row("ALL  EPA (current)", ps, (p) => p.pred);
  row("ALL  constant = weighted mean", ps, () => wm);
  row("ALL  constant = median", ps, () => med);
  row("FIRST-EVENT EPA (prior only)", first, (p) => p.pred);
  row("FIRST-EVENT constant mean", first, () => wm);
  row("LATER EPA", later, (p) => p.pred);
  row("LATER last-event target", later, (p) => p.last);
  row("LATER season mean of own per-match", later, (p) => p.seasonMean);
  row("LATER EMA(0.15) of own per-match", later, (p) => p.recent);
  row("LATER 0.5 EPA + 0.5 last", later, (p) => 0.5 * p.pred + 0.5 * p.last);
}
