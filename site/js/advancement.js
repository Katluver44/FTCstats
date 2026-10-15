// Advancement points (FTC Competition Manual §4.1 / §13.8.1, Tables 4-2, 4-3 and
// 13-7; the 2026-27 manual keeps the same table). Shared by the build script and
// the browser, like model.js.
//
// A team's points at an event are qualification + alliance selection + playoff +
// judged award points. FIRST publishes no points feed, so the build computes them
// here; scripts/check-advancement.mjs compares the result with FIRST's own reports.

// Point values per season ("can be adjusted" each year). Seasons before 2025 used
// a different system and get no advancement points here.
const RULES_2025 = {
  playoff: { Winner: 40, Finalist: 20, "3rd": 10, "4th": 5 },
  // dual-division events: division finalist / division 3rd (the event final gives 40/20)
  divPlayoff: { Finalist: 10, "3rd": 5 },
  inspire: [60, 30, 15],
  judged: [12, 6, 3],
  judgedTypes: ["Think", "Connect", "Reach", "Sustain", "Design", "Innovate", "Control", "JudgesChoice"],
};
const RULES = { 2025: RULES_2025, 2026: RULES_2025 };
export const advRules = (season) => RULES[season] ?? (season > 2026 ? RULES_2025 : null);

export const PLAYOFF_PTS = RULES_2025.playoff;
export const DIV_PLAYOFF_PTS = RULES_2025.divPlayoff;

// Event types that award advancement (league meets, scrimmages, off-season,
// Premier events and the FIRST Championship do not).
export const ADVANCING_TYPES = new Set(["Qualifier", "LeagueTournament", "SuperQualifier", "Championship", "Pilot"]);

// erf by its Taylor series (|x| stays under 1.5 here), erfinv by Newton's method
function erf(x) {
  let sum = x, term = x;
  for (let n = 1; n < 200; n++) {
    term *= (-x * x) / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-17) break;
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}
function erfinv(y) {
  let x = 0;
  for (let i = 0; i < 100; i++) {
    const step = (erf(x) - y) / ((2 / Math.sqrt(Math.PI)) * Math.exp(-x * x));
    x -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return x;
}
const ALPHA = 1.07, QK = 7 / erfinv(1 / ALPHA);

// Qualification points for rank r of n ranked teams (Table 4-3: 16 for rank 1,
// about 4 for the last). Rounded to 9 decimals first so float noise doesn't ceil 16 to 17.
export function qualPts(r, n) {
  if (!r || !n) return 0;
  return Math.ceil(+(erfinv((n - 2 * r + 2) / (ALPHA * n)) * QK + 9).toFixed(9));
}
// Captain and pick of alliance k both get 21 - k.
export const selectionPts = (allianceNo) => (allianceNo ? Math.max(0, 21 - allianceNo) : 0);

// A team's best judged award (FIRST takes the max, not the sum, of two awards).
export function awardPts({ type, placement }, rules = RULES_2025) {
  if (type === "Inspire") return rules.inspire[placement - 1] ?? 0;
  if (rules.judgedTypes.includes(type)) return rules.judged[placement - 1] ?? 0;
  return 0;
}

// Number of alliances by number of teams (Table 13-2).
export const allianceCount = (n) => (n >= 41 ? 8 : n >= 21 ? 6 : n >= 11 ? 4 : n >= 4 ? 2 : 0);

// Per-team tiebreak stats from qualification matches (Table 4-2, after the
// point categories): average match points without fouls, average auto, highest
// and second-highest match points without fouls.
export function qualStats(matches) {
  const by = new Map();
  for (const m of matches) {
    if (m.level !== "Quals" || !m.played || !m.redScore || !m.blueScore) continue;
    for (const [side, sc] of [["red", m.redScore], ["blue", m.blueScore]]) {
      for (const t of m[side]) {
        if ((m.surr ?? []).includes(t)) continue;
        if (!by.has(t)) by.set(t, { np: [], auto: [] });
        by.get(t).np.push(sc.np ?? 0);
        by.get(t).auto.push(sc.auto ?? 0);
      }
    }
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return new Map([...by].map(([t, s]) => {
    const hi = [...s.np].sort((a, b) => b - a);
    return [t, { np: avg(s.np), auto: avg(s.auto), hi: hi[0] ?? 0, hi2: hi[1] ?? 0 }];
  }));
}

// Points for every team at one event.
//   units: one per division (or one for a normal event):
//     { ranks: [[team, rank]], n (number ranked; default ranks.length),
//       alliances: [[captain, pick, ...]] (index + 1 = alliance number),
//       results: [[team, "Winner" | "Finalist" | "3rd" | "4th" | ...]] }
//   finals: dual-division events only, [[team, "Winner" | "Finalist"]] from the event final
//   awards: [{ teamNumber, type, placement }] (the parent event's)
//   stats: Map team -> qualStats row, for the Table 4-2 tiebreaks
//   roster: teams to list even with no points
// -> rows [{ team, total, judging, playoff, selection, qual }], best first (Table 4-2)
export function eventAdvancement({ season = 2025, units, finals = null, awards = [], stats = new Map(), roster = [] }) {
  const rules = advRules(season);
  if (!rules) return [];
  const divisional = units.length > 1 || !!finals;
  const rows = new Map();
  const row = (t) => {
    if (!rows.has(t)) rows.set(t, { team: t, total: 0, judging: 0, playoff: 0, selection: 0, qual: 0 });
    return rows.get(t);
  };
  for (const t of roster) row(t);
  for (const u of units) {
    const n = u.n ?? u.ranks.length;
    for (const [t, r] of u.ranks) row(t).qual = qualPts(r, n);
    (u.alliances ?? []).forEach((a, i) => a.forEach((t) => (row(t).selection = selectionPts(i + 1))));
    for (const [t, res] of u.results ?? []) {
      // in a dual-division event the division winners' points come from the event final
      row(t).playoff = divisional ? rules.divPlayoff[res] ?? 0 : rules.playoff[res] ?? 0;
    }
  }
  for (const [t, res] of finals ?? []) if (res === "Winner" || res === "Finalist") row(t).playoff = rules.playoff[res];
  for (const a of awards) {
    if (!a.teamNumber) continue;
    const p = awardPts(a, rules);
    if (p) row(a.teamNumber).judging = Math.max(row(a.teamNumber).judging, p);
  }
  for (const r of rows.values()) r.total = r.judging + r.playoff + r.selection + r.qual;
  const st = (t) => stats.get(t) ?? { np: 0, auto: 0, hi: 0, hi2: 0 };
  return [...rows.values()].sort((a, b) => b.total - a.total || b.judging - a.judging || b.playoff - a.playoff
    || b.selection - a.selection || b.qual - a.qual
    || st(b.team).np - st(a.team).np || st(b.team).auto - st(a.team).auto
    || st(b.team).hi - st(a.team).hi || st(b.team).hi2 - st(a.team).hi2 || a.team - b.team);
}
