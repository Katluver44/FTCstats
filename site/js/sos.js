// Strength of schedule, on ranking points (the Statbotics Delta-RP idea, without
// simulating whole schedules): for each qualification match a team played, the
// ranking points it could expect with the partner and opponents it actually drew,
// against what it could expect from random draws at the same event. Bonus RPs count
// too: a strong partner lifts them, so it's RP, not just wins.
// The result is a 0-1 percentile: the chance a random schedule would have been
// easier than the real one (0.5 = typical, 1 = hardest), plus about how many ranking
// places the draw cost: the RP it lost, times how tightly packed the event's expected
// ranking scores are around the team (a kernel density). Used by scripts/build.mjs
// (season column) and the event Teams tab, so both say the same thing.

const sig = (z) => 1 / (1 + Math.exp(-z));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// standard normal CDF (Abramowitz-Stegun 26.2.17)
export function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// ratings: Map team -> { epa, rp: [bonus RP shares] } as the teams entered the event
// quals: [{ red: [a, b], blue: [c, d] }] (2 v 2 only)
// opts: { winRp, rankBy, scale } scale = logistic win spread in points
// acc: Map team -> { d, v, n, places, events } summed over events (pass the same Map for a season)
export function addEventSos(acc, ratings, quals, { winRp = 2, rankBy = "rp", scale }) {
  const pool = [...ratings.values()].filter((r) => r && Number.isFinite(r.epa));
  if (pool.length < 4 || !(scale > 0)) return acc;
  const byScore = rankBy === "score"; // seasons ranked on points scored: the partner is all that matters
  const expRp = (me, p, o1, o2) => {
    if (byScore) return me.epa + p.epa;
    let rp = winRp * sig((me.epa + p.epa - o1.epa - o2.epa) / scale);
    me.rp?.forEach((r, k) => (rp += clamp(r + (p.rp?.[k] ?? 0), 0.01, 0.99)));
    return rp;
  };
  // each team's expected RP per match over random draws (fixed, repeatable draws)
  const base = new Map();
  const randomDraws = (team, me) => {
    if (base.has(team)) return base.get(team);
    let seed = 12345, s = 0, s2 = 0;
    const pick = () => pool[(seed = (seed * 16807) % 2147483647) % pool.length];
    const N = 400;
    for (let k = 0; k < N; k++) { const x = expRp(me, pick(), pick(), pick()); s += x; s2 += x * x; }
    const out = { mean: s / N, varr: Math.max(1e-9, s2 / N - (s / N) ** 2) };
    base.set(team, out);
    return out;
  };
  const here = new Map(); // this event only: team -> { d, n }
  for (const m of quals) {
    if (m.red?.length !== 2 || m.blue?.length !== 2) continue;
    for (const [side, opp] of [["red", "blue"], ["blue", "red"]]) {
      for (const t of m[side]) {
        const me = ratings.get(t), p = ratings.get(m[side].find((x) => x !== t)), o = m[opp].map((x) => ratings.get(x));
        if (!me || !p || o.some((x) => !x)) continue;
        const b = randomDraws(t, me);
        const delta = b.mean - expRp(me, p, o[0], o[1]); // + = the real draw was worth fewer RP
        const a = acc.get(t) ?? { d: 0, v: 0, n: 0, places: 0, events: 0 };
        a.d += delta; a.v += b.varr; a.n++;
        acc.set(t, a);
        const h = here.get(t) ?? { d: 0, n: 0 };
        h.d += delta; h.n++;
        here.set(t, h);
      }
    }
  }
  // ranking places: lost RP per match x teams per unit of ranking score near this team
  const rs = [...here.keys()].map((t) => base.get(t)?.mean).filter(Number.isFinite);
  if (rs.length >= 4) {
    const mean = rs.reduce((x, y) => x + y, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((x, y) => x + (y - mean) ** 2, 0) / rs.length) || 1e-6;
    const bw = 1.06 * sd * rs.length ** -0.2; // Silverman's rule
    for (const [t, h] of here) {
      const mine = base.get(t)?.mean;
      if (!Number.isFinite(mine)) continue;
      const dens = rs.reduce((x, y) => x + Math.exp(-(((y - mine) / bw) ** 2) / 2), 0) / (rs.length * bw * Math.sqrt(2 * Math.PI));
      const a = acc.get(t);
      a.places += rs.length * dens * (h.d / h.n);
      a.events++;
    }
  }
  return acc;
}

// 0-1: share of random schedules that would have been easier
export const sosValue = (a) => (a && a.n && a.v > 0 ? normCdf(a.d / Math.sqrt(a.v)) : null);
// ranking places the draw cost per event, on average (+ = it ranked lower because of it)
export const sosPlaces = (a) => (a && a.events ? a.places / a.events : null);
