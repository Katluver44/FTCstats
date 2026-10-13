// EPA (Expected Points Added) model for FTC, after Statbotics' FRC model.
//
// Each team carries an estimate of the points it adds to its alliance, split
// into auto / teleop / endgame, plus a per-team contribution to each bonus
// ranking point. An alliance's predicted score is the sum of its on-field
// teams' EPAs. After every match, each team moves toward the observed result.
//
// Two refinements:
// - Per-robot ("solo") elements. Where the game manual scores something per
//   robot (parking, ascent level, drone, ...) and the results record which
//   robot did it, that robot gets exactly its own points instead of half the
//   alliance's.
// - Uncertainty-weighted updates (optional, `kalman`). Each team carries a
//   variance; a team we know little about absorbs more of an alliance's
//   surprise than a well-known partner, and uncertainty grows at each new event.
//
// Shared by the build script (Node) and the browser (live events).

export const COMPONENTS = ["auto", "teleop", "endgame"];

// Tuned on 2022-2024 and checked on held-out 2025 (scripts/experiments.mjs).
// The volatility, shortfall-clip and win-spread settings came from a research
// round on Glicko/TrueSkill/Statbotics ideas: held-out 2025 Brier 0.1683 -> 0.1669.
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
  v0: 0.7, // starting variance (relative units) for a new team
  vObs: 1.5, // match noise, same units
  vMatch: 0.01, // variance added after every match (robots change)
  vEvent: 0.2, // extra variance at the start of each new event
  clipC: 1.25, // robust updates: clip each component's alliance error at clipC running SDs (0 = off)
  errAlpha: 0.005, // speed of the running error-variance tracker used by clipC / volK
  clipUp: 0, // 1 = clip both directions; 0 = clip only shortfalls (breakdowns): big jumps are real improvement
  volK: 0.1, // volatility: extra variance after a surprise, volK * max(0, |z| - volThr)^2
  volThr: 0.5, // surprise threshold for volK, in running SDs of the alliance error
  // Win-probability spread. Default: winScale x average alliance score.
  winSelf: 0.4, // >0: spread = winSelf x the observed SD of the score-difference error (self-calibrating)
  winFoul: 0.4, // weight of the league's foul-differential variance in the spread
  winVar: 0.02, // weight of the teams' rating variances in the spread (Glicko-style shrink to 50%)
  winAlpha: 0.01, // speed of the error / foul variance trackers
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export class Model {
  // baseline: average *alliance* values { auto, teleop, endgame, foul, rp: [3], solo: [] }.
  //   auto/teleop/endgame exclude solo points, which are listed per spec in `solo`.
  // soloComps: the component each solo spec belongs to, e.g. ["auto", "endgame"].
  // priors: Map(teamNumber -> z-score from earlier seasons), optional.
  // rookieZ: starting z for teams with no history, once priors exist at all.
  // movedSpec: index of the solo spec that records auto movement (-1 if none).
  constructor({ params = {}, baseline, priors = new Map(), cv = 0.5, soloComps = [], movedSpec = -1, parkedSpec = -1, rookieZ = 0 } = {}) {
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.soloComps = soloComps;
    this.movedSpec = movedSpec;
    this.parkedSpec = parkedSpec;
    this.avg = {
      foul: 0, ...baseline,
      rp: [...baseline.rp],
      solo: soloComps.map((_, j) => baseline.solo?.[j] ?? 0),
    };
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
    this.errVar = baseline.clipVar ? { ...baseline.clipVar } : { auto: (0.6 * this.avg.auto) ** 2, teleop: (0.6 * this.avg.teleop) ** 2, endgame: (0.6 * this.avg.endgame) ** 2, np: (0.4 * np0) ** 2 };
  }

  avgAllianceNp() {
    return this.avg.auto + this.avg.teleop + this.avg.endgame + this.avg.solo.reduce((a, b) => a + b, 0);
  }

  team(num) {
    let t = this.teams.get(num);
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
      this.teams.set(num, t);
    }
    return t;
  }

  // Restore a team's state, e.g. its rating entering an event.
  setTeam(num, { auto, teleop, endgame, n, rp, solo, v, ev }) {
    this.teams.set(num, {
      n, v: v ?? this.p.v0, ev: ev ?? null, auto, teleop, endgame,
      solo: this.soloComps.map((_, j) => solo?.[j] ?? 0), rp: [...rp],
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
    return out;
  }

  // varSum: summed rating variance of every team on the field (relative units).
  // The logistic spread widens with the teams' uncertainty (Glicko/TrueSkill
  // style), so a match of barely-known teams sits closer to 50%, and with the
  // league's foul-differential noise, since fouls flip close matches.
  winProb(redTotal, blueTotal, varSum = 0) {
    const { winScale, winSelf, winFoul, winVar } = this.p;
    const avg = Math.max(10, this.avgAllianceNp());
    let v = winSelf ? winSelf ** 2 * (this.avg.errVar + winFoul * this.avg.foulDiffVar) : (winScale * avg) ** 2 + winFoul * this.avg.foulDiffVar;
    v += winVar * varSum * avg ** 2;
    return 1 / (1 + Math.exp(-(redTotal - blueTotal) / Math.sqrt(v)));
  }

  // Variance a team will carry into this match (incl. the new-event bump).
  preVar(num, eventCode) {
    const t = this.team(num);
    return t.v + (this.p.kalman && eventCode && t.ev && t.ev !== eventCode ? this.p.vEvent : 0);
  }

  predict(red, blue, eventCode) {
    const r = this.allianceExpected(red);
    const b = this.allianceExpected(blue);
    // an alliance's total = its own points + the fouls the other side commits
    r.total = r.np + b.foul;
    b.total = b.np + r.foul;
    const varSum = this.p.kalman ? [...red, ...blue].reduce((s, n) => s + this.preVar(n, eventCode), 0) : 0;
    return { red: r, blue: b, varSum, pRed: this.winProb(r.total, b.total, varSum) };
  }


  // How much of an alliance's error each team takes.
  shares(nums, eventCode) {
    const ts = nums.map((n) => this.team(n));
    if (!this.p.kalman) return ts.map((t) => this.k(t.n) / nums.length);
    for (const t of ts) {
      if (eventCode && t.ev !== eventCode) { if (t.ev) t.v += this.p.vEvent; t.ev = eventCode; }
    }
    const sum = ts.reduce((s, t) => s + t.v, 0) + this.p.vObs;
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
      const share = this.shares(nums, eventCode);

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
      const eNp = act.np - exp.np;
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
    // how far off the predicted score difference was (fouls tracked apart)
    const wa = this.p.winAlpha;
    const foulDiff = (actual.red.total - actual.red.np) - (actual.blue.total - actual.blue.np);
    const npErr = (actual.red.np - actual.blue.np) - (pred.red.total - pred.blue.total);
    this.avg.errVar += wa * (npErr ** 2 - this.avg.errVar);
    this.avg.foulDiffVar += wa * (foulDiff ** 2 - this.avg.foulDiffVar);
    return pred;
  }

  epa(num) {
    const t = this.team(num);
    const e = { n: t.n, v: t.v, ev: t.ev, auto: t.auto, teleop: t.teleop, endgame: t.endgame, rp: [...t.rp], solo: [...t.solo] };
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
