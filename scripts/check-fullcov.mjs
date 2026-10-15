// Sanity checks for the fullCov option (event-local joint Kalman update), on
// synthetic matches, so no data is needed:
//   (e) default params: bit-identical to site/js/model.js at REF (default main)
//   (a) fullCov 1 with fresh partners every match: identical to fullCov 0
//   (b) no process noise: the filter equals batch ridge / MMSE OPR (means and covariance)
//   (c) P stays symmetric and positive definite, and t.v == P_jj
//   (d) A+B beat the prediction, then B+C fall short: A rises (explaining away)
//   plus row lifecycle (a team leaving / returning, endEvent, fork)
//   REF=main node scripts/check-fullcov.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Model as New } from "../site/js/model.js";

const REF = process.env.REF ?? "main";
const oldFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fullcov-")), "model.js");
fs.writeFileSync(oldFile, execSync(`git show ${REF}:site/js/model.js`));
const { Model: Old } = await import(oldFile);

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const baseline = { auto: 20, teleop: 60, endgame: 20, foul: 5, rp: [0.3, 0.3, 0.3], solo: [6, 8] };
const common = { baseline, soloComps: ["auto", "endgame"], movedSpec: 0, parkedSpec: 1, cv: 0.5, rookieZ: -0.3 };

// Synthetic season: events with teams reappearing, quals + elims, per-robot solo points.
function makeSeason({ fresh = false, nEvents = 6, perEvent = 12, quals = 18 } = {}) {
  seed = 777;
  const truth = new Map();
  const tr = (n) => { if (!truth.has(n)) truth.set(n, { a: 10 + 6 * gauss(), t: 30 + 15 * gauss(), e: 10 + 5 * gauss() }); return truth.get(n); };
  const ms = [];
  let nextTeam = 1;
  for (let e = 0; e < nEvents; e++) {
    const code = `EV${e}`;
    const pool = fresh ? null : Array.from({ length: perEvent }, () => 1 + Math.floor(rand() * 40));
    for (let q = 0; q < quals; q++) {
      let four;
      if (fresh) four = [nextTeam++, nextTeam++, nextTeam++, nextTeam++];
      else { const s = new Set(); while (s.size < 4) s.add(pool[Math.floor(rand() * pool.length)]); four = [...s]; }
      const elim = q >= quals - 3;
      const side = (nums) => {
        const ts = nums.map(tr);
        const moved = ts.map((t) => (rand() < 0.85 ? 3 : 0));
        const parked = ts.map((t) => (rand() < 0.8 ? 4 : 0));
        const auto = Math.max(0, ts.reduce((s, t) => s + t.a, 0) + 6 * gauss()) + moved[0] + moved[1];
        const teleop = Math.max(0, ts.reduce((s, t) => s + t.t, 0) + 15 * gauss());
        const endgame = Math.max(0, ts.reduce((s, t) => s + t.e, 0) + 5 * gauss()) + parked[0] + parked[1];
        const np = auto + teleop + endgame;
        return { auto, teleop, endgame, np, rp: [rand() < 0.3, rand() < 0.3, rand() < 0.3], solo: [moved, parked] };
      };
      const red = four.slice(0, 2), blue = four.slice(2);
      const r = side(red), b = side(blue);
      const rf = Math.round(rand() * 10), bf = Math.round(rand() * 10);
      r.total = r.np + bf; b.total = b.np + rf;
      ms.push({ red, blue, actual: { red: r, blue: b }, elim, code });
    }
  }
  return ms;
}

function run(M, ms, params, { endEvents = true } = {}) {
  const m = new M({ ...common, params, priors: new Map([[1, 0.5], [2, -0.4], [7, 1.2]]) });
  const out = [];
  const last = new Map(ms.map((x, i) => [x.code, i]));
  ms.forEach((x, i) => {
    const p = m.update(x.red, x.blue, x.actual, x.elim, x.code);
    out.push([p.pRed, p.red.np, p.blue.np, p.varSum]);
    if (endEvents && last.get(x.code) === i && m.endEvent) m.endEvent(x.code);
  });
  const teams = [...m.teams.keys()].sort((a, b) => a - b).map((n) => [n, m.epa(n)]);
  return { out, teams, m };
}
const maxDiff = (a, b) => {
  let d = 0;
  const walk = (x, y) => {
    if (typeof x === "number") { d = Math.max(d, Math.abs(x - y) / Math.max(1, Math.abs(x))); return; }
    if (x && typeof x === "object") for (const k of Object.keys(x)) walk(x[k], y?.[k]);
  };
  walk(a, b);
  return d;
};
let ok = true;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); ok &&= cond; };

// (e) default params: bit-identical to REF
const season = makeSeason();
for (const params of [{}, { kalman: 0 }, { jointWinVar: 1 }, { idleShare: 0.5, deadShare: 0.3, endIdleShare: 0.7 }]) {
  const a = run(Old, season, params, { endEvents: false }), b = run(New, season, params);
  check(`(e) bit-identical to ${REF} with ${JSON.stringify(params)}`, JSON.stringify([a.out, a.teams]) === JSON.stringify([b.out, b.teams]));
}

// (a) fullCov on fresh teams = default update
const freshS = makeSeason({ fresh: true });
for (const params of [{}, { idleShare: 0.5, deadShare: 0.3 }]) {
  const a = run(New, freshS, params), b = run(New, freshS, { ...params, fullCov: 1 });
  const same = JSON.stringify([a.out, a.teams]) === JSON.stringify([b.out, b.teams]);
  check(`(a) fresh teams, fullCov 1 == fullCov 0 ${JSON.stringify(params)}`, same, same ? "(bit-identical)" : `max rel diff ${maxDiff([a.out, a.teams], [b.out, b.teams])}`);
}
// and the default path still differs from fullCov when partners repeat
{
  const a = run(New, season, {}), b = run(New, season, { fullCov: 1 });
  console.log(`      repeated partners: max rel diff fullCov vs default ${maxDiff([a.out, a.teams], [b.out, b.teams]).toFixed(4)}`);
}

// (b) batch equivalence with closed-form ridge / MMSE OPR
{
  seed = 99;
  const P = { vMatch: 0, volK: 0, clipC: 0, mom: 0, idleShare: 1, elimWeight: 1, obsHet: 0, fullCov: 1, vObs: 2 };
  const bl = { auto: 20, teleop: 60, endgame: 20, foul: 5, rp: [0.3, 0.3, 0.3], solo: [] };
  const m = new New({ baseline: bl, params: P, priors: new Map([[1, 1], [2, -1], [3, 0.5]]), cv: 0.5 });
  const teams = [1, 2, 3, 4, 5, 6];
  const x0 = teams.map((n) => ({ ...m.team(n) }));
  const obs = []; // { comp, h: row, y }
  for (let k = 0; k < 10; k++) {
    const perm = [...teams].sort(() => rand() - 0.5);
    const red = perm.slice(0, 2), blue = perm.slice(2, 4);
    const mk = () => ({ auto: 25 + 10 * gauss(), teleop: 60 + 20 * gauss(), endgame: 20 + 8 * gauss() });
    const r = mk(), b = mk();
    for (const s of [r, b]) { s.np = s.auto + s.teleop + s.endgame; s.total = s.np; s.rp = [0, 0, 0]; }
    m.update(red, blue, { red: r, blue: b }, false, "EVB");
    obs.push({ red, y: r }, { red: blue, y: b });
  }
  // the filter's R is vObs (obsHet 0) in relative units; ratings are in points, so
  // gains only depend on ratios: posterior mean = x0 + (P0^-1 + H'H/R)^-1 H'(y - Hx0)/R
  const v0 = P.v0 ?? 0.5, R = P.vObs, n = teams.length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 / v0 : 0)));
  for (const o of obs) for (const a of o.red) for (const b of o.red) A[a - 1][b - 1] += 1 / R;
  let worst = 0;
  for (const c of ["auto", "teleop", "endgame"]) {
    const rhs = new Array(n).fill(0);
    for (const o of obs) {
      const res = o.y[c] - o.red.reduce((s, t) => s + x0[t - 1][c], 0);
      for (const t of o.red) rhs[t - 1] += res / R;
    }
    const d = solveSym(A, rhs);
    teams.forEach((t, i) => { worst = Math.max(worst, Math.abs(m.team(t)[c] - (x0[i][c] + d[i]))); });
  }
  // posterior variances too
  const Pinv = invert(A);
  let worstV = 0;
  teams.forEach((t, i) => (worstV = Math.max(worstV, Math.abs(m.team(t).v - Pinv[i][i]))));
  const M = m.evCov.get("EVB");
  M.teams.forEach((ti, i) => M.teams.forEach((tj, j) => (worstV = Math.max(worstV, Math.abs(M.P[i][j] - Pinv[ti - 1][tj - 1])))));
  check("(b) sequential joint filter == batch ridge (MMSE OPR) means", worst < 1e-9, `max |diff| ${worst.toExponential(2)} pts`);
  check("(b) ... and full posterior covariance", worstV < 1e-12, `max |diff| ${worstV.toExponential(2)}`);
}

// (c) symmetric, positive diagonal, Cholesky succeeds (default params + fullCov, repeated partners)
{
  const m = new New({ ...common, params: { fullCov: 1 }, priors: new Map() });
  let worstAsym = 0, minDiag = Infinity, cholOk = true, maxN = 0;
  for (const x of season) {
    m.update(x.red, x.blue, x.actual, x.elim, x.code);
    const M = m.evCov.get(x.code);
    maxN = Math.max(maxN, M.teams.length);
    for (let i = 0; i < M.P.length; i++) {
      minDiag = Math.min(minDiag, M.P[i][i]);
      if (M.P[i][i] !== m.team(M.teams[i]).v) cholOk = false;
      for (let j = 0; j < M.P.length; j++) worstAsym = Math.max(worstAsym, Math.abs(M.P[i][j] - M.P[j][i]));
    }
    if (!cholesky(M.P)) cholOk = false;
  }
  check("(c) P symmetric, diag > 0, t.v == P_jj, Cholesky OK after every match", worstAsym === 0 && minDiag > 0 && cholOk, `(asym ${worstAsym}, min diag ${minDiag.toFixed(4)}, max n ${maxN})`);
}

// (d) A+B overperform, then B+C underperform: A drops with fullCov only
for (const fullCov of [0, 1]) {
  const m = new New({ baseline: { ...baseline, solo: [] }, params: { fullCov }, priors: new Map() });
  const [A, B, C] = [101, 102, 103];
  const avgSide = (k) => { const s = { auto: 20 * k, teleop: 60 * k, endgame: 20 * k }; s.np = 100 * k; s.total = s.np; s.rp = [0, 0, 0]; return s; };
  // warm up the ratings a bit so expectation is about one team's share
  m.update([A, B], [201, 202], { red: avgSide(1.6), blue: avgSide(0.5) }, false, "EVD");
  const a1 = m.epa(A).np;
  m.update([B, C], [203, 204], { red: avgSide(0.2), blue: avgSide(0.5) }, false, "EVD");
  const a2 = m.epa(A).np;
  console.log(`      fullCov ${fullCov}: A after m1 ${a1.toFixed(3)}, after m2 ${a2.toFixed(3)} (change ${(a2 - a1).toFixed(3)})`);
  // explaining away: B+C falling short says B is weak, so more of the A+B surplus was A's
  if (fullCov) check("(d) A RISES after B+C underperform (fullCov 1; partners are anti-correlated)", a2 > a1);
  else check("(d) A unchanged (fullCov 0)", a2 === a1);
}

// lifecycle: a team that leaves and returns gets a fresh row; endEvent frees memory
{
  const m = new New({ ...common, params: { fullCov: 1 }, priors: new Map() });
  const s = { auto: 30, teleop: 70, endgame: 25, np: 125, total: 125, rp: [0, 0, 0] };
  m.update([1, 2], [3, 4], { red: s, blue: s }, false, "X");
  m.update([1, 5], [6, 7], { red: s, blue: s }, false, "Y"); // team 1 leaves X
  m.update([2, 3], [4, 8], { red: s, blue: s }, false, "X");
  const X = m.evCov.get("X");
  check("lifecycle: row of a team that left is dropped", !X.at.has(1) && X.teams.length === 4, JSON.stringify(X.teams));
  m.update([1, 2], [3, 4], { red: s, blue: s }, false, "X"); // back: fresh row with no cross terms
  const i1 = X.at.get(1);
  check("lifecycle: returning team gets a fresh uncorrelated row", X.seq[i1] === m.team(1).evSeq && m.team(1).evSeq === 3);
  m.endEvent("X"); m.endEvent("Y");
  check("lifecycle: endEvent frees matrices", m.evCov.size === 0);
  const f = m.fork();
  check("fork has its own evCov", f.evCov !== m.evCov && f.evCov.size === 0);
}

// jointWinVar changes the spread only once teams have shared matches
{
  const a = run(New, season, { fullCov: 1 }), b = run(New, season, { fullCov: 1, jointWinVar: 1 });
  const diff = a.out.filter((r, i) => r[0] !== b.out[i][0]).length;
  console.log(`      jointWinVar: ${diff}/${a.out.length} win probs differ`);
}

console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exitCode = ok ? 0 : 1;

function solveSym(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function invert(A) {
  const n = A.length;
  return Array.from({ length: n }, (_, j) => solveSym(A, A.map((_, i) => (i === j ? 1 : 0)))).map((col, j, cols) => cols.map((c) => c[j]));
}
function cholesky(P) {
  const n = P.length, L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = P[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (!(s > 0)) return false; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  return true;
}
