// EPA (Expected Points Added) model for FTC, after Statbotics' FRC model.
//
// Each team carries an estimate of the points it adds to its alliance, split
// into auto / teleop / endgame, plus a per-team contribution to each bonus
// ranking point. An alliance's predicted score is the sum of its on-field
// teams' EPAs. After every match, each team moves toward the observed result.
//
// Refinements:
// - Per-robot ("solo") elements. Where the game manual scores something per
//   robot (parking, ascent level, drone, ...) and the results record which
//   robot did it, that robot gets exactly its own points instead of half the
//   alliance's.
// - Uncertainty-weighted updates (optional, `kalman`). Each team carries a
//   variance; a team we know little about absorbs more of an alliance's
//   surprise than a well-known partner, and uncertainty grows at each new event.
// - Level-aware noise. Scores are noisier in high-scoring matches, so the
//   win-probability spread and the Kalman match noise both grow with the
//   alliance's predicted level instead of being fixed in points.
// - Event-change reversion. At a new event, a team gives back part of the
//   rating change from its previous event (part of every jump is noise).
// - Score recalibration. Ratings lag improving teams and over-predict strong
//   alliances; a small online regression on matches already played corrects
//   the predicted scores (not the win probabilities).
//
// Shared by the build script (Node) and the browser (live events).

export const COMPONENTS = ["auto", "teleop", "endgame"];

// Tuned on 2022-2024 and checked on held-out 2025 (scripts/experiments.mjs).
// The volatility, shortfall-clip and win-spread settings came from a research
// round on Glicko/TrueSkill/Statbotics ideas: held-out 2025 Brier 0.1683 -> 0.1669.
// Level-aware noise, event-change reversion and score recalibration (2026-10-13)
// were checked by leave-one-season-out CV on 2019 and 2021-2025: Brier better in
// all six seasons (mean 0.1724 -> 0.1709), score MAE 22.3 -> 21.3.
export const DEFAULT_PARAMS = {
  kStart: 0.6, // K for a team's first matches
  kEnd: 0.35, // K once the team is established
  kRampStart: 6, // matches before K starts to fall
  kRampEnd: 18, // matches by which K reaches kEnd
  elimWeight: 0.6, // elims update less: alliances play differently
  initFrac: 0.3, // new teams start at this fraction of an average team
  carry: 1.3, // how strongly past seasons' z-score sets the starting rating
  winScale: 0.28, // logistic spread, as a fraction of an average alliance score
  emaAlpha: 0.003, // speed of the season-wide average score tracker
  kRp: 0.35, // K for bonus-RP contributions
  kSolo: 0.3, // K for per-robot elements (no splitting: it's the robot's own result)
  endIdleShare: 1, // weight on a robot that skipped the endgame, for teleop (tested: hurts, so off)
  deadShare: 1, // weight on a robot that neither moved in auto nor finished the endgame, for teleop
  idleShare: 0.2, // weight on a robot that didn't move in auto, for the alliance's auto error (user idea; +0.2 pts on held-out 2025)
  kalman: 1, // 1 = uncertainty-weighted updates instead of the K ramp
  v0: 0.5, // starting variance (relative units) for a new team
  vObs: 2, // match noise, same units (at an average-scoring alliance)
  obsHet: 0.75, // match noise x (alliance's predicted level / league average)^obsHet
  vMatch: 0.01, // variance added after every match (robots change)
  vEvent: 0.2, // extra variance at the start of each new event
  clipC: 1.25, // robust updates: clip each component's alliance error at clipC running SDs (0 = off)
  errAlpha: 0.005, // speed of the running error-variance tracker used by clipC / volK
  clipUp: 0, // 1 = clip both directions; 0 = clip only shortfalls (breakdowns): big jumps are real improvement
  volK: 0.1, // volatility: extra variance after a surprise, volK * max(0, |z| - volThr)^2
  volThr: 0.5, // surprise threshold for volK, in running SDs of the alliance error
  // Win-probability spread. Default: winScale x average alliance score.
  winSelf: 0.34, // >0: spread = winSelf x the observed SD of the score-difference error (self-calibrating)
  winFoul: 0.2, // weight of the league's foul-differential variance in the spread
  winVar: 0.02, // weight of the teams' rating variances in the spread (Glicko-style shrink to 50%)
  winAlpha: 0.01, // speed of the error / foul variance trackers
  winHet: 0.7, // spread x (match's predicted level / league average)^winHet
  mom: -0.2, // at a new event, add mom x the team's rating change over its previous event
  // League-drift growth (DARKO-style lag correction; candidate, off): at a team's
  // first match of a new event, add grow x the rise in the league-average component
  // (per robot) since its last match, so a team back from weeks idle isn't rated
  // stale against opponents who played last week. The recalibration intercept
  // can't fix this: it moves both alliances alike. Applied by Model.enter(), which
  // build.mjs simulate() calls before each match; event files' `state` already
  // includes it, so live.js replays need no call. 0 = off (bit-identical to before).
  grow: 0,
  growHead: 0, // growth x (1 + growHead x (1 - rating / average robot)), clamped to [0, 2]: weaker teams grow more
  // Score recalibration: predicted np' = np + A (b0 + b1 (np/A - 1) + b2 (opp np/A - 1)),
  // A = league-average alliance score, b refitted after every qual match from
  // exponentially weighted moments of earlier matches (ridge toward 0).
  cal: 1,
  calAlpha: 0.002, // weight of each new alliance result in the moments
  calRidge: 0.02, // ridge penalty
  zoneAlpha: 0.2, // speed of each robot's zone-habit tracker (zone RPs)
  // Alliance overlap (diminishing returns): two robots strong in the same phase
  // get in each other's way, so an alliance scores less than the sum of its
  // robots. Overlap = sum over phases of the weaker robot's points; it is a 4th
  // recalibration feature, 2 (overlap/A - 1/4), fitted online like the others
  // (its coefficient came out negative, around -0.1, in every season).
  // calPairWin: how much of that feature's correction also moves the win probability.
  // Leave-one-season-out (research/loso-new.mjs) gave mean Brier 0.17288 -> 0.17254
  // and MAE 21.56 -> 21.53: better in 5 of 6 seasons, never worse, 95% CI below
  // zero in 3 (2019, 2021, 2025). On by owner's call (2026-10-13).
  calPair: 1,
  calPairWin: 1,
};

// ---- Two tracks ----
// The parameters above are the PREDICTION track ("Pred. rating"): tuned only for
// match-prediction Brier, used for win probabilities, predicted scores and
// ranking forecasts. Some of what helps prediction (event-change reversion,
// shortfall clipping, slow K once established) distorts the strength number
// people read, so the team lists show a separate EPA track instead.
//
// The EPA (display) track runs the same update mechanics, one Model per
// component, each with its own knobs, so Auto, Teleop and Endgame can be tuned
// independently; Total = Auto + Teleop + Endgame (per-robot elements are folded
// into their component). Effective params for a component:
//   DEFAULT_PARAMS < EPA.shared < EPA[component].
// Scored by research/epa-eval.mjs (how well the pre-event EPA predicts the
// team's component OPR at that event), not by win-prob Brier.
//
// Every component starts as a copy of the prediction track; the overrides in
// DEFAULT_EPA_PARAMS below were tuned per component by leave-one-season-out CV
// on 2019 and 2021-2025 (research/tune-*/, scored by research/epa-eval.mjs).
// auto/teleop initFrac and teleop carry were re-checked by LOSO after rebuilding
// with these defaults (past seasons' EPAs feed the priors): every fold moved
// them to the values below.
const EPA_COMPONENT_START = {
  kalman: DEFAULT_PARAMS.kalman, // 1 = uncertainty-weighted (Kalman) updates; 0 = K ramp below
  kStart: DEFAULT_PARAMS.kStart, kEnd: DEFAULT_PARAMS.kEnd, kRampStart: DEFAULT_PARAMS.kRampStart, kRampEnd: DEFAULT_PARAMS.kRampEnd,
  v0: DEFAULT_PARAMS.v0, // starting variance: higher = the prior from past seasons fades faster
  vObs: DEFAULT_PARAMS.vObs, // match noise: higher = slower updates
  obsHet: DEFAULT_PARAMS.obsHet, // match noise grows with the alliance's level
  vMatch: DEFAULT_PARAMS.vMatch, // recency: variance added per match (old matches count less)
  vEvent: DEFAULT_PARAMS.vEvent, // recency: variance added at each new event
  volK: DEFAULT_PARAMS.volK, volThr: DEFAULT_PARAMS.volThr, // extra variance after a big surprise
  mom: DEFAULT_PARAMS.mom, // event-change reversion (<0 gives back part of the last event's change)
  clipC: DEFAULT_PARAMS.clipC, // clip alliance errors at clipC running SDs (0 = off)
  clipUp: DEFAULT_PARAMS.clipUp, // 0 = clip only shortfalls, 1 = both directions
  errAlpha: DEFAULT_PARAMS.errAlpha,
  elimWeight: DEFAULT_PARAMS.elimWeight, // how much elim matches count
  initFrac: DEFAULT_PARAMS.initFrac, // new teams start at this fraction of an average team
  carry: DEFAULT_PARAMS.carry, // how strongly past seasons set the starting rating
  kSolo: DEFAULT_PARAMS.kSolo, // K for per-robot elements in this component
  idleShare: DEFAULT_PARAMS.idleShare, endIdleShare: DEFAULT_PARAMS.endIdleShare, deadShare: DEFAULT_PARAMS.deadShare,
  emaAlpha: DEFAULT_PARAMS.emaAlpha,
  // Between-event growth (EPA track only): at a team's next event, add grow x the
  // rise in the league-average component (per robot) since the team's last match.
  // Off: in-sample it lowered MAE but overrated the top of the list (see README).
  grow: 0,
  growHead: 0, // growth x (1 + growHead x (1 - rating / average robot)), clamped to [0, 2]: weaker teams grow more
};
export const DEFAULT_EPA_PARAMS = {
  // Track-level settings (any component key above may also go here, for all three).
  shared: {
    offWeight: 0, // off-season events: 0 = excluded, w = each event's rating change counts w once it ends
    offTypes: ["OffSeason"], // event types treated as off-season
    offCutoff: null, // event code or ISO date: off-season events starting after it count 0 (e.g. MTI's code)
    offExclude: ["Chicago Robotics Invitational"], // event codes or name patterns (regex, any case) that always count 0
    offFlag: [0.5, 1.6], // also 0: events scoring outside this range x what the teams' EPAs predict (modified rules)
    priorWeights: [1, 0.15, 0.05], // weights of the last 1/2/3 seasons in the starting rating (was 1/0.3/0.15: older seasons predicted less than assumed)
    priorRookieZ: -0.25, // starting z for teams with no history (was -0.5: new teams were started too low)
    priorMinMatches: 3, // matches needed in a past season to count for priors (was 5: short seasons still say something)
  },
  auto: {
    ...EPA_COMPONENT_START,
    initFrac: 0.6, // was 0.3: teams started at 30% of average, so their first events were underrated
    idleShare: 1, // off: handing the moving partner nearly all of the auto surprise overrated it
    kSolo: 0.25, // was 0.3: per-robot auto points are noisy match to match
  },
  teleop: {
    ...EPA_COMPONENT_START,
    initFrac: 0.7, carry: 1, // was 0.3 / 1.3: start nearer average, lean less on last season's rank
    mom: -0.1, // was -0.2: give back less of the last event's change
    vMatch: 0.08, vEvent: 0, // was 0.01 / 0.2: steady recency within and across events instead of a jump at each event
    vObs: 3, obsHet: 0.25, // was 2 / 0.75: slower updates, noise grows less with scoring level
    clipC: 1, // was 1.25: clip breakdown matches harder
    volK: 0.03, // was 0.1: less extra uncertainty after a surprise
    elimWeight: 0.8, // was 0.6: elims say more about teleop than the prediction track assumes
    emaAlpha: 0.001, // was 0.003: slower league-average tracker
  },
  endgame: {
    ...EPA_COMPONENT_START,
    initFrac: 0.9, carry: 0.3, // was 0.3 / 1.3: endgame skill barely carries between games; start near average
    kSolo: 0.15, // was 0.3: parking/ascent per robot is noisy match to match
    vObs: 5, volK: 0.05, // was 2 / 0.1: slower, steadier updates
    mom: -0.3, // was -0.2: more of a one-event endgame jump is noise
    elimWeight: 1, // was 0.6: elims count fully
  },
};
const EPA_TRACK_KEYS = ["offWeight", "offTypes", "offCutoff", "offExclude", "offFlag"];
const EPA_SHARED_ONLY = ["priorWeights", "priorRookieZ", "priorMinMatches"];

// Merge an override ({ shared?, auto?, teleop?, endgame? }) onto the defaults.
// Unknown keys throw, so a typo in a tuning grid can't silently do nothing.
export function epaParams(over = {}) {
  const out = structuredClone(DEFAULT_EPA_PARAMS);
  for (const [sec, vals] of Object.entries(over ?? {})) {
    if (!(sec in out)) throw new Error(`EPA params: unknown section "${sec}" (use shared/auto/teleop/endgame)`);
    for (const [k, v] of Object.entries(vals ?? {})) {
      const ok = k in DEFAULT_PARAMS || k in EPA_COMPONENT_START || EPA_TRACK_KEYS.includes(k) || (sec === "shared" && EPA_SHARED_ONLY.includes(k));
      if (!ok) throw new Error(`EPA params: unknown key "${sec}.${k}"`);
      out[sec][k] = v;
    }
  }
  // a component key set in shared applies to all three components, unless the
  // override also sets it for that component (each component carries its own
  // copy of every key, which would otherwise shadow shared)
  for (const [k, v] of Object.entries(over?.shared ?? {})) {
    if (!(k in EPA_COMPONENT_START)) continue;
    for (const c of COMPONENTS) if (!(over?.[c] && k in over[c])) out[c][k] = v;
  }
  return out;
}

// One component's settings: { model: Model params, offWeight, offTypes, offCutoff, offExclude, offFlag }.
export function epaComponent(ep, comp) {
  const { priorWeights, priorRookieZ, priorMinMatches, ...sharedModel } = ep.shared;
  const off = {}, compModel = { ...ep[comp] };
  for (const k of EPA_TRACK_KEYS) { off[k] = compModel[k] ?? sharedModel[k]; delete compModel[k]; delete sharedModel[k]; }
  return { model: { ...DEFAULT_PARAMS, ...sharedModel, ...compModel }, ...off };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Small linear solve (Gaussian elimination with partial pivoting).
function solve(M, y) {
  const n = y.length, A = M.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (!(Math.abs(A[p][c]) > 1e-12)) return new Array(n).fill(0);
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = A[r][n]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r]; }
  return x;
}

export class Model {
  // baseline: average *alliance* values { auto, teleop, endgame, foul, rp: [3], solo: [] }.
  //   auto/teleop/endgame exclude solo points, which are listed per spec in `solo`.
  // soloComps: the component each solo spec belongs to, e.g. ["auto", "endgame"].
  // priors: Map(teamNumber -> z-score from earlier seasons), optional.
  // rookieZ: starting z for teams with no history, once priors exist at all.
  // movedSpec: index of the solo spec that records auto movement (-1 if none).
  // zoneRp: { rp, thr(eventType), leave, base, bonus } from the season config, or null.
  // eventType(code) -> the event's type, for zone-RP thresholds.
  constructor({ params = {}, baseline, priors = new Map(), cv = 0.5, soloComps = [], movedSpec = -1, parkedSpec = -1, rookieZ = 0, zoneRp = null, eventType = () => null } = {}) {
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.zoneRp = zoneRp && movedSpec >= 0 && parkedSpec >= 0 ? zoneRp : null;
    this.eventType = eventType;
    this.soloComps = soloComps;
    this.movedSpec = movedSpec;
    this.parkedSpec = parkedSpec;
    this.avg = {
      foul: 0, ...baseline,
      rp: [...baseline.rp],
      solo: soloComps.map((_, j) => baseline.solo?.[j] ?? 0),
    };
    // league zone habits (start values for new robots): P(leave), P(base none / partial / full)
    if (this.zoneRp) for (const [k, v] of Object.entries({ zLeave: 0.7, zB0: 0.25, zB1: 0.45, zB2: 0.3 })) this.avg[k] ??= v;
    // variance of the foul differential, and of the non-foul score-difference
    // error (starts where the default spread would be)
    this.avg.foulDiffVar ??= 2 * (baseline.foulVar ?? (baseline.foul ?? 0) ** 2);
    this.avg.errVar ??= (this.p.winScale * this.avgAllianceNp() / (this.p.winSelf || 1)) ** 2;
    this.priors = priors;
    this.rookieZ = rookieZ;
    this.cv = cv; // spread of team EPAs relative to the mean, for priors
    this.teams = new Map();
    // running variance of alliance errors per component and in total (for clipC / volK)
    const np0 = this.avgAllianceNp();
    // restored from an event file when replaying in the browser, so live matches the build
    // score-recalibration moments; restored from an event file like clipVar
    const nCal = this.p.calPair ? 4 : 3;
    this.cal = baseline.cal?.b?.length === nCal ? structuredClone(baseline.cal)
      : { b: new Array(nCal).fill(0), XX: Array.from({ length: nCal }, () => new Array(nCal).fill(0)), XY: new Array(nCal).fill(0) };
    this.errVar = baseline.clipVar ? { ...baseline.clipVar } : { auto: (0.6 * this.avg.auto) ** 2, teleop: (0.6 * this.avg.teleop) ** 2, endgame: (0.6 * this.avg.endgame) ** 2, np: (0.4 * np0) ** 2 };
  }

  avgAllianceNp() {
    return this.avg.auto + this.avg.teleop + this.avg.endgame + this.avg.solo.reduce((a, b) => a + b, 0);
  }

  team(num) {
    let t = this.teams.get(num);
    if (!t && this.parent) {
      // a fork copies a team from its parent the first time it's used
      t = structuredClone(this.parent.team(num));
      this.teams.set(num, t);
      this.base.set(num, structuredClone(t));
    }
    if (!t) {
      const z = this.priors.get(num) ?? (this.priors.size ? this.rookieZ : 0);
      const f = Math.max(0.15, this.p.initFrac * (1 + this.p.carry * z * this.cv)) / 2;
      t = {
        n: 0, v: this.p.v0, ev: null,
        auto: this.avg.auto * f,
        teleop: this.avg.teleop * f,
        endgame: this.avg.endgame * f,
        solo: this.avg.solo.map((s) => s * f),
        rp: this.avg.rp.map((r) => r / 2),
      };
      if (this.zoneRp) t.zone = [this.avg.zLeave, this.avg.zB0, this.avg.zB1, this.avg.zB2];
      this.teams.set(num, t);
    }
    return t;
  }

  // A copy that learns on its own without changing this model, e.g. for an
  // off-season event: its results shouldn't move official ratings.
  fork() {
    const f = Object.create(Model.prototype);
    Object.assign(f, this, {
      parent: this, teams: new Map(), base: new Map(),
      avg: structuredClone(this.avg), errVar: { ...this.errVar }, cal: structuredClone(this.cal),
    });
    return f;
  }

  // Fold w x each team's rating change on this fork back into the parent.
  merge(w) {
    if (!w) return;
    for (const [num, t] of this.teams) {
      const b = this.base.get(num), p = this.parent.team(num);
      for (const c of COMPONENTS) p[c] += w * (t[c] - b[c]);
      p.solo = p.solo.map((x, j) => x + w * (t.solo[j] - b.solo[j]));
      p.rp = p.rp.map((x, j) => x + w * (t.rp[j] - b.rp[j]));
    }
  }

  // Restore a team's state, e.g. its rating entering an event.
  setTeam(num, { auto, teleop, endgame, n, rp, solo, v, ev, evStart, zone }) {
    this.teams.set(num, {
      n, v: v ?? this.p.v0, ev: ev ?? null, evStart: evStart ?? null, auto, teleop, endgame,
      solo: this.soloComps.map((_, j) => solo?.[j] ?? 0), rp: [...rp],
      ...(this.zoneRp ? { zone: zone ? [...zone] : [this.avg.zLeave, this.avg.zB0, this.avg.zB1, this.avg.zB2] } : {}),
    });
  }

  k(n) {
    const { kStart, kEnd, kRampStart, kRampEnd } = this.p;
    if (n <= kRampStart) return kStart;
    if (n >= kRampEnd) return kEnd;
    return kStart + ((n - kRampStart) / (kRampEnd - kRampStart)) * (kEnd - kStart);
  }

  allianceExpected(nums) {
    const out = { auto: 0, teleop: 0, endgame: 0, np: 0, foul: 0, rp: [0, 0, 0], shared: { auto: 0, teleop: 0, endgame: 0 }, solo: this.soloComps.map(() => 0) };
    for (const n of nums) {
      const t = this.team(n);
      for (const c of COMPONENTS) { out[c] += t[c]; out.shared[c] += t[c]; }
      t.solo.forEach((s, j) => { out[this.soloComps[j]] += s; out.solo[j] += s; });
      t.rp.forEach((r, i) => (out.rp[i] += r));
    }
    // fouls the alliance gives away: per-team foul history didn't predict
    // better than the league average, so the average is used
    out.foul = this.avg.foul;
    out.np = out.auto + out.teleop + out.endgame;
    out.rp = out.rp.map((r) => clamp(r, 0.01, 0.99));
    // overlap: per phase, the weaker robot's points (per-robot elements included)
    out.overlap = 0;
    if (this.p.calPair && nums.length >= 2) {
      const per = nums.map((n) => this.teamComps(this.team(n)));
      for (const c of COMPONENTS) out.overlap += Math.min(...per.map((x) => x[c]));
    }
    return out;
  }

  // a team's points per phase, per-robot elements included
  teamComps(t) {
    const out = { auto: t.auto, teleop: t.teleop, endgame: t.endgame };
    t.solo.forEach((s, j) => (out[this.soloComps[j]] += s));
    return out;
  }

  // varSum: summed rating variance of every team on the field (relative units).
  // The logistic spread widens with the teams' uncertainty (Glicko/TrueSkill
  // style), so a match of barely-known teams sits closer to 50%, and with the
  // league's foul-differential noise, since fouls flip close matches.
  // level: (red np + blue np) / (2 x league average).
  winProb(redTotal, blueTotal, varSum = 0, level = 1) {
    const { winScale, winSelf, winFoul, winVar } = this.p;
    const avg = Math.max(10, this.avgAllianceNp());
    const het = this.levelScale(level, this.p.winHet) ** 2;
    let v = winSelf ? winSelf ** 2 * (this.avg.errVar * het + winFoul * this.avg.foulDiffVar) : (winScale * avg) ** 2 * het + winFoul * this.avg.foulDiffVar;
    v += winVar * varSum * avg ** 2;
    return 1 / (1 + Math.exp(-(redTotal - blueTotal) / Math.sqrt(v)));
  }

  levelScale(level, power) {
    return power ? clamp(level, 0.15, 6) ** power : 1;
  }

  // Variance a team will carry into this match (incl. the new-event bump).
  preVar(num, eventCode) {
    const t = this.team(num);
    return t.v + (this.p.kalman && eventCode && t.ev && t.ev !== eventCode ? this.p.vEvent : 0);
  }

  predict(red, blue, eventCode) {
    const r = this.allianceExpected(red);
    const b = this.allianceExpected(blue);
    const A = Math.max(10, this.avgAllianceNp());
    // win probability (and rating updates) use the ratings as they are
    r.rawNp = r.np; b.rawNp = b.np;
    const level = (r.np + b.np) / (2 * A);
    const varSum = this.p.kalman ? [...red, ...blue].reduce((s, n) => s + this.preVar(n, eventCode), 0) : 0;
    // the overlap part of the recalibration can also move the win probability
    const ov = (x) => (this.p.cal && this.p.calPair ? this.p.calPairWin * A * this.cal.b[3] * 2 * (x.overlap / A - 0.25) : 0);
    const pRed = this.winProb(r.np + ov(r) + b.foul, b.np + ov(b) + r.foul, varSum, level);
    if (this.zoneRp) {
      const thr = this.zoneRp.thr(this.eventType(eventCode));
      for (const [al, nums] of [[r, red], [b, blue]]) {
        if (nums.length === 2) al.rp[this.zoneRp.rp] = clamp(this.zoneChance(nums, thr), 0.01, 0.99);
      }
    }
    if (this.p.cal) {
      r.calX = [1, r.rawNp / A - 1, b.rawNp / A - 1];
      b.calX = [1, b.rawNp / A - 1, r.rawNp / A - 1];
      if (this.p.calPair) { r.calX.push(2 * (r.overlap / A - 0.25)); b.calX.push(2 * (b.overlap / A - 0.25)); }
      r.np += A * this.calDot(r.calX);
      b.np += A * this.calDot(b.calX);
    }
    // an alliance's total = its own points + the fouls the other side commits
    r.total = r.np + b.foul;
    b.total = b.np + r.foul;
    return { red: r, blue: b, varSum, level, pRed };
  }


  // P(two robots' zone points >= thr): enumerate leave x base outcomes.
  zoneChance(nums, thr) {
    const [a, b] = nums.map((n) => this.team(n).zone);
    const { leave, base, bonus } = this.zoneRp;
    let p = 0;
    for (let l1 = 0; l1 < 2; l1++) for (let l2 = 0; l2 < 2; l2++) for (let b1 = 0; b1 < 3; b1++) for (let b2 = 0; b2 < 3; b2++) {
      const pts = leave * (l1 + l2) + base[b1] + base[b2] + (b1 === 2 && b2 === 2 ? bonus : 0);
      if (pts >= thr) p += (l1 ? a[0] : 1 - a[0]) * (l2 ? b[0] : 1 - b[0]) * a[1 + b1] * b[1 + b2];
    }
    return p;
  }

  // learn each robot's zone habits from its per-robot leave / base points
  zoneStep(nums, act) {
    const lv = act.solo?.[this.movedSpec], bs = act.solo?.[this.parkedSpec];
    if (!lv || !bs || lv.length !== nums.length || bs.length !== nums.length) return;
    const full = this.zoneRp.base[2];
    nums.forEach((num, i) => {
      const z = this.team(num).zone;
      const k = bs[i] >= 0.75 * full ? 2 : bs[i] > 0 ? 1 : 0;
      const y = [lv[i] > 0 ? 1 : 0, k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
      for (let j = 0; j < 4; j++) {
        z[j] += this.p.zoneAlpha * (y[j] - z[j]);
        const key = ["zLeave", "zB0", "zB1", "zB2"][j];
        this.avg[key] += this.p.emaAlpha * (y[j] - this.avg[key]);
      }
    });
  }

  calDot(x) {
    return x.reduce((s, xi, i) => s + xi * this.cal.b[i], 0);
  }

  // add one alliance result (residual y, league-average units) and refit
  calStep(x, y) {
    const { XX, XY } = this.cal, a = this.p.calAlpha;
    for (let i = 0; i < x.length; i++) {
      XY[i] += a * (x[i] * y - XY[i]);
      for (let j = 0; j < x.length; j++) XX[i][j] += a * (x[i] * x[j] - XX[i][j]);
    }
    this.cal.b = solve(XX.map((row, i) => row.map((v, j) => v + (i === j ? this.p.calRidge : 0))), XY);
  }

  // Between-event growth (p.grow): call before a match is predicted (both tracks).
  // At a team's first match of a new event, its components rise by grow x the
  // league-average rise (per robot) since its last match.
  enter(nums, eventCode) {
    if (!this.p.grow) return;
    for (const n of nums) {
      const t = this.team(n); // on a fork, this snapshots `base` (before the growth)
      if (t.gEv === eventCode) continue;
      if (!t.gAvg) { t.gEv = eventCode; continue; }
      // headroom factor from the team's whole rating vs an average robot, in [0, 2]
      const np = this.epa(n).np, avgRobot = Math.max(1, this.avgAllianceNp() / 2);
      const f = clamp(1 + (this.p.growHead ?? 0) * (1 - np / avgRobot), 0, 2);
      const g = Object.fromEntries(COMPONENTS.map((c) => [c, (f * this.p.grow * (this.avg[c] - t.gAvg[c])) / 2]));
      for (const c of COMPONENTS) t[c] += g[c];
      // event-change reversion (mom, in shares()) reverts part of t - evStart:
      // shift evStart too, so it reverts only the last event's own change.
      // (A new object: epa() snapshots share the old one.)
      if (t.evStart) t.evStart = Object.fromEntries(COMPONENTS.map((c) => [c, t.evStart[c] + g[c]]));
      // fork: merge(w) carries w x (t - base) to the parent, whose stale gAvg
      // grows it again at its next event; shift base so growth isn't counted twice
      if (this.parent) { const b = this.base.get(n); for (const c of COMPONENTS) b[c] += g[c]; }
      t.gEv = eventCode;
    }
  }

  // How much of an alliance's error each team takes.
  // level: the alliance's predicted score / league average (match noise grows with it).
  shares(nums, eventCode, level = 1) {
    const ts = nums.map((n) => this.team(n));
    if (!this.p.kalman) return ts.map((t) => this.k(t.n) / nums.length);
    for (const t of ts) {
      if (eventCode && t.ev !== eventCode) {
        if (t.ev) t.v += this.p.vEvent;
        if (this.p.mom) {
          if (t.ev && t.evStart) for (const c of COMPONENTS) t[c] += this.p.mom * (t[c] - t.evStart[c]);
          t.evStart = { auto: t.auto, teleop: t.teleop, endgame: t.endgame };
        }
        t.ev = eventCode;
      }
    }
    const sum = ts.reduce((s, t) => s + t.v, 0) + this.p.vObs * this.levelScale(level, this.p.obsHet);
    return ts.map((t) => t.v / sum);
  }

  // actual: { red: {auto, teleop, endgame, np, total, rp, solo?}, blue: {...} }
  //   solo[j] = [points of robot 1, points of robot 2], in the same order as the
  //   team list; omit (or null) when the per-robot breakdown is unknown.
  update(red, blue, actual, isElim, eventCode) {
    const pred = this.predict(red, blue, eventCode);
    const w = isElim ? this.p.elimWeight : 1;
    for (const [nums, side] of [[red, "red"], [blue, "blue"]]) {
      const exp = pred[side], act = actual[side];
      const other = side === "red" ? "blue" : "red";
      const foulsMade = actual[other].total - actual[other].np;
      const share = this.shares(nums, eventCode, exp.rawNp / Math.max(10, this.avgAllianceNp()));

      // shared part of each component = component minus its per-robot elements
      const actShared = { auto: act.auto, teleop: act.teleop, endgame: act.endgame };
      this.soloComps.forEach((c, j) => {
        const pts = act.solo?.[j];
        actShared[c] -= pts ? pts.reduce((a, b) => a + b, 0) : exp.solo[j];
      });

      // Per-robot signals of who did the work: a robot that didn't move in auto
      // almost never scores there, and one that skipped the endgame usually broke
      // down. When exactly one robot shows the sign, its partner gets most of the
      // alliance's surprise for that phase.
      const idleIn = (spec) => {
        const pts = spec >= 0 ? act.solo?.[spec] : null;
        return pts && pts.length === nums.length ? pts.map((p) => p <= 0) : null;
      };
      const reweight = (idle, weight) => {
        if (!idle || weight === 1) return share;
        if (!idle.some((x) => x) || idle.every((x) => x)) return share;
        const raw = share.map((s, i) => s * (idle[i] ? weight : 1));
        const scale = share.reduce((a, b) => a + b, 0) / raw.reduce((a, b) => a + b, 0);
        return raw.map((s) => s * scale);
      };
      const noMove = idleIn(this.movedSpec), noEnd = idleIn(this.parkedSpec);
      const dead = noMove && noEnd ? noMove.map((x, i) => x && noEnd[i]) : null;
      const autoShare = reweight(noMove, this.p.idleShare);
      let teleShare = reweight(noEnd, this.p.endIdleShare);
      if (this.p.deadShare !== 1) teleShare = reweight(dead, this.p.deadShare);

      // Robust errors: one breakdown or freak match moves ratings by at most clipC SDs' worth.
      const err = {}, ea = this.p.errAlpha;
      for (const c of COMPONENTS) {
        const e = actShared[c] - exp.shared[c];
        const lim = this.p.clipC * Math.sqrt(this.errVar[c]);
        err[c] = this.p.clipC > 0 ? clamp(e, -lim, this.p.clipUp ? lim : Infinity) : e;
        if (!isElim) this.errVar[c] += ea * (e * e - this.errVar[c]);
      }
      // Volatility: a big surprise on the whole alliance score adds process noise.
      const eNp = act.np - exp.rawNp;
      const zNp = eNp / Math.sqrt(this.errVar.np);
      if (!isElim) this.errVar.np += ea * (eNp * eNp - this.errVar.np);
      const volAdd = this.p.volK ? this.p.volK * Math.max(0, Math.abs(zNp) - this.p.volThr) ** 2 : 0;

      nums.forEach((num, i) => {
        const t = this.team(num);
        const k = share[i] * w;
        for (const c of COMPONENTS) {
          const kc = c === "auto" ? autoShare[i] * w : c === "teleop" ? teleShare[i] * w : k;
          t[c] += kc * err[c];
        }
        this.soloComps.forEach((_, j) => {
          const pts = act.solo?.[j];
          if (pts && pts.length === nums.length) t.solo[j] += this.p.kSolo * w * (pts[i] - t.solo[j]);
        });
        if (!isElim) {
          const kr = this.p.kRp / nums.length;
          t.rp = t.rp.map((r, j) => clamp(r + kr * ((act.rp?.[j] ? 1 : 0) - exp.rp[j]), -0.2, 1));
        }
        if (this.p.kalman) t.v = t.v * (1 - share[i] * w) + this.p.vMatch + volAdd * w;
        t.n++;
      });

      // season-wide averages drift as teams improve
      const a = this.p.emaAlpha;
      for (const c of COMPONENTS) this.avg[c] += a * (actShared[c] - this.avg[c]);
      this.soloComps.forEach((_, j) => {
        const pts = act.solo?.[j];
        this.avg.solo[j] += a * ((pts ? pts.reduce((x, y) => x + y, 0) : exp.solo[j]) - this.avg.solo[j]);
      });
      this.avg.foul += a * (foulsMade - this.avg.foul);
      if (!isElim) this.avg.rp = this.avg.rp.map((r, j) => r + a * ((act.rp?.[j] ? 1 : 0) - r));
    }
    if (this.p.grow) for (const n of [...red, ...blue]) this.team(n).gAvg = { auto: this.avg.auto, teleop: this.avg.teleop, endgame: this.avg.endgame };
    if (this.zoneRp && !isElim) { this.zoneStep(red, actual.red); this.zoneStep(blue, actual.blue); }
    if (this.p.cal && !isElim) {
      const A = Math.max(10, this.avgAllianceNp());
      for (const side of ["red", "blue"]) this.calStep(pred[side].calX, (actual[side].np - pred[side].rawNp) / A);
    }
    // how far off the predicted score difference was (fouls tracked apart),
    // in level-normalised units
    const wa = this.p.winAlpha;
    const foulDiff = (actual.red.total - actual.red.np) - (actual.blue.total - actual.blue.np);
    const npErr = (actual.red.np - actual.blue.np) - (pred.red.rawNp + pred.blue.foul - pred.blue.rawNp - pred.red.foul);
    this.avg.errVar += wa * ((npErr / this.levelScale(pred.level, this.p.winHet)) ** 2 - this.avg.errVar);
    this.avg.foulDiffVar += wa * (foulDiff ** 2 - this.avg.foulDiffVar);
    return pred;
  }

  epa(num) {
    const t = this.team(num);
    const e = { n: t.n, v: t.v, ev: t.ev, evStart: t.evStart ?? null, ...(t.zone ? { zone: [...t.zone] } : {}), auto: t.auto, teleop: t.teleop, endgame: t.endgame, rp: [...t.rp], solo: [...t.solo] };
    const shared = { auto: t.auto, teleop: t.teleop, endgame: t.endgame };
    t.solo.forEach((s, j) => (e[this.soloComps[j]] += s));
    e.np = e.auto + e.teleop + e.endgame;
    e.shared = shared;
    return e;
  }
}

const STATION = { One: 1, Two: 2, Three: 3 };

// All of an alliance's teams in station order (station 1 first).
export function allianceTeams(match, alliance) {
  return match.teams
    .filter((t) => t.alliance === alliance)
    .sort((a, b) => (STATION[a.station] ?? 9) - (STATION[b.station] ?? 9))
    .map((t) => t.teamNumber);
}

// Which teams actually played for an alliance in a match, in station order
// (station 1 first), which is the order per-robot score fields use.
export function onField(match, alliance) {
  return match.teams
    .filter((t) => t.alliance === alliance && t.onField && !t.noShow)
    .sort((a, b) => (STATION[a.station] ?? 9) - (STATION[b.station] ?? 9))
    .map((t) => t.teamNumber);
}

export const isElim = (match) => match.tournamentLevel !== "Quals";
