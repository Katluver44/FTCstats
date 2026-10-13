// Learns the point value of each per-robot outcome (e.g. "Ascent2", "Rigging",
// a parked flag) from alliance totals, so the model can credit points to the
// robot that earned them. Values are then checked against the game manuals.
//
//   node scripts/solo-values.mjs 2024

import { pathToFileURL } from "node:url";
import { SEASONS } from "../site/js/seasons.js";

const key = (v) => String(v ?? "None");
export const specTotal = (spec, raw) => (typeof spec.total === "function" ? spec.total(raw) : raw[spec.total]);

// Least squares: for each alliance, value[robot1 outcome] + value[robot2 outcome] = total.
export function fitSoloValues(season, events) {
  const specs = SEASONS[season].solo ?? [];
  return specs.map((spec) => {
    const cats = new Map();
    const rows = [];
    for (const ev of events) {
      for (const m of ev.matches) {
        for (const side of ["red", "blue"]) {
          const raw = m.scores?.[side];
          if (!raw) continue;
          const ks = spec.robots.map((f) => key(raw[f]));
          for (const k of ks) if (!cats.has(k)) cats.set(k, cats.size);
          rows.push({ ks, total: specTotal(spec, raw) });
        }
      }
    }
    const n = cats.size;
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const b = new Float64Array(n);
    for (const { ks, total } of rows) {
      const ix = ks.map((k) => cats.get(k));
      for (const i of ix) { b[i] += total; for (const j of ix) A[i][j] += 1; }
    }
    for (let i = 0; i < n; i++) A[i][i] += 1e-6;
    const x = gauss(A, b);
    const values = Object.fromEntries([...cats].map(([k, i]) => [k, Math.round(x[i] * 10) / 10]));
    // how often do the learned values reproduce the alliance total exactly?
    let exact = 0;
    for (const { ks, total } of rows) if (Math.abs(ks.reduce((s, k) => s + values[k], 0) - total) < 0.51) exact++;
    return { comp: spec.comp, label: spec.label, moved: !!spec.moved, parked: !!spec.parked, robots: spec.robots, values, exact: rows.length ? exact / rows.length : 0, rows: rows.length };
  });
}

function gauss(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[c][c]) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => (r[i] ? r[n] / r[i] : 0));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fs = await import("node:fs");
  const loadSeason = (season) => fs.readdirSync(`.cache/${season}`)
    .map((f) => JSON.parse(fs.readFileSync(`.cache/${season}/${f}`, "utf8"))).filter((e) => !e.remote);
  for (const season of process.argv.slice(2).map(Number)) {
    const fits = fitSoloValues(season, loadSeason(season));
    console.log(`${season} ${SEASONS[season].game}`);
    for (const f of fits) console.log(`  ${f.robots.join("/")}: ${JSON.stringify(f.values)}  exact ${(f.exact * 100).toFixed(1)}% of ${f.rows}`);
  }
}
