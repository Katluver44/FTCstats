// EPA (Expected Points Added) model for FTC, after Statbotics' FRC model.
//
// Each team carries an estimate of the points it adds to its alliance, split
// into auto / teleop / endgame, plus a per-team contribution to each bonus
// ranking point. An alliance's predicted score is the sum of its on-field
// teams' EPAs. After every match, each team moves toward the observed result
// by a fraction K of the alliance's error. Teams also carry a foul rating:
// the penalty points they hand the other alliance, which decides close matches. K starts high (new teams adapt fast)
// and settles lower once a team has a track record.
//
// Shared by the build script (Node) and the browser (live events).

export const COMPONENTS = ["auto", "teleop", "endgame"];

// Tuned on the first 70% of the 2025 season (scripts/tune.mjs).
export const DEFAULT_PARAMS = {
  kStart: 0.6, // K for a team's first matches
  kEnd: 0.35, // K once the team is established
  kRampStart: 6, // matches before K starts to fall
  kRampEnd: 18, // matches by which K reaches kEnd
  elimWeight: 0.6, // elims update less: alliances play differently
  initFrac: 0.5, // new teams start at this fraction of an average team
  carry: 0.6, // how much of last season's z-score carries over
  winScale: 0.28, // logistic spread, as a fraction of an average alliance score
  emaAlpha: 0.003, // speed of the season-wide average score tracker
  kRp: 0.35, // K for bonus-RP contributions
  // Per-team foul ratings didn't beat the league average in tuning, so they
  // stay flat; the average still puts predicted totals on the real scale.
  kFoul: 0,
  margin: 0, // weight on the opponent's error (defense), as in Statbotics' FRC model
  matchScale: 0, // 0: spread from the season average score; 1: from this match's predicted scores
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export class Model {
  // baseline: { auto, teleop, endgame, foul, rp: [3] } average *alliance* values,
  // used until the running averages warm up.
  // priors: Map(teamNumber -> z-score of last season's EPA), optional.
  constructor({ params = {}, baseline, priors = new Map(), cv = 0.5 } = {}) {
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.avg = { foul: 0, ...baseline, rp: [...baseline.rp] };
    this.priors = priors;
    this.cv = cv; // spread of team EPAs relative to the mean, for priors
    this.teams = new Map();
  }

  avgAllianceNp() {
    return this.avg.auto + this.avg.teleop + this.avg.endgame;
  }

  team(num) {
    let t = this.teams.get(num);
    if (!t) {
      const z = this.priors.get(num) ?? 0;
      const scale = this.p.initFrac * (1 + this.p.carry * z * this.cv);
      const f = Math.max(0.15, scale) / 2;
      t = {
        n: 0,
        auto: this.avg.auto * f,
        teleop: this.avg.teleop * f,
        endgame: this.avg.endgame * f,
        foul: this.avg.foul / 2,
        rp: this.avg.rp.map((r) => r / 2),
      };
      this.teams.set(num, t);
    }
    return t;
  }

  // Restore a team's state, e.g. its rating entering an event.
  setTeam(num, { auto, teleop, endgame, foul, n, rp }) {
    this.teams.set(num, { n, auto, teleop, endgame, foul: foul ?? this.avg.foul / 2, rp: [...rp] });
  }

  k(n) {
    const { kStart, kEnd, kRampStart, kRampEnd } = this.p;
    if (n <= kRampStart) return kStart;
    if (n >= kRampEnd) return kEnd;
    return kStart + ((n - kRampStart) / (kRampEnd - kRampStart)) * (kEnd - kStart);
  }

  allianceExpected(nums) {
    const out = { auto: 0, teleop: 0, endgame: 0, np: 0, foul: 0, rp: [0, 0, 0] };
    for (const n of nums) {
      const t = this.team(n);
      for (const c of COMPONENTS) out[c] += t[c];
      out.foul += this.p.kFoul ? t.foul : this.avg.foul / nums.length;
      t.rp.forEach((r, i) => (out.rp[i] += r));
    }
    out.np = out.auto + out.teleop + out.endgame;
    out.rp = out.rp.map((r) => clamp(r, 0.01, 0.99));
    return out;
  }

  winProb(redTotal, blueTotal) {
    const ref = this.p.matchScale * (redTotal + blueTotal) / 2 + (1 - this.p.matchScale) * this.avgAllianceNp();
    const scale = this.p.winScale * Math.max(10, ref);
    return 1 / (1 + Math.exp(-(redTotal - blueTotal) / scale));
  }

  predict(red, blue) {
    const r = this.allianceExpected(red);
    const b = this.allianceExpected(blue);
    // an alliance's total = its own points + the fouls the other side commits
    r.total = r.np + b.foul;
    b.total = b.np + r.foul;
    return { red: r, blue: b, pRed: this.winProb(r.total, b.total) };
  }

  // actual: { red: {auto, teleop, endgame, np, total, rp}, blue: {...} }
  update(red, blue, actual, isElim, eventCode) {
    const pred = this.predict(red, blue);
    const w = isElim ? this.p.elimWeight : 1;
    for (const [nums, side] of [[red, "red"], [blue, "blue"]]) {
      const exp = pred[side], act = actual[side];
      const other = side === "red" ? "blue" : "red";
      // penalty points the other alliance received = fouls this alliance committed
      const foulsMade = actual[other].total - actual[other].np;
      for (const num of nums) {
        const t = this.team(num);
        const k = (this.k(t.n) * w) / nums.length / (1 + this.p.margin);
        const oppAct = actual[other], oppExp = pred[other];
        for (const c of COMPONENTS) t[c] += k * (act[c] - exp[c] - this.p.margin * (oppAct[c] - oppExp[c]));
        t.foul = Math.max(0, t.foul + (this.p.kFoul / nums.length) * (foulsMade - exp.foul));
        if (!isElim) {
          const kr = this.p.kRp / nums.length;
          t.rp = t.rp.map((r, i) => clamp(r + kr * ((act.rp?.[i] ? 1 : 0) - exp.rp[i]), -0.2, 1));
        }
        t.n++;
      }
      // season-wide averages drift as teams improve
      const a = this.p.emaAlpha;
      for (const c of COMPONENTS) this.avg[c] += a * (act[c] - this.avg[c]);
      this.avg.foul += a * (foulsMade - this.avg.foul);
      if (!isElim) this.avg.rp = this.avg.rp.map((r, i) => r + a * ((act.rp?.[i] ? 1 : 0) - r));
    }
    return pred;
  }

  epa(num) {
    const t = this.team(num);
    return {
      n: t.n,
      auto: t.auto,
      teleop: t.teleop,
      endgame: t.endgame,
      foul: t.foul,
      np: t.auto + t.teleop + t.endgame,
      rp: [...t.rp],
    };
  }
}

// Which teams actually played for an alliance in a match.
export function onField(match, alliance) {
  return match.teams
    .filter((t) => t.alliance === alliance && t.onField && !t.noShow)
    .map((t) => t.teamNumber);
}

export const isElim = (match) => match.tournamentLevel !== "Quals";
