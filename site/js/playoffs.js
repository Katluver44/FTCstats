// Alliances and bracket, worked out from the playoff matches themselves, so it
// works for every season's format and for live events.
//
// Seeds: alliance captains are picked in rank order, and each captain is the
// best-ranked team still available, so ordering alliances by their best
// qualification rank gives the seed order.
// Bracket: 2019-23 events play best-of-3 series (SF1-1, F-2); from 2024 events
// play double elimination (M-1 ...), sometimes with a best-of-3 final (F-1 ...).

// an alliance with no robots on the field forfeits, whatever the score says
const winner = (m) => {
  const redGone = m.redOn && !m.redOn.length, blueGone = m.blueOn && !m.blueOn.length;
  if (redGone !== blueGone) return redGone ? "blue" : "red";
  return m.redScore.total > m.blueScore.total ? "red" : m.redScore.total < m.blueScore.total ? "blue" : null;
};

// FTC's double-elimination brackets, from the Competition Manual (section 13.7,
// Tables 13-3 to 13-6), by number of alliances. `cols` are the manual's rounds,
// each with its upper (u) and lower (l) bracket matches, ordered so a match sits
// level with the ones that feed it. `src` says who plays each match (red, blue):
// A1 = alliance 1, W3 / L3 = winner / loser of match 3. `place` is where the
// loser of a lower-bracket match finishes.
const TEMPLATES = {
  2: { cols: [], final: [1, 2, 3], src: { 1: ["A1", "A2"], 2: ["A1", "A2"], 3: ["A1", "A2"] }, place: {} },
  4: {
    cols: [{ u: [1, 2] }, { u: [4], l: [3] }, { l: [5] }], final: [6, 7],
    src: { 1: ["A1", "A4"], 2: ["A2", "A3"], 3: ["L1", "L2"], 4: ["W1", "W2"], 5: ["L4", "W3"], 6: ["W4", "W5"], 7: ["W4", "W5"] },
    place: { 3: "4th", 5: "3rd" },
  },
  6: {
    cols: [{ u: [1, 2] }, { u: [3, 4] }, { l: [5, 6] }, { u: [7], l: [8] }, { l: [9] }], final: [10, 11],
    src: { 1: ["A4", "A5"], 2: ["A3", "A6"], 3: ["A1", "W1"], 4: ["A2", "W2"], 5: ["L3", "L2"], 6: ["L4", "L1"],
      7: ["W3", "W4"], 8: ["W6", "W5"], 9: ["L7", "W8"], 10: ["W7", "W9"], 11: ["W7", "W9"] },
    place: { 5: "Tied 5th", 6: "Tied 5th", 8: "4th", 9: "3rd" },
  },
  8: {
    cols: [{ u: [1, 2, 3, 4] }, { u: [7, 8], l: [5, 6] }, { l: [10, 9] }, { u: [11], l: [12] }, { l: [13] }], final: [14, 15],
    src: { 1: ["A1", "A8"], 2: ["A4", "A5"], 3: ["A2", "A7"], 4: ["A3", "A6"], 5: ["L1", "L2"], 6: ["L3", "L4"], 7: ["W1", "W2"],
      8: ["W3", "W4"], 9: ["L7", "W6"], 10: ["L8", "W5"], 11: ["W7", "W8"], 12: ["W10", "W9"], 13: ["L11", "W12"], 14: ["W11", "W13"], 15: ["W11", "W13"] },
    place: { 5: "Tied 7th", 6: "Tied 7th", 9: "Tied 5th", 10: "Tied 5th", 12: "4th", 13: "3rd" },
  },
};
// the bracket for this many alliances, if the matches fit it: every match number is
// in it and its winner/loser paths match who actually played whom
// (some off-season events run their own formats; those fall back to working it out)
function pickTemplate(byNum, alliances) {
  const nums = [...byNum.keys()];
  const fits = (t) => nums.every((n) => t.src[n] && t.src[n].every((x) => {
    if (x[0] === "A") return true; // seeds may be guesses until FIRST publishes them
    const from = byNum.get(+x.slice(1)), s = byNum.get(n);
    if (!from?.winner) return true; // not decided yet: nothing to check
    const a = x[0] === "W" ? from.winner : from.loser;
    return a === s.red || a === s.blue;
  }));
  const n = [2, 4, 6, 8].find((k) => k >= alliances);
  return n && fits(TEMPLATES[n]) ? TEMPLATES[n] : null;
}

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
  let tpl = null, columns = null, places = null, standings = null;
  const feeds = [];
  const mSlots = list.filter((s) => /^M-/.test(s.key)).sort((a, b) => +a.key.slice(2) - +b.key.slice(2));
  // Worlds finals: every pair of alliances meets once, then the top two play a final
  const pairs = (alliances.length * (alliances.length - 1)) / 2;
  const byNum = new Map(mSlots.map((s) => [+s.key.slice(2), s]));
  const roundRobin = doubleElim && alliances.length > 2 && mSlots.length > pairs
    && new Set(mSlots.slice(0, pairs).map((s) => [s.red.seed, s.blue.seed].sort().join())).size === pairs;
  if (roundRobin) {
    // rounds of matches where every alliance plays once (6 alliances: 5 rounds of 3)
    const per = Math.floor(alliances.length / 2), rr = mSlots.slice(0, pairs);
    const rrRounds = [];
    for (let i = 0; i < rr.length; i += per) rrRounds.push({ name: `Round ${rrRounds.length + 1}`, slots: rr.slice(i, i + per) });
    sections.push({ name: "Round robin", roundRobin: true, rounds: rrRounds });
    sections.push({ name: "Final", rounds: [{ name: "Final", slots: [...mSlots.slice(pairs), ...finalSeries] }] });
    columns = [...rrRounds.map((r) => ({ name: r.name, upper: r.slots })), { name: "Final", final: sections.at(-1).rounds[0].slots }];
    // standings: round-robin wins, then average score (FIRST's own tiebreakers aren't in the data)
    standings = alliances.map((a) => {
      const ms = rr.filter((s) => s.red === a || s.blue === a);
      const w = ms.filter((s) => s.winner === a).length, l = ms.filter((s) => s.loser === a).length;
      const pts = ms.flatMap((s) => s.games.filter((g) => g.played).map((g) => (s.red === a ? g.redScore.total : g.blueScore.total)));
      return { a, w, l, t: ms.filter((s) => s.games.some((g) => g.played)).length - w - l, avg: pts.length ? pts.reduce((x, y) => x + y, 0) / pts.length : null };
    }).sort((x, y) => y.w - x.w || x.l - y.l || (y.avg ?? 0) - (x.avg ?? 0));
    const ord = (n) => `${n}${["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;
    standings.forEach((r, i) => {
      const first = standings.findIndex((x) => x.w === r.w && x.l === r.l);
      const tied = standings.filter((x) => x.w === r.w && x.l === r.l).length > 1;
      r.place = `${tied ? "Tied " : ""}${ord(first + 1)}`;
    });
  } else if (doubleElim && (tpl = pickTemplate(byNum, alliances.length))) {
    // matches not played yet show who they're waiting on; once the event is over they're left out
    const slot = (n) => byNum.get(n) ?? (finished ? null : { key: `M-${n}`, games: [], pending: tpl.src[n] });
    const pick = (ns) => (ns ?? []).map(slot).filter(Boolean);
    columns = tpl.cols.map((c, i) => ({ name: `Round ${i + 1}`, upper: pick(c.u), lower: pick(c.l) }));
    const finals = pick(tpl.final).filter((s, i) => i === 0 || !s.pending); // "if required" game only once it's on
    columns.push({ name: "Finals", final: [...finals, ...finalSeries] });
    for (const s of byNum.values()) s.num = +s.key.slice(2);
    places = tpl.place;
    // winner paths for the bracket lines: [from match, to match, side]; the "if required" final has none
    for (const [n, srcs] of Object.entries(tpl.src)) {
      if (+n === tpl.final[1] || +n === tpl.final[2]) continue;
      srcs.forEach((x, i) => x[0] === "W" && feeds.push([`M-${x.slice(1)}`, `M-${n}`, i ? "blue" : "red"]));
    }
    const upper = columns.flatMap((c) => c.upper ?? []), lower = columns.flatMap((c) => c.lower ?? []);
    const named = (arr, part) => columns.filter((c) => c[part]?.length).map((c) => ({ name: c.name, slots: c[part] }));
    if (upper.length) sections.push({ name: "Upper bracket", rounds: named(upper, "upper") });
    if (lower.length) sections.push({ name: "Lower bracket", rounds: named(lower, "lower") });
    sections.push({ name: "Final", rounds: [{ name: "Final", slots: columns.at(-1).final }] });
  } else if (doubleElim) {
    // losses each alliance had before a match decide its bracket: 0-0 upper, 1-1 lower, 0-1 final
    // (once the final has started, a rematch of the same two alliances is still the final)
    const lost = new Map(), depth = new Map(), inFinal = new Set();
    const upper = [], lower = [], final = [];
    for (const s of mSlots) {
      const lr = lost.get(s.red) ?? 0, lb = lost.get(s.blue) ?? 0;
      s.depth = 1 + Math.max(depth.get(s.red) ?? 0, depth.get(s.blue) ?? 0);
      const isFinal = lr !== lb || (inFinal.has(s.red) && inFinal.has(s.blue));
      if (isFinal) { inFinal.add(s.red); inFinal.add(s.blue); }
      (isFinal ? final : lr + lb === 0 ? upper : lower).push(s);
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
      const out = roundRobin ? (champ?.winner ? outs[0] ?? true : null) : doubleElim ? (outs.length >= 2 ? outs.at(-1) : null) : outs[0];
      const where = out && sections.flatMap((sec) => sec.rounds.map((r) => ({ sec, r }))).find(({ r }) => r.slots.includes(out));
      a.result = !out ? (champ?.winner ? "–" : "Playing") : places ? places[out.num] ?? "Out" : roundRobin ? standings.find((r) => r.a === a)?.place ?? "Round robin" : `Out in ${where.sec.name && where.r.name.startsWith("Round") ? `${where.sec.name.split(" ")[0].toLowerCase()} ${where.r.name.toLowerCase()}` : where.r.name.toLowerCase()}`;
    }
  }
  for (const m of elims) { delete m._red; delete m._blue; }
  return { alliances, sections, columns, feeds, standings, doubleElim, roundRobin };
}
