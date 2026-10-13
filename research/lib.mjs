import { prepare, simulate } from "../scripts/build.mjs";
export const TRAIN = [2022, 2023, 2024], TEST = [2025];
const cache = new Map();
export async function ctxs(seasons) { const out = []; for (const s of seasons) { if (!cache.has(s)) cache.set(s, await prepare(s)); out.push(cache.get(s)); } return out; }
const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
export function evaluate(params, cs) {
  let n = 0, b = 0, c = 0, mae = 0;
  for (const ctx of cs) simulate(ctx.matches, { ...ctx, params }, (x, pre) => {
    const o = outcome(x); n++; b += (pre.pRed - o) ** 2; if (o !== 0.5 && (pre.pRed > 0.5) === (o === 1)) c++;
    mae += (Math.abs(pre.red.np - x.actual.red.np) + Math.abs(pre.blue.np - x.actual.blue.np)) / 2;
  });
  return { brier: b / n, acc: c / n, mae: mae / n };
}
// coordinate descent: grid = { key: [values] }
export async function tune(start, grid, { passes = 2, log = true } = {}) {
  const tr = await ctxs(TRAIN);
  let best = { ...start }, bl = evaluate(best, tr).brier;
  for (let p = 0; p < passes; p++) {
    let moved = false;
    for (const [k, vals] of Object.entries(grid)) for (const v of vals) {
      const t = { ...best, [k]: v }; const l = evaluate(t, tr).brier;
      if (l < bl - 1e-6) { best = t; bl = l; moved = true; }
    }
    if (log) console.log(`pass ${p}: ${bl.toFixed(5)} ${JSON.stringify(Object.fromEntries(Object.keys(grid).map((k) => [k, best[k]])))}`);
    if (!moved) break;
  }
  return best;
}
export async function report(name, params) {
  const a = evaluate(params, await ctxs(TRAIN)), b = evaluate(params, await ctxs(TEST));
  console.log(`${name.padEnd(28)} train ${a.brier.toFixed(5)} ${(a.acc * 100).toFixed(2)}% mae ${a.mae.toFixed(2)} | 2025 ${b.brier.toFixed(5)} ${(b.acc * 100).toFixed(2)}% mae ${b.mae.toFixed(2)}`);
  return [a, b];
}
