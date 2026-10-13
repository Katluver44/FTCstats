import { ctxs, TRAIN } from "./lib.mjs";
import { simulate } from "../scripts/build.mjs";
const P = {};
for (const ctx of await ctxs([...TRAIN, 2025])) {
  const bins = Array.from({ length: 8 }, () => [0, 0, 0]); const dis = Array.from({ length: 4 }, () => [0, 0, 0]);
  const opp = Array.from({ length: 5 }, () => [0, 0, 0]);
  simulate(ctx.matches, { ...ctx, params: P }, (x, pre, model, before) => {
    if (x.elim) return;
    const avg = model.avgAllianceNp();
    for (const [s, o] of [["red", "blue"], ["blue", "red"]]) {
      const lv = pre[s].np / avg, i = Math.max(0, Math.min(7, Math.floor(lv * 4)));
      const e = x.actual[s].np - pre[s].np;
      bins[i][0]++; bins[i][1] += e; bins[i][2] += e * e;
      const ts = x[s].map((t) => before.get(t).np); if (ts.length === 2) { const d = Math.abs(ts[0] - ts[1]) / avg; const j = Math.min(3, Math.floor(d * 4)); dis[j][0]++; dis[j][1] += e; dis[j][2] += e * e; }
      const ol = pre[o].np / avg, k = Math.max(0, Math.min(4, Math.floor(ol * 2.5))); opp[k][0]++; opp[k][1] += e; opp[k][2] += e * e;
    }
  });
  const f = (b, lab) => b.map((v, i) => v[0] ? `${lab(i)}:${(v[1] / v[0]).toFixed(1)}±${Math.sqrt(v[2] / v[0]).toFixed(0)}(n${v[0]})` : "").join("  ");
  console.log(ctx.matches[0].ev.season ?? "", "level/avg:", f(bins, (i) => (i / 4).toFixed(2)));
  console.log("   partner gap:", f(dis, (i) => (i / 4).toFixed(2)));
  console.log("   opp level:", f(opp, (i) => (i / 2.5).toFixed(1)));
}
