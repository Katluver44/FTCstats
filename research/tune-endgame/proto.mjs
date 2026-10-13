// Prototype of a code change (NOT in model.js): per-robot (solo) endgame points
// as a robot's running rate with a prior, instead of a fixed-K EMA from a
// shrunken start.
//   solo start  = soloInit x league-average per-robot solo points (initFrac/carry ignored for solo)
//   solo update = K_eff = max(kSolo, 1 / (n0 + matches with a recorded breakdown))
// i.e. a posterior mean with n0 prior pseudo-matches that turns into an EMA
// with rate kSolo once the robot has 1/kSolo - n0 matches.
// Monkeypatches Model in this process only.
//   node research/tune-endgame/proto.mjs [--params p.json] '[{"n0":3,"soloInit":1}, ...]'
import fs from "node:fs";
import { Model } from "../../site/js/model.js";
import { ctxs, EPA_SEASONS, epaRun, epaMetrics, bootstrapMaeDiff } from "../lib.mjs";

const P = { on: false, n0: 3, soloInit: 1, eb: 0, ebMin: 6, ebTeams: 50 };
// empirical-Bayes solo prior: regress established robots' current solo rate on their prior z
function ebPrior(m, z) {
  let n = 0, sz = 0, szz = 0, J = m.soloComps.length;
  const sy = new Array(J).fill(0), szy = new Array(J).fill(0);
  for (const t of m.teams.values()) {
    if (!(t.sn >= P.ebMin) || t.z == null) continue;
    n++; sz += t.z; szz += t.z * t.z;
    t.solo.forEach((v, j) => { sy[j] += v; szy[j] += t.z * v; });
  }
  if (n < P.ebTeams) return null;
  const mz = sz / n, vz = szz / n - mz * mz;
  return sy.map((y, j) => { const my = y / n, b = vz > 1e-9 ? (szy[j] / n - mz * my) / vz : 0; return Math.max(0, my + P.eb * b * (z - mz)); });
}
const origTeam = Model.prototype.team;
Model.prototype.team = function (num) {
  const had = this.teams.has(num);
  const t = origTeam.call(this, num);
  if (P.on && !had && !this.parent && t.sn == null) {
    t.sn = 0;
    t.z = this.priors.get(num) ?? (this.priors.size ? this.rookieZ : 0);
    const eb = P.eb ? ebPrior(this, t.z) : null;
    if (eb) t.solo = eb;
    else if (P.soloInit != null) t.solo = this.avg.solo.map((s) => (s * P.soloInit) / 2);
  }
  return t;
};
const origUpdate = Model.prototype.update;
Model.prototype.update = function (red, blue, actual, isElim, eventCode) {
  if (!P.on) return origUpdate.call(this, red, blue, actual, isElim, eventCode);
  const before = new Map();
  for (const n of [...red, ...blue]) before.set(n, [...this.team(n).solo]);
  const pred = origUpdate.call(this, red, blue, actual, isElim, eventCode);
  for (const [nums, side] of [[red, "red"], [blue, "blue"]]) {
    const s = actual[side].solo;
    nums.forEach((num, i) => {
      const t = this.team(num), old = before.get(num);
      let any = false;
      this.soloComps.forEach((_, j) => {
        const pts = s?.[j];
        if (pts && pts.length === nums.length) {
          const k = Math.max(this.p.kSolo, 1 / (P.n0 + (t.sn ?? 0) + 1));
          t.solo[j] = old[j] + k * (isElim ? this.p.elimWeight : 1) * (pts[i] - old[j]);
          any = true;
        }
      });
      if (any) t.sn = (t.sn ?? 0) + 1;
    });
  }
  return pred;
};

const argv = process.argv.slice(2);
const pi = argv.indexOf("--params");
const over = pi >= 0 ? JSON.parse(fs.readFileSync(argv[pi + 1], "utf8")) : {};
const variants = JSON.parse(argv.filter((_, i) => i !== pi && i !== pi + 1)[0] ?? "[{}]");
const cs = await ctxs(EPA_SEASONS);
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const runAll = async () => { const out = []; for (const ctx of cs) out.push(epaMetrics(ctx, await epaRun(ctx, over, ["endgame"]), "endgame")); return out; };
P.on = false;
const base = await runAll();
const show = (name, ms, ref) => {
  const mean = (k) => ms.map((m) => m[k]).reduce((a, b) => a + b, 0) / ms.length;
  console.log(`${name.padEnd(34)} ${ms.map((m) => f(m.nMae).padStart(6)).join(" ")}  mean ${f(mean("nMae"), 4)} bias ${f(mean("bias"), 2)} top ${f(mean("topBias"), 2)} corr ${f(mean("wCorr"))} rhoOPR ${f(mean("rhoOpr"))}`);
  if (ref) console.log("   CI(wMAE diff) " + ms.map((m, i) => { const c = bootstrapMaeDiff(ref[i].pairs, m.pairs, 500); return `${cs[i].season} ${f(c[0], 2)}..${f(c[1], 2)}`; }).join("  "));
};
console.log(`params ${JSON.stringify(over)}   seasons ${EPA_SEASONS.join(" ")}`);
show("patch off", base);
for (const v of variants) {
  Object.assign(P, { on: true, n0: 3, soloInit: 1, eb: 0, ebMin: 6, ebTeams: 50 }, v);
  show(`patch ${JSON.stringify(v)}`, await runAll(), base);
}
