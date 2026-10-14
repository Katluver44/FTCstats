// Share links: what a shared team / event / match link says about itself.
// Reads the site's own static JSON (same deployment), so it's always current.

const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (s) => { const [, m, d] = String(s).split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };
const seasonLabel = (s) => `${s}–${String(+s + 1).slice(2)}`;

async function getJSON(origin, path) {
  const r = await fetch(`${origin}/data/${path}`);
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${path}`), { status: r.status });
  return r.json();
}

// kind: team | event | match. Returns { title, description, hash, card } or throws.
export async function describe(origin, kind, season, id, d) {
  if (!/^\d{4}$/.test(season)) throw Object.assign(new Error("bad season"), { status: 400 });
  const meta = await getJSON(origin, `${season}/meta.json`);
  const game = meta.game ? ` · ${meta.game}` : "";
  if (kind === "team") {
    if (!/^\d{1,6}$/.test(id)) throw Object.assign(new Error("bad team"), { status: 400 });
    const bucket = await getJSON(origin, `${season}/team/${Math.floor(+id / 10)}x.json`);
    const t = bucket[id];
    if (!t) throw Object.assign(new Error("no team"), { status: 404 });
    const w = t.matches.filter((m) => m.score > m.oppScore).length, l = t.matches.filter((m) => m.score < m.oppScore).length;
    const ties = t.matches.length - w - l;
    const record = `${w}-${l}${ties ? `-${ties}` : ""}`;
    const places = [["World", t.rank, t.of], t.places?.country, t.places?.state].filter(Boolean);
    return {
      title: `${t.team} ${t.name}`,
      description: `EPA ${fmt(t.epa.np)} (#${t.rank} in the world) · auto ${fmt(t.epa.auto)}, teleop ${fmt(t.epa.teleop)}, endgame ${fmt(t.epa.endgame)} · ${record} in ${seasonLabel(season)}${game}`,
      hash: `#/${season}/team/${t.team}`,
      card: { kind, season: seasonLabel(season) + game, num: String(t.team), name: t.name, loc: t.loc, epa: t.epa, record,
        ranks: places.map(([label, rank, of]) => ({ label, rank, of })), max: meta.meterMax ?? null },
    };
  }
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(id)) throw Object.assign(new Error("bad event"), { status: 400 });
  const ev = await getJSON(origin, `${season}/event/${id}.json`);
  if (kind === "event") {
    const top = [...ev.teamList].sort((a, b) => (b.state?.n ? 1 : 0) - (a.state?.n ? 1 : 0) || (b.epaStart ?? 0) - (a.epaStart ?? 0)).slice(0, 3);
    const when = ev.start === ev.end ? day(ev.start) : `${day(ev.start)}–${day(ev.end)}`;
    return {
      title: ev.name,
      description: `${when} · ${ev.loc} · ${ev.teams} teams${ev.played ? ` · ${ev.played}/${ev.matches} matches played` : ""}${ev.accuracy != null && ev.played ? ` · ${pct(ev.accuracy)} of winners predicted` : ""}`,
      hash: `#/${season}/event/${ev.code}`,
      card: { kind, season: seasonLabel(season) + game, name: ev.name, when, loc: ev.loc, teams: ev.teams, played: ev.played, matches: ev.matches,
        accuracy: ev.played ? ev.accuracy : null, top: top.map((x) => ({ num: x.team, name: x.name })) },
    };
  }
  if (kind === "match") {
    const m = ev.matchList.find((x) => x.d === d);
    if (!m) throw Object.assign(new Error("no match"), { status: 404 });
    const names = new Map(ev.teamList.map((x) => [x.team, x.name]));
    const p = m.pred?.pRed;
    const played = m.played && m.redScore;
    const fav = p == null ? null : p >= 0.5 ? "Red" : "Blue";
    const favP = p == null ? null : Math.max(p, 1 - p);
    const score = played ? `${m.redScore.total}–${m.blueScore.total}` : null;
    return {
      title: `${ev.name} · ${m.d}`,
      description: played
        ? `Red ${m.red.join(" & ")} vs blue ${m.blue.join(" & ")}: ${score}.${fav ? ` ${fav} was favoured ${pct(favP)}.` : ""}`
        : `Red ${m.red.join(" & ")} vs blue ${m.blue.join(" & ")}.${fav ? ` ${fav} ${pct(favP)} to win.` : ""}`,
      hash: `#/${season}/match/${encodeURIComponent(ev.code)}/${encodeURIComponent(m.d)}`,
      card: { kind, season: seasonLabel(season) + game, event: ev.name, d: m.d, pRed: p ?? null,
        red: m.red.map((n) => ({ num: n, name: names.get(n) ?? "" })), blue: m.blue.map((n) => ({ num: n, name: names.get(n) ?? "" })),
        redScore: played ? m.redScore.total : null, blueScore: played ? m.blueScore.total : null,
        predRed: m.pred?.red?.total ?? null, predBlue: m.pred?.blue?.total ?? null },
    };
  }
  throw Object.assign(new Error("bad kind"), { status: 400 });
}

// query string for the card image of the same thing
export const cardQuery = (kind, season, id, d) => new URLSearchParams({ kind, season, id, ...(d ? { d } : {}) }).toString();
