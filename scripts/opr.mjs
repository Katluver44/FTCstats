// OPR baseline: what you'd predict using OPR, the stat FTCScout shows.
//
// Before each match, every team's OPR is solved from the quals played so far
// at that event, pulled toward its OPR from earlier events (ridge prior) so
// it isn't wild after one or two matches. This is a fair, strong version of
// "use OPR to predict" and gives EPA something honest to beat.

const RIDGE = 1.5;

// Solve (AᵀA + λI) x = Aᵀb + λ·prior with Cholesky. n is small (one event).
function solve(teams, rows, prior) {
  const n = teams.length;
  const idx = new Map(teams.map((t, i) => [t, i]));
  const M = Array.from({ length: n }, () => new Float64Array(n));
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) { M[i][i] = RIDGE; v[i] = RIDGE * prior[i]; }
  for (const { nums, score } of rows) {
    const ix = nums.map((t) => idx.get(t));
    for (const a of ix) {
      v[a] += score;
      for (const b of ix) M[a][b] += 1;
    }
  }
  // Cholesky decomposition, in place in L
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = M[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-9)) : sum / L[j][j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = v[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return new Map(teams.map((t, i) => [t, x[i]]));
}

// matches: time-sorted output of playedMatches(). Returns pre-match pRed per match.
export function oprPredictions(matches, { winScale = 0.28, baselineTeam } = {}) {
  const lastOpr = new Map(); // team -> OPR at the end of its latest finished event
  const byEvent = new Map();
  for (const x of matches) {
    if (!byEvent.has(x.ev.code)) byEvent.set(x.ev.code, []);
    byEvent.get(x.ev.code).push(x);
  }
  // events finish in order of their last match
  const evDone = new Map([...byEvent].map(([code, ms]) => [code, ms[ms.length - 1].time]));
  const pending = [...evDone].sort((a, b) => a[1] - b[1]);
  const state = new Map(); // code -> { teams, rows, opr }
  let avgAlliance = baselineTeam * 2;
  const out = new Map();

  for (const x of matches) {
    // fold in every event that finished before this match started
    while (pending.length && pending[0][1] < x.time) {
      const [code] = pending.shift();
      const st = state.get(code);
      if (!st) continue;
      if (st.dirty) st.opr = solve(st.teams, st.rows, st.teams.map((t) => lastOpr.get(t) ?? avgAlliance / 2));
      for (const [t, v] of st.opr) lastOpr.set(t, v);
    }
    let st = state.get(x.ev.code);
    if (!st) {
      const teams = [...new Set(byEvent.get(x.ev.code).flatMap((m) => [...m.red, ...m.blue]))];
      st = { teams, rows: [], opr: null, dirty: true };
      state.set(x.ev.code, st);
    }
    if (st.dirty) {
      const prior = st.teams.map((t) => lastOpr.get(t) ?? avgAlliance / 2);
      st.opr = solve(st.teams, st.rows, prior);
      st.dirty = false;
    }
    const sum = (nums) => nums.reduce((s, t) => s + (st.opr.get(t) ?? avgAlliance / 2), 0);
    const r = sum(x.red), b = sum(x.blue);
    const pRed = 1 / (1 + Math.exp(-(r - b) / (winScale * Math.max(10, avgAlliance))));
    out.set(x, { pRed, red: r, blue: b });

    if (!x.elim) {
      st.rows.push({ nums: x.red, score: x.actual.red.np }, { nums: x.blue, score: x.actual.blue.np });
      st.dirty = true;
    }
    avgAlliance += 0.003 * ((x.actual.red.np + x.actual.blue.np) / 2 - avgAlliance);
  }
  return out;
}
