// Writes stand-in teams-all.json tables (cols team, np, matches) for the EPA track's priors
// under an off-season variant, into <outDir>/site/data/<season>/ (with teams.json copied from
// the real site/data). Then run epa-eval.mjs from <outDir> (with .cache symlinked) to score
// next seasons' priors built from those tables. One level only: each table is produced with
// the real (default) priors for its own season.
//   node research/tune-shared/gen-prior-tables.mjs <variant> <outDir>
//   variant: all04 | mti04 | all1 | mti1 | all02 | mti02
import fs from "node:fs";
import path from "node:path";
import { ctxs } from "../lib.mjs";
import { simulateEpa, isPlaceholder } from "../../scripts/build.mjs";
import { epaParams } from "../../site/js/model.js";
const [variant, outDir] = process.argv.slice(2);
const w = { all04: 0.4, mti04: 0.4, all1: 1, mti1: 1, all02: 0.2, mti02: 0.2 }[variant];
const cut = variant.startsWith("mti");
const MTI = /Maryland Tech Invitational|Multinational Tech Invitational/;
for (const season of [2019, 2020, 2021, 2022, 2023, 2024]) {
  const dir = path.join(outDir, "site", "data", String(season));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join("site", "data", String(season), "teams.json"), path.join(dir, "teams.json"));
  let ctx;
  try { [ctx] = await ctxs([season]); } catch (e) { console.log(season, "skip", e.message); continue; }
  const mti = ctx.events.filter((e) => MTI.test(e.name)).map((e) => e.start).sort()[0];
  const matches = ctx.matches.filter((x) => x.ev.type !== "OffSeason" || !cut || (mti && x.ev.start <= mti));
  const run = simulateEpa(matches, ctx, { epa: epaParams({ shared: { offWeight: w } }) });
  const n = new Map();
  for (const x of matches) for (const t of [...x.red, ...x.blue]) if (!isPlaceholder(t)) n.set(t, (n.get(t) ?? 0) + 1);
  const rows = [...n].map(([t, m]) => [t, Math.round(run.rate(t).np * 10) / 10, m]).sort((a, b) => b[1] - a[1]);
  fs.writeFileSync(path.join(dir, "teams-all.json"), JSON.stringify({ cols: ["team", "np", "matches"], rows }));
  // loadPriors reads the table named in meta.offTables.full
  const meta = JSON.parse(fs.readFileSync(path.join("site", "data", String(season), "meta.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, offTables: { ...meta.offTables, full: "teams-all.json" } }));
  console.log(season, variant, rows.length, "teams", mti ? `MTI ${mti}` : "");
}
