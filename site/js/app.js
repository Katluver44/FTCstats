import {
  $, $$, esc, data, fmt, pct, fmtInt, fmtDate, fmtRange, typeName, epa, teamCell, evCell,
  trend, matchTable, mountLineChart, sortableTable, meter, winBar,
} from "./ui.js";
import { Model } from "./model.js";
import { SEASONS } from "./seasons.js";
import { fetchLiveEvent, normalizeLive, replayEvent, forecastRankings } from "./live.js";

const app = $("#app");
const state = { seasons: [], defaultSeason: null, season: null, liveTimer: null };

// ---------------- routing ----------------

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  let season = state.defaultSeason;
  if (/^\d{4}$/.test(parts[0]) && state.seasons.includes(+parts[0])) season = +parts.shift();
  return { season, page: parts[0] ?? "", args: parts.slice(1), query: new URLSearchParams(query) };
}

async function route() {
  clearInterval(state.liveTimer);
  const r = parseHash();
  state.season = r.season;
  renderNav(r);
  window.scrollTo(0, 0);
  app.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    const pages = { "": home, teams, team, events, event, predict, about };
    const fn = pages[r.page] ?? notFound;
    await fn(r);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty">Couldn't load this page. ${esc(e.message)}</div>`;
  }
}

function renderNav({ season, page }) {
  $("#season").innerHTML = state.seasons
    .map((s) => `<option value="${s}" ${s === season ? "selected" : ""}>${s}–${String(s + 1).slice(2)} · ${esc(SEASONS[s]?.game ?? "")}</option>`)
    .join("");
  $$("header [data-page]").forEach((a) => {
    a.href = `#/${season}/${a.dataset.page}`;
    a.classList.toggle("active", a.dataset.page === page);
  });
  $(".logo").href = `#/${season}/`;
}

const notFound = () => (app.innerHTML = `<div class="empty">Page not found.</div>`);

// ---------------- search ----------------

async function searchItems(season, q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const [teams, events] = await Promise.all([data.teams(season), data.events(season)]);
  const out = [];
  if (/^\d+$/.test(q)) {
    for (const t of teams) if (String(t.team).startsWith(q)) out.push(t);
    out.sort((a, b) => String(a.team).length - String(b.team).length || a.team - b.team);
  } else {
    for (const t of teams) if (t.name.toLowerCase().includes(q)) out.push(t);
  }
  const items = out.slice(0, 6).map((t) => ({ href: `#/${season}/team/${t.team}`, main: `${t.team}`, sub: t.name, kind: "Team" }));
  for (const e of events) {
    if (items.length >= 10) break;
    if (e.name.toLowerCase().includes(q) || e.code.toLowerCase() === q) {
      items.push({ href: `#/${season}/event/${e.code}`, main: e.name, sub: fmtDate(e.start), kind: "Event" });
    }
  }
  return items;
}

function wireSearch(wrap) {
  const input = $("input", wrap), box = $(".search-results", wrap);
  let sel = 0, items = [];
  const draw = () => {
    box.innerHTML = items.map((it, i) =>
      `<a href="${it.href}" class="${i === sel ? "sel" : ""}"><b>${esc(it.main)}</b><span class="muted small">${esc(it.sub)}</span><span class="kind">${it.kind}</span></a>`).join("")
      || (input.value.trim() ? `<div class="empty small">No teams or events match.</div>` : "");
    box.classList.toggle("open", !!input.value.trim());
  };
  input.oninput = async () => { items = await searchItems(state.season, input.value); sel = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === "Enter" && items[sel]) { location.hash = items[sel].href; close(); }
    if (e.key === "Escape") close();
  };
  const close = () => { input.value = ""; items = []; box.classList.remove("open"); input.blur(); };
  box.onclick = () => close();
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) box.classList.remove("open"); });
}

// ---------------- home ----------------

const SEARCH_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

async function home({ season }) {
  const [meta, sum] = await Promise.all([data.meta(season), data.summary(season)]);
  const teams = data.rows(sum.cols, sum.top);
  const acc = meta.accuracy.all;
  const newest = state.seasons[0];
  const banner = season !== newest
    ? `<div class="banner">The ${newest}–${String(newest + 1).slice(2)} season has started, with ${fmtInt((await data.meta(newest)).matches)} matches so far. <a href="#/${newest}/">Switch to ${newest} →</a></div>`
    : "";
  const { live, recent, strongest } = sum;

  // featured card: the season's top four teams, #1 + #4 vs #2 + #3
  const [t1, t2, t3, t4] = teams;
  let feature = "";
  if (t4) {
    const a = meta.avgAlliance;
    const model = new Model({ baseline: { auto: a.auto, teleop: a.teleop, endgame: a.endgame, foul: a.foul, rp: a.rp } });
    for (const t of [t1, t2, t3, t4]) model.setTeam(t.team, { auto: t.auto, teleop: t.teleop, endgame: t.endgame, foul: t.foul, n: t.matches, rp: [t.rp0, t.rp1, t.rp2] });
    const p = model.predict([t1.team, t4.team], [t2.team, t3.team]);
    const side = (cls, ts) => `<div class="feature-side ${cls}">${ts.map((t) => `<a href="#/${season}/team/${t.team}">${t.team}</a><small>${esc(t.name)}</small>`).join("")}</div>`;
    feature = `<div class="feature">
      <div class="feature-head"><b>Dream match: the top 4, predicted</b><span>${esc(meta.game)}</span></div>
      <div class="feature-body">
        ${side("red", [t1, t4])}
        <div class="feature-score"><span class="score red">${fmt(p.red.total, 0)}</span><span class="faint">–</span><span class="score blue">${fmt(p.blue.total, 0)}</span></div>
        ${side("blue", [t2, t3])}
      </div>
      <div class="feature-foot">${winBar(p.pRed)}<p>Red wins ${pct(p.pRed)} of the time. <a class="link" href="#/${season}/predict?r=${t1.team},${t4.team}&b=${t2.team},${t3.team}">Try your own matchup →</a></p></div>
    </div>`;
  }

  app.innerHTML = `
    <section class="hero">
      <div>
        ${banner}
        <div class="eyebrow">${season}–${String(season + 1).slice(2)} season · ${esc(meta.game)}</div>
        <div class="hero-title">Every FTC match, predicted.</div>
        <div class="hero-sub">Team ratings that update after every match, win chances you can check against real results, and ranking forecasts for live events.</div>
        <div class="search hero-search mobile-only" id="hero-search">${SEARCH_ICON}<input placeholder="Search teams & events" autocomplete="off"><div class="search-results"></div></div>
        <div class="hero-actions">
          <a class="btn btn-solid" href="#/${season}/teams">Find a team</a>
          <a class="btn btn-outline" href="#/${season}/about">How predictions work</a>
        </div>
        <div class="hero-stats">
          <div><b>${pct(acc.accuracy, 1)}</b><span>winners called before the match</span></div>
          <div><b>${fmtInt(meta.matches)}</b><span>matches rated</span></div>
          <div><b>${fmtInt(meta.teams)}</b><span>teams</span></div>
        </div>
      </div>
      <div class="hero-media">${feature}</div>
    </section>
    <div class="hero-below">
      <div class="grid cols-2">
        <div>
          <div class="section-title"><div class="eyebrow">Ratings</div><h2>Top teams</h2></div>
          <div class="card"><div id="top-teams"></div><a class="more" href="#/${season}/teams">All teams →</a></div>
        </div>
        <div>
          <div class="section-title"><div class="eyebrow">${live.length ? "Live" : "Results"}</div><h2>${live.length ? "Happening now" : "Recent events"}</h2></div>
          <div class="card">${eventList(season, meta, live.length ? live : recent)}<a class="more" href="#/${season}/events">All events →</a></div>
        </div>
      </div>
      <div class="section-title"><div class="eyebrow">Competition</div><h2>Strongest events</h2><p class="muted" style="margin:6px 0 0">Ranked by the average EPA of each event's top 8 teams.</p></div>
      <div class="card">${eventList(season, meta, strongest)}</div>
    </div>`;
  wireSearch($("#hero-search"));
  $("#top-teams").innerHTML = `<div class="table-wrap"><table><tbody>${teams.slice(0, 10).map((t) => `
    <tr><td class="faint num" style="width:32px">${t.rank}</td><td>${teamCell(season, t.team, t.name)}</td>
    <td class="small muted hide-sm">${esc(t.loc)}</td><td class="r">${epa(t.np, meta)}</td></tr>`).join("")}</tbody></table></div>`;
}

function eventList(season, meta, evs) {
  if (!evs.length) return `<div class="empty">No events yet.</div>`;
  return `<div class="table-wrap"><table><tbody>${evs.map((e) => `
    <tr>
      <td>${evCell(season, e.code, e.name, `${fmtRange(e.start, e.end)} · ${esc(e.loc)}`)}</td>
      <td class="small muted hide-sm">${typeName(e.type)}</td>
      <td class="r">${e.ongoing ? '<span class="pill live">Live</span>' : epa(e.strength, meta)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

// ---------------- teams ----------------

async function teams({ season, query }) {
  const [meta, rows] = await Promise.all([data.meta(season), data.teams(season)]);
  const rpNames = meta.rpNames;
  const countries = [...new Set(rows.map((r) => r.country).filter(Boolean))].sort();
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="filter" placeholder="Search teams…" value="${esc(query.get("q") ?? "")}">
        <select id="country"><option value="">Country</option>${countries.map((c) => `<option ${c === query.get("country") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="minm"><option value="1">All teams</option><option value="10">10+ matches</option><option value="25">25+ matches</option></select>
        <span class="small muted" id="count"></span>
        <a class="small link" href="#/${season}/about" style="margin-left:auto">What's EPA?</a>
      </div>
      <div id="tbl"></div>
    </div>`;
  const cols = [
    { key: "rank", label: "#", cls: "faint num", render: (r) => r.rank },
    { key: "team", label: "Team", render: (r) => teamCell(season, r.team, r.name), sort: false },
    { key: "loc", label: "Location", cls: "small muted hide-sm", sort: false, render: (r) => esc(r.loc) },
    { key: "np", label: "EPA", cls: "c", render: (r) => epa(r.np, meta) },
    { key: "auto", label: "Auto", cls: "r", render: (r) => fmt(r.auto) },
    { key: "teleop", label: "Teleop", cls: "r", render: (r) => fmt(r.teleop) },
    { key: "endgame", label: "Endgame", cls: "r", render: (r) => fmt(r.endgame) },
    ...rpNames.map((n, i) => ({ key: `rp${i}`, label: `${n} RP`, cls: "r small hide-sm", render: (r) => pct(Math.max(0, r[`rp${i}`])) })),
    { key: "wins", label: "Record", cls: "r small", render: (r) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}` },
    { key: "trend", label: "Last 10", cls: "r small", render: (r) => trend(r.trend) },
  ];
  const table = sortableTable($("#tbl"), rows, cols, { sortKey: "np" });
  const apply = () => {
    const q = $("#filter").value.trim().toLowerCase(), c = $("#country").value, m = +$("#minm").value;
    const shown = rows.filter((r) =>
      (!c || r.country === c) && r.matches >= m &&
      (!q || String(r.team).startsWith(q) || r.name.toLowerCase().includes(q) || r.loc.toLowerCase().includes(q)));
    $("#count").textContent = `${fmtInt(shown.length)} teams`;
    table.setRows(shown);
  };
  $("#filter").oninput = apply; $("#country").onchange = apply; $("#minm").onchange = apply;
  apply();
}

// ---------------- team ----------------

async function team({ season, args }) {
  const n = +args[0], view = args[1] ?? "matches";
  const [meta, t, events, all] = await Promise.all([
    data.meta(season), data.team(season, n).catch(() => null), data.events(season), data.teams(season),
  ]);
  if (!t) {
    app.innerHTML = `<div class="card empty">Team ${n} has no matches in ${season}. ${state.seasons.filter((s) => s !== season).map((s) => `<a class="link" href="#/${s}/team/${n}">Try ${s}</a>`).join(" ")}</div>`;
    return;
  }
  const evName = new Map(events.map((e) => [e.code, e.name]));
  const e = t.epa;
  const w = t.matches.filter((m) => m.score > m.oppScore).length;
  const l = t.matches.filter((m) => m.score < m.oppScore).length;
  const ti = t.matches.length - w - l;
  const decided = t.matches.filter((m) => m.score !== m.oppScore);
  const correct = decided.filter((m) => (m.pWin > 0.5) === (m.score > m.oppScore)).length;

  // rank tiles: world, country, state/province
  const me = all.find((r) => r.team === n);
  const parts = (me?.loc ?? "").split(", ");
  const st = parts.length >= 3 ? parts[parts.length - 2] : null;
  const stateOf = (r) => { const p = r.loc.split(", "); return p.length >= 3 ? p[p.length - 2] : null; };
  const inCountry = all.filter((r) => r.country === me?.country);
  const inState = st ? inCountry.filter((r) => stateOf(r) === st) : [];
  const tile = (rank, label, of) => `<div class="tile"><b>#${rank}</b><div class="k">${esc(label)}</div><div class="s">out of ${fmtInt(of)}</div></div>`;
  const tiles = [
    tile(t.rank, "World", t.of),
    me?.country ? tile(inCountry.findIndex((r) => r.team === n) + 1, me.country, inCountry.length) : "",
    st ? tile(inState.findIndex((r) => r.team === n) + 1, st, inState.length) : "",
  ].join("");

  const max = (k) => Math.max(...all.slice(0, 50).map((r) => r[k]));
  const top = all[0];

  app.innerHTML = `
    <div class="card card-pad">
      <div class="page-head">
        <div>
          <h1><span class="team-num">${n}</span> ${esc(t.name)}</h1>
          <div class="muted" style="margin-top:4px">${esc(t.loc)}${t.rookie ? ` · Rookie year ${t.rookie}` : ""}</div>
          <div class="small muted" style="margin-top:2px">#${fmtInt(t.rank)} of ${fmtInt(t.of)} · ${w}-${l}${ti ? `-${ti}` : ""} · ${t.matches.length ? pct(w / t.matches.length) : "–"} win rate · predicted ${decided.length ? pct(correct / decided.length) : "–"} of its matches</div>
        </div>
        <div class="row"><a class="pill" href="#/${season}/predict?r=${n}">Use in predictor →</a></div>
      </div>
      <div class="meters section">
        <div>
          ${meter("EPA", e.np, top.np)}
          ${meter("Auto", e.auto, max("auto"))}
          ${meter("Teleop", e.teleop, max("teleop"))}
          ${meter("Endgame", e.endgame, max("endgame"))}
        </div>
        <div>
          ${meta.rpNames.map((r, i) => meter(`${r} RP`, Math.max(0, e.rp[i]), 1, fmt(Math.max(0, e.rp[i]), 2).replace(/^0/, ""))).join("")}
        </div>
      </div>
    </div>
    <div class="tiles section">${tiles}</div>
    <div class="row section" style="justify-content:space-between">
      <nav class="seg glass">
        <a href="#/${season}/team/${n}" class="${view === "matches" ? "active" : ""}">Matches</a>
        <a href="#/${season}/team/${n}/charts" class="${view === "charts" ? "active" : ""}">Charts</a>
      </nav>
    </div>
    <div id="view"></div>`;

  if (view === "charts") {
    $("#view").innerHTML = `<div class="card card-pad section"><h2>EPA over the season</h2><div id="chart"></div></div>`;
    const bands = [];
    t.matches.forEach((m, i) => {
      const last = bands[bands.length - 1];
      if (last && last.ev === m.ev) last.to = i;
      else bands.push({ ev: m.ev, from: i, to: i, label: shortEvent(evName.get(m.ev) ?? m.ev) });
    });
    mountLineChart($("#chart"), {
      series: [
        { name: "EPA", color: "var(--text)", values: t.matches.map((m) => m.epa[0]), width: 2.5 },
        { name: "Auto", color: "#f59e0b", values: t.matches.map((m) => m.epa[1]) },
        { name: "Teleop", color: "var(--accent)", values: t.matches.map((m) => m.epa[2]) },
        { name: "Endgame", color: "#10b981", values: t.matches.map((m) => m.epa[3]) },
      ],
      bands,
      tooltip: (i) => {
        const m = t.matches[i];
        return `<b>${esc(evName.get(m.ev) ?? m.ev)}</b> · ${esc(m.m)}<br>EPA ${fmt(m.epa[0])} · ${m.score > m.oppScore ? "W" : m.score < m.oppScore ? "L" : "T"} ${m.score}–${m.oppScore}`;
      },
    });
    return;
  }

  // one card per event, newest first
  $("#view").innerHTML = [...t.events].reverse().map((ev) => {
    const ms = t.matches.filter((m) => m.ev === ev.code).map((m) => toMatch(m, n));
    return `<div class="card section">
      <div class="ev-head">
        <div>
          <h2><a href="#/${season}/event/${ev.code}">${esc(ev.name)}</a></h2>
          <div class="small muted">${typeName(ev.type)} · ${fmtDate(ev.start, { month: "short", day: "numeric", year: "numeric" })}</div>
        </div>
        <div class="ev-box">
          <div><span class="k">Rank</span><b>${ev.rank ?? "–"}</b></div>
          <div><span class="k">Record</span><b>${ev.wins != null ? `${ev.wins}-${ev.losses}${ev.ties ? `-${ev.ties}` : ""}` : "–"}</b></div>
          <div><span class="k">EPA in</span><b>${fmt(ev.epaStart)}</b></div>
          <div><span class="k">EPA out</span><b>${epa(ev.epaEnd, meta)}</b></div>
        </div>
      </div>
      ${matchTable(season, ms, { me: n })}
    </div>`;
  }).join("");
}

const shortEvent = (name) => name.replace(/\b(Championship|Qualifier|Tournament|League|Meet|Scrimmage)\b/g, (w) => w.slice(0, 5) + ".");

function toMatch(m, me) {
  const mine = [me, ...m.partners];
  const isRed = m.side === "red";
  const bits = (arr, bit) => arr?.map((x) => (x & bit ? 1 : 0));
  const mySide = { np: m.pred[0], rp: bits(m.rp, 1) }, oppSide = { np: m.pred[1], rp: bits(m.orp, 1) };
  return {
    d: m.m, played: true,
    red: isRed ? mine : m.opps, blue: isRed ? m.opps : mine,
    redScore: { total: isRed ? m.score : m.oppScore, rp: bits(isRed ? m.rp : m.orp, 2) },
    blueScore: { total: isRed ? m.oppScore : m.score, rp: bits(isRed ? m.orp : m.rp, 2) },
    pred: { pRed: isRed ? m.pWin : 1 - m.pWin, red: isRed ? mySide : oppSide, blue: isRed ? oppSide : mySide },
  };
}

// ---------------- events ----------------

async function events({ season, query }) {
  const [meta, evs] = await Promise.all([data.meta(season), data.events(season)]);
  const types = [...new Set(evs.map((e) => e.type))];
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="filter" placeholder="Search events…" value="${esc(query.get("q") ?? "")}">
        <select id="type"><option value="">Type</option>${types.map((t) => `<option value="${t}">${typeName(t)}</option>`).join("")}</select>
      </div>
      <div id="tbl"></div>
    </div>`;
  const cols = [
    { key: "name", label: "Event", sort: false, render: (e) => evCell(season, e.code, e.name, `${esc(e.loc)} ${e.ongoing ? '<span class="pill live">Live</span>' : ""}`) },
    { key: "start", label: "Date", cls: "small muted", render: (e) => fmtDate(e.start) },
    { key: "type", label: "Type", cls: "small muted hide-sm", render: (e) => typeName(e.type) },
    { key: "teams", label: "Teams", cls: "r hide-sm" },
    { key: "strength", label: "Strength", cls: "r", render: (e) => epa(e.strength, meta) },
    { key: "accuracy", label: "Called", cls: "r small hide-sm", render: (e) => pct(e.accuracy) },
  ];
  const table = sortableTable($("#tbl"), evs, cols, { sortKey: "start" });
  const apply = () => {
    const q = $("#filter").value.trim().toLowerCase(), ty = $("#type").value;
    table.setRows(evs.filter((e) => (!ty || e.type === ty) &&
      (!q || e.name.toLowerCase().includes(q) || e.code.toLowerCase().includes(q) || e.loc.toLowerCase().includes(q))));
  };
  $("#filter").oninput = apply; $("#type").onchange = apply;
  apply();
}

// ---------------- event ----------------

async function event({ season, args }) {
  const code = args[0], tab = args[1] ?? "matches";
  const [meta, ev] = await Promise.all([data.meta(season), data.event(season, code)]);
  let matches = ev.matchList;
  let liveAt = null;

  const today = new Date().toISOString().slice(0, 10);
  const maybeLive = !ev.finished && ev.start <= today && today <= ev.end;
  const refresh = async () => {
    try {
      const raw = await fetchLiveEvent(season, code);
      matches = replayEvent(meta, ev, normalizeLive(season, raw)).matches;
      for (const tp of raw.teams) {
        const row = ev.teamList.find((x) => x.team === tp.teamNumber);
        if (row && tp.stats) Object.assign(row, { rank: tp.stats.rank, wins: tp.stats.wins, losses: tp.stats.losses, ties: tp.stats.ties });
      }
      liveAt = new Date();
      draw();
    } catch (e) { console.warn(e); }
  };

  const draw = () => {
    const played = matches.filter((m) => m.played);
    const decided = played.filter((m) => m.pred && m.redScore.total !== m.blueScore.total);
    const correct = decided.filter((m) => (m.pred.pRed > 0.5) === (m.redScore.total > m.blueScore.total)).length;
    const upsets = decided.filter((m) => (m.pred.pRed > 0.5) !== (m.redScore.total > m.blueScore.total))
      .sort((a, b) => Math.abs(b.pred.pRed - 0.5) - Math.abs(a.pred.pRed - 0.5)).slice(0, 3);
    const hasQuals = matches.some((m) => m.level === "Quals");
    const tabs = [["matches", "Matches"], ["teams", "Teams"], ...(hasQuals ? [["forecast", "Rankings forecast"]] : [])];
    app.innerHTML = `
      <div class="card card-pad"><div class="page-head">
        <div>
          <div class="kicker">${typeName(ev.type)} · ${fmtRange(ev.start, ev.end)} · ${esc(ev.loc)}</div>
          <h1>${esc(ev.name)}</h1>
          <div class="row" style="margin-top:8px">
            ${liveAt ? `<span class="pill live">Live · updated ${liveAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>` : ""}
            <span class="pill">${ev.teams} teams</span><span class="pill">${played.length}/${matches.length} matches played</span>
            <a class="pill" href="https://ftcscout.org/events/${season}/${code}" target="_blank" rel="noopener">FTCScout ↗</a>
          </div>
        </div>
        <div class="big-epa"><div class="label">Winner predicted</div><b>${decided.length ? pct(correct / decided.length) : "–"}</b><div class="label">${correct} of ${decided.length} matches</div></div>
      </div></div>
      ${upsets.length && tab === "matches" ? `<div class="card card-pad section"><h3>Biggest upsets</h3><div class="row" style="margin-top:8px;gap:18px">${upsets.map((m) => {
        const winner = m.redScore.total > m.blueScore.total ? "red" : "blue";
        const p = winner === "red" ? m.pred.pRed : 1 - m.pred.pRed;
        return `<span><b>${esc(m.d)}</b> <span class="score ${winner}">${winner === "red" ? m.red.join(" & ") : m.blue.join(" & ")}</span> won with a <b>${pct(p)}</b> chance</span>`;
      }).join("")}</div></div>` : ""}
      <nav class="tabs seg glass">${tabs.map(([k, label]) => `<a href="#/${season}/event/${code}/${k}" class="${k === tab ? "active" : ""}">${label}</a>`).join("")}</nav>
      <div id="tab"></div>`;
    if (tab === "teams") eventTeams(season, meta, ev);
    else if (tab === "forecast") eventForecast(season, meta, ev, matches);
    else $("#tab").innerHTML = `<div class="card">${matchTable(season, matches)}</div>`;
  };

  draw();
  if (maybeLive) {
    refresh();
    state.liveTimer = setInterval(() => document.visibilityState === "visible" && refresh(), 60_000);
  }
}

function eventTeams(season, meta, ev) {
  const rows = ev.teamList.map((t) => ({ ...t, epa: t.epaNow?.np ?? null, delta: t.epaEnd != null && t.epaStart != null ? t.epaEnd - t.epaStart : null }));
  $("#tab").innerHTML = `<div class="card" id="tt"></div>`;
  sortableTable($("#tt"), rows, [
    { key: "rank", label: "Rank", cls: "num", render: (r) => r.rank ?? "–" },
    { key: "team", label: "Team", sort: false, render: (r) => teamCell(season, r.team, r.name) },
    { key: "wins", label: "Record", cls: "r small", render: (r) => (r.wins != null ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}` : "–") },
    { key: "epaStart", label: "EPA in", cls: "r", render: (r) => fmt(r.epaStart) },
    { key: "epaEnd", label: "EPA out", cls: "r", render: (r) => epa(r.epaEnd, meta) },
    { key: "delta", label: "Change", cls: "r small", render: (r) => trend(r.delta) },
    { key: "epa", label: "EPA now", cls: "r hide-sm", render: (r) => epa(r.epa, meta) },
  ], { sortKey: "epaEnd" });
}

function eventForecast(season, meta, ev, matches) {
  const quals = matches.filter((m) => m.level === "Quals");
  const playedQuals = quals.filter((m) => m.actuallyPlayed ?? m.played).length;
  const finished = playedQuals === quals.length;
  // default: forecast from now; for a finished event, rewind to the halfway point
  let cutoff = finished ? Math.floor(quals.length / 2) : playedQuals;
  const teams = ev.teamList.map((t) => t.team);
  const finalRank = new Map(ev.teamList.map((t) => [t.team, t.rank]));
  const names = new Map(ev.teamList.map((t) => [t.team, t.name]));

  $("#tab").innerHTML = `
    <div class="card card-pad">
      <div class="row" style="justify-content:space-between">
        <div><b>Forecast after <span id="cut-label"></span></b><div class="small muted">${fmtInt(3000)} simulations of the remaining qualification matches, using ratings as of that moment.${finished ? " Drag back in time to see how the forecast compared to the final rankings." : ""}</div></div>
        <input type="range" id="cut" min="0" max="${quals.length}" value="${cutoff}" style="width:min(320px,100%)">
      </div>
    </div>
    <div class="card section" id="fc"></div>`;

  const run = () => {
    $("#cut-label").textContent = cutoff === 0 ? "the schedule was released" : `${quals[cutoff - 1].d}`;
    const replayed = replayEvent(meta, ev, matches.map((m) => ({ ...m, played: m.actuallyPlayed ?? m.played })), cutoff).matches;
    const rows = forecastRankings(season, teams, replayed);
    const showFinal = cutoff < playedQuals;
    $("#fc").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Proj.</th><th>Team</th><th class="r">Current RS</th><th class="r">Proj. RS</th><th class="r">Avg rank</th><th class="r">#1</th><th class="r">Top 4</th><th class="r hide-sm">Top 8</th>${showFinal ? '<th class="r">Actual rank</th>' : ""}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="faint num">${i + 1}</td>
        <td>${teamCell(season, r.team, names.get(r.team))}</td>
        <td class="r small">${r.currentRs != null ? fmt(r.currentRs, 2) : "–"} <span class="faint">(${r.played})</span></td>
        <td class="r">${fmt(r.meanRs, 2)}</td>
        <td class="r">${fmt(r.meanRank, 1)}</td>
        <td class="r">${probCell(r.p1)}</td>
        <td class="r">${probCell(r.p4)}</td>
        <td class="r hide-sm">${probCell(r.p8)}</td>
        ${showFinal ? `<td class="r"><b>${finalRank.get(r.team) ?? "–"}</b></td>` : ""}
      </tr>`).join("")}</tbody></table></div>`;
  };
  let pending;
  $("#cut").oninput = (e) => {
    cutoff = +e.target.value;
    $("#cut-label").textContent = cutoff === 0 ? "the schedule was released" : `${quals[cutoff - 1].d}`;
    clearTimeout(pending);
    pending = setTimeout(run, 60);
  };
  run();
}

const probCell = (p) => {
  if (p < 0.005) return `<span class="faint">–</span>`;
  const a = Math.round(15 + p * 70);
  return `<span class="epa" style="background:color-mix(in srgb,var(--accent) ${a}%,transparent);color:${p > 0.5 ? "#fff" : "var(--text)"}">${pct(p)}</span>`;
};

// ---------------- predictor ----------------

async function predict({ season, query }) {
  const [meta, teams] = await Promise.all([data.meta(season), data.teams(season)]);
  const byNum = new Map(teams.map((t) => [t.team, t]));
  const slots = { r: (query.get("r") ?? "").split(","), b: (query.get("b") ?? "").split(",") };
  const input = (side, i) => `<input inputmode="numeric" placeholder="Team #" data-side="${side}" data-i="${i}" value="${esc(slots[side][i] ?? "")}"><div class="who" id="who-${side}${i}"></div>`;
  app.innerHTML = `
    <div class="card card-pad"><h1>Match predictor</h1><p class="muted" style="margin:4px 0 0">Pick any four teams to see who's favoured and why. Uses each team's current EPA.</p></div>
    <div class="predictor section">
      <div class="side red card">${input("r", 0)}${input("r", 1)}</div>
      <div class="vs">VS</div>
      <div class="side blue card">${input("b", 0)}${input("b", 1)}</div>
    </div>
    <div id="out" class="section"></div>`;

  const run = () => {
    const nums = { r: [], b: [] };
    $$(".predictor input").forEach((el) => {
      const n = +el.value, t = byNum.get(n);
      $(`#who-${el.dataset.side}${el.dataset.i}`).innerHTML = el.value ? (t ? `${esc(t.name)} · EPA ${fmt(t.np)}` : `<span class="faint">no ${season} matches</span>`) : "";
      if (t) nums[el.dataset.side].push(n);
    });
    history.replaceState(null, "", `#/${season}/predict?r=${nums.r.join(",")}&b=${nums.b.join(",")}`);
    if (!nums.r.length || !nums.b.length) {
      $("#out").innerHTML = `<div class="card empty">Enter at least one team on each side.</div>`;
      return;
    }
    const a = meta.avgAlliance;
    const model = new Model({ baseline: { auto: a.auto, teleop: a.teleop, endgame: a.endgame, foul: a.foul, rp: a.rp } });
    for (const n of [...nums.r, ...nums.b]) {
      const t = byNum.get(n);
      model.setTeam(n, { auto: t.auto, teleop: t.teleop, endgame: t.endgame, foul: t.foul, n: t.matches, rp: [t.rp0, t.rp1, t.rp2] });
    }
    const p = model.predict(nums.r, nums.b);
    const comp = (k, label) => `<tr><td class="muted">${label}</td><td class="r score red">${fmt(p.red[k])}</td><td class="r score blue">${fmt(p.blue[k])}</td></tr>`;
    $("#out").innerHTML = `
      <div class="grid cols-2">
        <div class="card card-pad">
          <h3>Win chance</h3>
          <div class="row" style="justify-content:space-between;margin-top:8px">
            <span class="big-score score red">${pct(p.pRed)}</span><span class="big-score score blue">${pct(1 - p.pRed)}</span>
          </div>
          <div class="pbar" style="width:100%;height:10px;border-radius:5px;margin-top:8px"><span class="r" style="width:${p.pRed * 100}%"></span><span class="b" style="width:${(1 - p.pRed) * 100}%"></span></div>
        </div>
        <div class="card">
          <table><thead><tr><th>Predicted</th><th class="r">Red</th><th class="r">Blue</th></tr></thead><tbody>
            ${comp("auto", "Auto")}${comp("teleop", "Teleop")}${comp("endgame", "Endgame")}
            <tr><td class="muted">Penalty points from opponent fouls</td><td class="r score red">${fmt(p.blue.foul)}</td><td class="r score blue">${fmt(p.red.foul)}</td></tr>
            <tr><td><b>Total</b></td><td class="r score red"><b>${fmt(p.red.total, 0)}</b></td><td class="r score blue"><b>${fmt(p.blue.total, 0)}</b></td></tr>
            ${meta.rpNames.map((n, i) => `<tr><td class="muted">${esc(n)} RP chance</td><td class="r">${pct(p.red.rp[i])}</td><td class="r">${pct(p.blue.rp[i])}</td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>`;
  };
  $$(".predictor input").forEach((el) => (el.oninput = run));
  run();
}

// ---------------- about / accuracy ----------------

async function about({ season }) {
  const meta = await data.meta(season);
  const a = meta.accuracy;
  const row = (k, label) => a[k] ? `<tr><td>${label}</td><td class="r">${fmtInt(a[k].matches)}</td><td class="r"><b>${pct(a[k].accuracy, 1)}</b></td><td class="r">${fmt(a[k].brier, 3)}</td><td class="r">${fmt(a[k].scoreMae)}</td><td class="r hide-sm">${a[k].rpBrier != null ? fmt(a[k].rpBrier, 3) : "–"}</td></tr>` : "";
  const W = 300, H = 300;
  const cal = a.calib.map((b) => {
    const x = 30 + ((b.bin + 0.05) - 0.5) * 2 * (W - 40), y = H - 30 - (b.winRate - 0.5) * 2 * (H - 40);
    return `<circle cx="${x}" cy="${y}" r="${4 + Math.sqrt(b.n) / 25}" fill="var(--accent)" fill-opacity=".85"><title>${pct(b.bin)}–${pct(b.bin + 0.1)} predicted: won ${pct(b.winRate, 1)} of ${fmtInt(b.n)}</title></circle>`;
  }).join("");
  app.innerHTML = `
    <div class="card card-pad"><div class="prose">
      <div class="kicker muted small">${season}–${String(season + 1).slice(2)} · ${esc(meta.game)}</div>
      <h1>How the predictions work</h1>
      <p>Every team has an <b>EPA</b>, short for Expected Points Added: the points it adds to its alliance's score in an average match. An alliance's predicted score is the sum of its two teams' EPAs, and the gap between the two predicted scores gives the win chance.</p>
      <p>After each match, every team's EPA moves toward what actually happened. New teams move fast; teams with a long record move less. Auto, teleop and endgame are tracked separately, and so is each team's share of every bonus ranking point. Penalty points are left out because they say more about the opponent than the team.</p>
      <p>This is the approach <a href="https://www.statbotics.io" style="color:var(--accent)">Statbotics</a> uses for FRC, adapted to FTC's 2v2 alliances. OPR, which FTCScout shows, is computed separately for each event and can't predict a team's first match at its next event. EPA carries over across events and seasons.</p>
    </div></div>
    <div class="card card-pad section"><h2>Track record, ${season}</h2>
    <p class="muted small" style="margin:4px 0 0">Every prediction below was made <i>before</i> the match was played, using only earlier matches. Brier score measures how good the probabilities are: 0.25 is a coin flip, lower is better.</p></div>
    <div class="card" style="margin-top:12px"><div class="table-wrap"><table>
      <thead><tr><th></th><th class="r">Matches</th><th class="r">Winner correct</th><th class="r">Brier</th><th class="r">Score error (avg)</th><th class="r hide-sm">Bonus RP Brier</th></tr></thead>
      <tbody>${row("all", "All matches")}${row("quals", "Qualifications")}${row("elims", "Playoffs")}${row("champs", "Championships")}</tbody>
    </table></div></div>
    ${meta.compare ? `
    <div class="card card-pad section">
      <h3>EPA vs OPR</h3>
      <h2 style="margin-top:6px">Better than the stat you're used to</h2>
      <p class="muted" style="max-width:760px">OPR is the stat FTCScout shows. For a fair test, before every match we computed OPR from the event's matches so far, blended with each team's OPR from earlier events, and predicted with it. Same matches, same rules.</p>
      <div class="grid cols-2" style="gap:24px;margin-top:8px">
        <table><thead><tr><th></th><th class="r">Winner correct</th><th class="r">Brier</th></tr></thead><tbody>
          <tr><td><b>EPA</b> (this site)</td><td class="r"><b>${pct(meta.compare.epa.accuracy, 1)}</b></td><td class="r"><b>${fmt(meta.compare.epa.brier, 3)}</b></td></tr>
          <tr><td>OPR</td><td class="r">${pct(meta.compare.opr.accuracy, 1)}</td><td class="r">${fmt(meta.compare.opr.brier, 3)}</td></tr>
        </tbody></table>
        <div><div class="small muted">Winners called, by month</div><div id="by-month"></div></div>
      </div>
    </div>` : ""}
    <div class="grid cols-2 section">
      <div class="card card-pad">
        <h3>Calibration</h3>
        <p class="small muted">When the model says the favourite has a 75% chance, does the favourite win about 75% of the time? Points on the line mean yes. Bigger dots are more matches.</p>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:340px">
          <line x1="30" y1="${H - 30}" x2="${W - 10}" y2="${H - 30}" stroke="var(--border)"/><line x1="30" y1="10" x2="30" y2="${H - 30}" stroke="var(--border)"/>
          <line x1="30" y1="${H - 30}" x2="${W - 10}" y2="10" stroke="var(--faint)" stroke-dasharray="4 4"/>
          ${[0.5, 0.75, 1].map((v) => `<text x="${30 + (v - 0.5) * 2 * (W - 40)}" y="${H - 12}" text-anchor="middle" fill="var(--faint)" font-size="11">${pct(v)}</text><text x="24" y="${H - 30 - (v - 0.5) * 2 * (H - 40) + 4}" text-anchor="end" fill="var(--faint)" font-size="11">${pct(v)}</text>`).join("")}
          <text x="${W / 2 + 10}" y="${H}" text-anchor="middle" fill="var(--muted)" font-size="11">predicted chance</text>
          ${cal}
        </svg>
      </div>
      <div class="card card-pad">
        <h3>Season reference</h3>
        <table><tbody>
          <tr><td class="muted">Top 1% EPA</td><td class="r">${epa(meta.percentiles.p99, meta)}</td></tr>
          <tr><td class="muted">Top 10%</td><td class="r">${epa(meta.percentiles.p90, meta)}</td></tr>
          <tr><td class="muted">Top 25%</td><td class="r">${epa(meta.percentiles.p75, meta)}</td></tr>
          <tr><td class="muted">Median</td><td class="r">${epa(meta.percentiles.p50, meta)}</td></tr>
          <tr><td class="muted">Avg alliance score now</td><td class="r">${fmt(meta.avgAlliance.np)}</td></tr>
          <tr><td class="muted">Data updated</td><td class="r small">${new Date(meta.generated).toLocaleString()}</td></tr>
        </tbody></table>
        <p class="small muted" style="margin-top:12px">Match data comes from the <a class="link" href="https://ftc-events.firstinspires.org/api">FIRST FTC Events API</a>, via the <a class="link" href="https://ftcscout.org">FTCScout</a> API.</p>
      </div>
    </div>`;
  const bm = meta.compare?.byMonth ?? [];
  if (bm.length > 1) {
    mountLineChart($("#by-month"), {
      series: [
        { name: "EPA", color: "var(--accent)", values: bm.map((m) => m.epa * 100), width: 2.5 },
        { name: "OPR", color: "var(--faint)", values: bm.map((m) => m.opr * 100) },
      ],
      bands: bm.map((m, i) => ({ from: i, to: i, label: new Date(`${m.month}-15`).toLocaleDateString(undefined, { month: "short" }) })),
      zero: false,
      tooltip: (i) => `<b>${new Date(`${bm[i].month}-15`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b><br>EPA ${pct(bm[i].epa, 1)} · OPR ${pct(bm[i].opr, 1)}<br>${fmtInt(bm[i].matches)} matches`,
    });
  }
}

// ---------------- boot ----------------

async function boot() {
  const theme = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  if (theme) document.documentElement.dataset.theme = theme;
  $("#theme").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", document.documentElement.dataset.theme); } catch {}
  };

  state.seasons = await data.seasons();
  // default to the newest season once it has enough matches to be useful
  const metas = await Promise.all(state.seasons.map((s) => data.meta(s)));
  state.defaultSeason = (metas.find((m) => m.matches >= 1000) ?? metas[0]).season;

  $("#season").onchange = (e) => {
    const r = parseHash();
    const keep = ["teams", "events", "predict", "about"].includes(r.page) ? r.page : r.page === "team" ? `team/${r.args[0]}` : "";
    location.hash = `#/${e.target.value}/${keep}`;
  };
  wireSearch($(".nav-search"));
  window.addEventListener("hashchange", route);
  route();
}

boot();
