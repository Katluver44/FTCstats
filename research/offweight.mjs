// How much should off-season results count? For each weight w, the end-of-season
// rating is scored on how well it ranks teams by next season's official rating
// (Spearman), and the off-season matches' own Brier.
import fs from "node:fs";
import { ctxs } from "./lib.mjs";
import { simulate } from "../scripts/build.mjs";
const S = [2019, 2021, 2022, 2023, 2024];
const cs = await ctxs(S);
const nextRank = (y) => { const t = JSON.parse(fs.readFileSync(`site/data/${y}/teams.json`)); const mi = t.cols.indexOf("matches"); return new Map(t.rows.filter((r) => r[mi] >= 5).map((r, i) => [r[0], i])); };
const spearman = (a, b) => { const n = a.length; const rk = (v) => { const s = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], k) => (r[i] = k)); return r; }; const ra = rk(a), rb = rk(b); let d = 0; for (let i = 0; i < n; i++) d += (ra[i] - rb[i]) ** 2; return 1 - 6 * d / (n * (n * n - 1)); };
const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
for (const w of (process.env.W ?? "0,0.25,0.5,0.75,1").split(",").map(Number)) {
  const out = [];
  let nb = 0, bb = 0, aff = 0;
  for (const [k, c] of cs.entries()) {
    const touched = new Set();
    const { model } = simulate(c.matches, { ...c, params: {}, offWeight: w }, (x, pre) => { if (x.ev.type === "OffSeason") { nb++; bb += (pre.pRed - outcome(x)) ** 2; for (const t of [...x.red, ...x.blue]) touched.add(t); } });
    const nr = nextRank(S[k] + 1 === 2020 ? 2021 : S[k] + 1);
    const teams = [...model.teams.keys()].filter((t) => nr.has(t) && model.teams.get(t).n >= 5);
    const off = teams.filter((t) => touched.has(t));
    const sp = (ts) => spearman(ts.map((t) => -model.epa(t).np), ts.map((t) => nr.get(t)));
    out.push(`${S[k]} all ${sp(teams).toFixed(4)} offTeams(n${off.length}) ${off.length > 30 ? sp(off).toFixed(4) : "-"}`);
  }
  console.log(`w=${w}  offseason Brier ${(bb / nb).toFixed(4)}  | ${out.join(" | ")}`);
}
