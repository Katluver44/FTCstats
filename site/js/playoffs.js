// Alliances and bracket, worked out from the playoff matches themselves, so it
// works for every season's format and for live events.
//
// Seeds: alliance captains are picked in rank order, and each captain is the
// best-ranked team still available, so ordering alliances by their best
// qualification rank gives the seed order.
// Bracket: 2019-23 events play best-of-3 series (SF1-1, F-2); from 2024 events
// play double elimination (M-1 ...), sometimes with a best-of-3 final (F-1 ...).

const winner = (m) => (m.redScore.total > m.blueScore.total ? "red" : m.redScore.total < m.blueScore.total ? "blue" : null);

export function playoffs(matches, teamList, official, { finished = false } = {}) {
  // once an event is over, unplayed "if needed" matches are just noise
  const elims = matches.filter((m) => m.level && m.level !== "Quals" && (m.played || !finished));
  if (!elims.length) return null;
  const rank = new Map(teamList.map((t) => [t.team, t.rank ?? Infinity]));

  // group teams into alliances (a backup robot joins the alliance it plays with)
  const byTeam = new Map();
  const alliances = [];
  const allianceOf = (teams) => {
    let a = teams.map((t) => byTeam.get(t)).find(Boolean);
    if (!a) alliances.push((a = { teams: [] }));
    for (const t of teams) if (!byTeam.has(t)) { byTeam.set(t, a); a.teams.push(t); }
    return a;
  };
  for (const m of elims) { m._red = allianceOf(m.red); m._blue = allianceOf(m.blue); }
  // FIRST's official selections when we have them (they also give pick order)
  const officialSeed = (a) => official?.findIndex((o) => a.teams.some((t) => o.includes(t))) ?? -1;
  if (official?.length && alliances.every((a) => officialSeed(a) >= 0)) {
    for (const a of alliances) {
      const o = official[officialSeed(a)];
      a.seed = officialSeed(a) + 1;
      a.teams = [...o, ...a.teams.filter((t) => !o.includes(t))];
    }
    alliances.sort((a, b) => a.seed - b.seed);
  } else {
    const best = (a) => Math.min(...a.teams.map((t) => rank.get(t) ?? Infinity));
    alliances.sort((a, b) => best(a) - best(b));
    alliances.forEach((a, i) => {
      a.seed = i + 1;
      a.teams.sort((x, y) => (rank.get(x) ?? Infinity) - (rank.get(y) ?? Infinity));
    });
  }
  for (const a of alliances) { a.captain = a.teams[0]; a.wins = 0; a.losses = 0; a.ties = 0; }

  // one entry per bracket slot: a series (SF1, F) or a double-elim match (M-14, with replays)
  const slots = new Map();
  for (const m of elims) {
    const key = /^M-/.test(m.d) ? m.d.replace(/\.\d+$/, "") : m.d.replace(/-\d+$/, "");
    if (!slots.has(key)) slots.set(key, { key, games: [], red: m._red, blue: m._blue, series: !/^M-/.test(m.d) });
    slots.get(key).games.push(m);
  }
  for (const s of slots.values()) {
    const played = s.games.filter((g) => g.played);
    let r = 0, b = 0;
    for (const g of played) {
      const w = winner(g);
      // a game counts for whichever alliance actually played on that side
      const wa = w === "red" ? g._red : w === "blue" ? g._blue : null;
      if (wa === s.red) r++; else if (wa === s.blue) b++;
      for (const a of [g._red, g._blue]) {
        if (!wa) a.ties++; else if (a === wa) a.wins++; else a.losses++;
      }
    }
    s.redWins = r; s.blueWins = b;
    // best of 3 for SF/F series; a double-elim match is one game, replayed after a
    // tie (M-14.2), except the Worlds final, which is best of 3 (M-16, M-16.2, ...)
    const bestOf3 = s.series || (played.length > 1 && played.every((g) => winner(g)));
    const need = bestOf3 ? 2 : 1;
    s.winner = r >= need ? s.red : b >= need ? s.blue : null;
    // a series can end with the leader short of 2 wins after a tie; take the leader once nothing is left to play
    if (!s.winner && played.length === s.games.length && r !== b && played.length >= 2) s.winner = r > b ? s.red : s.blue;
    s.loser = s.winner && (s.winner === s.red ? s.blue : s.red);
  }

  // lay the slots out in rounds
  const list = [...slots.values()];
  const doubleElim = list.some((s) => /^M-/.test(s.key));
  const finalSeries = list.filter((s) => s.key === "F");
  const sections = [];
  const mSlots = list.filter((s) => /^M-/.test(s.key)).sort((a, b) => +a.key.slice(2) - +b.key.slice(2));
  // Worlds finals: every pair of alliances meets once, then the top two play a final
  const pairs = (alliances.length * (alliances.length - 1)) / 2;
  const roundRobin = doubleElim && alliances.length > 2 && mSlots.length > pairs
    && new Set(mSlots.slice(0, pairs).map((s) => [s.red.seed, s.blue.seed].sort().join())).size === pairs;
  if (roundRobin) {
    sections.push({ name: "Round robin", roundRobin: true, rounds: [{ name: "Round robin", slots: mSlots.slice(0, pairs) }] });
    sections.push({ name: "Final", rounds: [{ name: "Final", slots: [...mSlots.slice(pairs), ...finalSeries] }] });
  } else if (doubleElim) {
    // losses each alliance had before a match decide its bracket: 0-0 upper, 1-1 lower, 0-1 final
    const lost = new Map(), depth = new Map();
    const upper = [], lower = [], final = [];
    for (const s of mSlots) {
      const lr = lost.get(s.red) ?? 0, lb = lost.get(s.blue) ?? 0;
      s.depth = 1 + Math.max(depth.get(s.red) ?? 0, depth.get(s.blue) ?? 0);
      (lr + lb === 0 ? upper : lr === 1 && lb === 1 ? lower : final).push(s);
      for (const a of [s.red, s.blue]) depth.set(a, s.depth);
      if (s.loser) lost.set(s.loser, (lost.get(s.loser) ?? 0) + 1);
    }
    const rounds = (arr, lastName) => {
      const ds = [...new Set(arr.map((s) => s.depth))].sort((a, b) => a - b);
      return ds.map((d, i) => ({ name: i === ds.length - 1 && ds.length > 1 ? lastName : `Round ${i + 1}`, slots: arr.filter((s) => s.depth === d) }));
    };
    if (upper.length) sections.push({ name: "Upper bracket", rounds: rounds(upper, "Upper final") });
    if (lower.length) sections.push({ name: "Lower bracket", rounds: rounds(lower, "Lower final") });
    const f = [...final, ...finalSeries];
    if (f.length) sections.push({ name: "Final", rounds: [{ name: "Final", slots: f }] });
  } else {
    const order = (k) => (k.startsWith("QF") ? 0 : k.startsWith("SF") ? 1 : 2);
    const names = ["Quarterfinals", "Semifinals", "Final"];
    const rounds = [0, 1, 2].map((o) => ({ name: names[o], slots: list.filter((s) => order(s.key) === o) })).filter((r) => r.slots.length);
    sections.push({ name: "", rounds });
  }

  // how far each alliance got
  const lastRound = sections.at(-1)?.rounds.at(-1);
  const champ = lastRound?.name === "Final" || lastRound?.slots.length === 1 ? lastRound.slots.findLast((s) => s.winner) ?? (lastRound.slots.length === 1 ? lastRound.slots[0] : null) : null;
  for (const a of alliances) {
    if (champ?.winner === a) a.result = "Winner";
    else if (champ?.loser === a) a.result = "Finalist";
    else {
      // the last slot this alliance lost (double elim: second loss)
      const outs = list.filter((s) => s.loser === a);
      const out = roundRobin ? (champ?.winner ? outs[0] : null) : doubleElim ? (outs.length >= 2 ? outs.at(-1) : null) : outs[0];
      const where = out && sections.flatMap((sec) => sec.rounds.map((r) => ({ sec, r }))).find(({ r }) => r.slots.includes(out));
      a.result = !out ? (champ?.winner ? "–" : "Playing") : roundRobin ? "Round robin" : `Out in ${where.sec.name && where.r.name.startsWith("Round") ? `${where.sec.name.split(" ")[0].toLowerCase()} ${where.r.name.toLowerCase()}` : where.r.name.toLowerCase()}`;
    }
  }
  for (const m of elims) { delete m._red; delete m._blue; }
  return { alliances, sections, doubleElim, roundRobin };
}
