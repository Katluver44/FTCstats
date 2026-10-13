// Should off-season / scrimmage results move official ratings? Scored separately on
// official matches and on the unofficial ones.
import { ctxs } from "./lib.mjs";
import { simulate } from "../scripts/build.mjs";
const S = [2019, 2021, 2022, 2023, 2024, 2025]; const cs = await ctxs(S);
const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
for (const [name, set] of [["all update", []], ["fork OffSeason", ["OffSeason"]], ["fork OffSeason+Scrimmage", ["OffSeason", "Scrimmage"]]]) {
  const g = { off: [0, 0], scr: [0, 0], rest: [0, 0] };
  for (const c of cs) simulate(c.matches, { ...c, params: {}, unofficial: new Set(set) }, (x, pre) => {
    const k = x.ev.type === "OffSeason" ? "off" : x.ev.type === "Scrimmage" ? "scr" : "rest";
    g[k][0]++; g[k][1] += (pre.pRed - outcome(x)) ** 2;
  });
  console.log(name.padEnd(28), Object.entries(g).map(([k, [n, b]]) => `${k} ${(b / n).toFixed(5)} (n${n})`).join("  "));
}
