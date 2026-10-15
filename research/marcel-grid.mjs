// Marcel-style priors + reliability-dependent starting variance (2026-10).
// Grid on TRAIN (2022-2024) only; the train-best settings are then scored once
// on held-out 2025 next to the current model. Needs the seasons built in order
// (priors read site/data/<season - k>/teams-full.json).
//   node research/marcel-grid.mjs
//   PRIORS='{"nWeight":[0,1],"n0":[5,15,30],"nCap":[20,40,80]}' MODEL='{"v0Rel":[0,0.5,1,2],"carry":[1,1.3,1.6]}' node research/marcel-grid.mjs
// Prior keys: build.mjs PRIOR_OPTS (nWeight, n0, nCap, zTarget, nMinMatches, nMiss, ...).
// Model keys: Model params (v0Rel, v0RelRookie, carry, initFrac, ...).
// "early" = matches where some team is in its first 3 matches of the event; "first"
// = matches where some team plays its first match of the season (where priors matter most).
import { ctxs, TRAIN, TEST } from "./lib.mjs";
import { simulate } from "../scripts/build.mjs";

const PRIORS = JSON.parse(process.env.PRIORS ?? '{"nWeight":[0,1],"n0":[5,15,30],"nCap":[20,40,80]}');
const MODEL = JSON.parse(process.env.MODEL ?? '{"v0Rel":[0,0.5,1,2],"carry":[1,1.3,1.6]}');
const cross = (g) => Object.entries(g).reduce((acc, [k, vs]) => acc.flatMap((o) => vs.map((v) => ({ ...o, [k]: v }))), [{}]);

const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
function score(params, cs) {
  const s = { n: 0, b: 0, c: 0, en: 0, eb: 0, fn: 0, fb: 0 };
  for (const ctx of cs) {
    const seen = new Map(), seasonSeen = new Set();
    simulate(ctx.matches, { ...ctx, params }, (x, pre) => {
      const o = outcome(x), b = (pre.pRed - o) ** 2;
      s.n++; s.b += b; if (o !== 0.5 && (pre.pRed > 0.5) === (o === 1)) s.c++;
      let early = false, first = false;
      for (const t of [...x.red, ...x.blue]) {
        const k = `${x.ev.code}/${t}`, m = seen.get(k) ?? 0;
        if (m < 3) early = true;
        seen.set(k, m + 1);
        if (!seasonSeen.has(t)) { first = true; seasonSeen.add(t); }
      }
      if (early) { s.en++; s.eb += b; }
      if (first) { s.fn++; s.fb += b; }
    });
  }
  return { brier: s.b / s.n, acc: s.c / s.n, early: s.eb / s.en, first: s.fb / s.fn };
}
const fmt = (r) => `brier ${r.brier.toFixed(5)} acc ${(r.acc * 100).toFixed(2)}% early ${r.early.toFixed(4)} first ${r.first.toFixed(4)}`;

const rows = [];
for (const po of cross(PRIORS)) {
  const tr = await ctxs(TRAIN, po);
  for (const mp of cross(MODEL)) {
    // nWeight 0 with v0Rel 0 doesn't depend on n0/nCap: score it once
    if (!po.nWeight && !mp.v0Rel && rows.some((r) => !r.po.nWeight && !r.mp.v0Rel && JSON.stringify(r.mp) === JSON.stringify(mp))) continue;
    const r = score(mp, tr);
    rows.push({ po, mp, r });
    console.log(`${JSON.stringify(po).padEnd(40)} ${JSON.stringify(mp).padEnd(28)} ${fmt(r)}`);
  }
}
rows.sort((a, b) => a.r.brier - b.r.brier);
console.log("\n--- train top 10");
for (const { po, mp, r } of rows.slice(0, 10)) console.log(`${JSON.stringify(po).padEnd(40)} ${JSON.stringify(mp).padEnd(28)} ${fmt(r)}`);

// held-out: current model vs the train-best of each family (chosen on TRAIN only)
const pick = (f) => rows.find(f);
const picks = [
  ["current", { po: null, mp: {} }],
  ["best v0Rel only (nWeight 0)", pick((x) => !x.po.nWeight)],
  ["best Marcel (nWeight 1)", pick((x) => x.po.nWeight)],
  ["best Marcel, v0Rel 0", pick((x) => x.po.nWeight && !x.mp.v0Rel)],
];
console.log(`\n--- held-out ${TEST.join(",")} (settings chosen on train)`);
for (const [name, p] of picks) {
  if (!p) continue;
  const te = await ctxs(TEST, p.po);
  console.log(`${name.padEnd(30)} ${JSON.stringify(p.po ?? {})} ${JSON.stringify(p.mp)}  ${fmt(score(p.mp, te))}`);
}
