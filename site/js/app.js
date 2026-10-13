import {
  $, $$, esc, data, fmt, pct, fmtInt, fmtDate, fmtRange, typeName, epa, teamCell, evCell,
  trend, matchTable, mountLineChart, sortableTable, meter, winBar,
} from "./ui.js";
import { SEASONS } from "./seasons.js";
import { initAnalytics, trackPage } from "./analytics.js";
import { fetchLiveEvent, normalizeLive, replayEvent, forecastRankings, forecastFromRoster, modelFromMeta } from "./live.js";

const app = $("#app");
const state = { seasons: [], defaultSeason: null, season: null, liveTimer: null, nav: 0 };
// true once the user has navigated away from the page that started loading
const stale = (r) => r.nav !== state.nav;
// today's date in the viewer's time zone, as YYYY-MM-DD
const localToday = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toLocaleDateString("en-CA");

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
  r.nav = ++state.nav;
  state.season = r.season;
  renderNav(r);
  window.scrollTo(0, 0);
  app.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    const pages = { "": home, teams, team, events, event, rankings, predict, stats, about };
    const fn = pages[r.page] ?? notFound;
    await fn(r);
    // tab title from the page heading, e.g. "20265 Heart of RoBots · FTCstats"
    const h1 = !stale(r) && $("#app h1, #app .hero-title");
    if (h1) document.title = r.page ? `${h1.textContent.trim().replace(/\s+/g, " ")} · FTCstats` : "FTCstats · FTC ratings & match predictions";
    if (!stale(r)) trackPage(`/${r.season}/${[r.page, ...r.args].filter(Boolean).join("/")}`, document.title);
  } catch (e) {
    console.error(e);
    if (!stale(r)) app.innerHTML = `<div class="card empty">Couldn't load this page. Check the link, or try another season.</div>`;
  }
}

function renderNav({ season, page }) {
  $("#season").innerHTML = state.seasons
    .map((s) => `<option value="${s}" ${s === season ? "selected" : ""}>${s}–${String(s + 1).slice(2)}${SEASONS[s]?.game ? ` · ${esc(SEASONS[s].game)}` : ""}</option>`)
    .join("");
  $$("header [data-page]").forEach((a) => {
    a.href = `#/${season}/${a.dataset.page}`;
    a.classList.toggle("active", a.dataset.page === page);
  });
  $(".logo").href = `#/${season}/`;
}

// Keep a page's filters in the URL so reloads and shared links keep them.
function syncQuery(params) {
  const [path] = location.hash.split("?");
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  history.replaceState(null, "", `${path}${q.toString() ? `?${q}` : ""}`);
}

// "2025–26 · DECODE", or just "2026–27" before the game name is known
const seasonLabel = (s, game) => `${s}–${String(s + 1).slice(2)}${game ? ` · ${esc(game)}` : ""}`;

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
  if (!wrap.dataset.wired) {
    wrap.dataset.wired = "1";
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) box.classList.remove("open"); });
  }
}

// ---------------- home ----------------

const SEARCH_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

async function home(r) {
  const { season } = r;
  const [meta, sum] = await Promise.all([data.meta(season), data.summary(season)]);
  if (stale(r)) return;
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
    const model = modelFromMeta(meta);
    for (const t of [t1, t2, t3, t4]) model.setTeam(t.team, { auto: t.auto, teleop: t.teleop, endgame: t.endgame, foul: t.foul, n: t.matches, rp: [t.rp0, t.rp1, t.rp2] });
    const p = model.predict([t1.team, t4.team], [t2.team, t3.team]);
    const side = (cls, ts) => `<div class="feature-side ${cls}">${ts.map((t) => `<a href="#/${season}/team/${t.team}">${t.team}</a><small>${esc(t.name)}</small>`).join("")}</div>`;
    feature = `<div class="feature">
      <div class="feature-head"><b>Dream match: the top 4, predicted</b><span>${seasonLabel(season, meta.game)}</span></div>
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
        <div class="eyebrow">${seasonLabel(season, meta.game)} season</div>
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
      <td class="small muted hide-sm">${esc(typeName(e.type))}</td>
      <td class="r">${e.ongoing ? '<span class="pill live">Live</span>' : epa(e.strength, meta)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

// ---------------- teams ----------------

async function teams(r) {
  const { season, query } = r;
  const [meta, rows] = await Promise.all([data.meta(season), data.teams(season)]);
  if (stale(r)) return;
  const rpNames = meta.rpNames;
  const countries = [...new Set(rows.map((r) => r.country).filter(Boolean))].sort();
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="filter" placeholder="Search teams…" value="${esc(query.get("q") ?? "")}">
        <select id="country" aria-label="Country"><option value="">All countries</option>${countries.map((c) => `<option ${c === query.get("country") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="minm" aria-label="Minimum matches played"><option value="1">Any number of matches</option><option value="10">Played 10+ matches</option><option value="25">Played 25+ matches</option></select>
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
    { key: "trend", label: "Trend", cls: "r small", render: (r) => `<span title="EPA change over the last 10 matches">${trend(r.trend)}</span>` },
  ];
  const table = sortableTable($("#tbl"), rows, cols, { sortKey: "np" });
  if (query.get("min")) $("#minm").value = query.get("min");
  const apply = () => {
    const q = $("#filter").value.trim().toLowerCase(), c = $("#country").value, m = +$("#minm").value;
    syncQuery({ q: $("#filter").value.trim(), country: c, min: m > 1 ? m : "" });
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

async function team(r) {
  const { season, args } = r;
  const n = /^\d{1,6}$/.test(args[0] ?? "") ? +args[0] : null, view = args[1] ?? "matches";
  if (n == null) { app.innerHTML = `<div class="card empty">That isn't a team number.</div>`; return; }
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

const shortEvent = (name) => name.replace(/\s+(Championship|Qualifier|Tournament)$/i, "").trim();

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

async function events(r) {
  const { season, query } = r;
  const [meta, evs] = await Promise.all([data.meta(season), data.events(season)]);
  if (stale(r)) return;
  if (stale(r)) return;
  const types = [...new Set(evs.map((e) => e.type))];
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="filter" placeholder="Search events…" value="${esc(query.get("q") ?? "")}">
        <select id="type"><option value="">All types</option>${types.map((t) => `<option value="${esc(t)}" ${t === query.get("type") ? "selected" : ""}>${esc(typeName(t))}</option>`).join("")}</select>
      </div>
      <div id="tbl"></div>
    </div>`;
  const cols = [
    { key: "name", label: "Event", sort: false, render: (e) => evCell(season, e.code, e.name, `${esc(e.loc)} ${e.ongoing ? '<span class="pill live">Live</span>' : ""}`) },
    { key: "start", label: "Date", cls: "small muted", render: (e) => fmtDate(e.start) },
    { key: "type", label: "Type", cls: "small muted hide-sm", render: (e) => esc(typeName(e.type)) },
    { key: "teams", label: "Teams", cls: "r hide-sm" },
    { key: "strength", label: "Strength", cls: "r", render: (e) => epa(e.strength, meta) },
    { key: "accuracy", label: "Called", cls: "r small hide-sm", render: (e) => pct(e.accuracy) },
  ];
  const table = sortableTable($("#tbl"), evs, cols, { sortKey: "start" });
  const apply = () => {
    const q = $("#filter").value.trim().toLowerCase(), ty = $("#type").value;
    syncQuery({ q: $("#filter").value.trim(), type: ty });
    table.setRows(evs.filter((e) => (!ty || e.type === ty) &&
      (!q || e.name.toLowerCase().includes(q) || e.code.toLowerCase().includes(q) || e.loc.toLowerCase().includes(q))));
  };
  $("#filter").oninput = apply; $("#type").onchange = apply;
  apply();
}

// ---------------- event ----------------

async function event(r) {
  const { season, args } = r;
  const code = args[0], tab = args[1] ?? "matches";
  const [meta, ev] = await Promise.all([data.meta(season), data.event(season, code).catch(() => null)]);
  if (stale(r)) return;
  if (!ev) {
    app.innerHTML = `<div class="card empty">No event with code “${esc(code)}” in ${seasonLabel(season, meta.game)}. <a class="link" href="#/${season}/events">Browse events →</a></div>`;
    return;
  }
  let matches = ev.matchList;
  let liveAt = null;

  // allow a day either side: event dates are local to the event, not the viewer
  const maybeLive = !ev.finished && ev.start <= localToday(1) && localToday(-1) <= ev.end;
  const refresh = async () => {
    try {
      const raw = await fetchLiveEvent(season, code);
      if (stale(r)) return clearInterval(state.liveTimer);
      matches = replayEvent(meta, ev, normalizeLive(season, raw, meta)).matches;
      for (const tp of raw.teams) {
        const row = ev.teamList.find((x) => x.team === tp.teamNumber);
        if (row && tp.stats) Object.assign(row, { rank: tp.stats.rank, wins: tp.stats.wins, losses: tp.stats.losses, ties: tp.stats.ties });
      }
      liveAt = new Date();
      // don't reset a forecast someone is looking at; it picks up new results on the next visit
      if (tab !== "forecast") draw();
    } catch (e) { console.warn(e); }
  };

  const draw = () => {
    const played = matches.filter((m) => m.played);
    const decided = played.filter((m) => m.pred && m.redScore.total !== m.blueScore.total);
    const correct = decided.filter((m) => (m.pred.pRed > 0.5) === (m.redScore.total > m.blueScore.total)).length;
    const upsets = decided.filter((m) => (m.pred.pRed > 0.5) !== (m.redScore.total > m.blueScore.total))
      .sort((a, b) => Math.abs(b.pred.pRed - 0.5) - Math.abs(a.pred.pRed - 0.5)).slice(0, 3);
    const hasQuals = matches.some((m) => m.level === "Quals");
    // forecast needs a quals schedule, or no matches yet (pre-event); playoff-only events get none
    const canForecast = hasQuals || (!matches.length && ev.teamList.length >= 4);
    const tabs = [["matches", "Matches"], ["teams", "Teams"], ...(canForecast ? [["forecast", "Rankings forecast"]] : [])];
    app.innerHTML = `
      <div class="card card-pad"><div class="page-head">
        <div>
          <div class="kicker">${esc(typeName(ev.type))} · ${fmtRange(ev.start, ev.end)} · ${esc(ev.loc)}</div>
          <h1>${esc(ev.name)}</h1>
          <div class="row" style="margin-top:8px">
            ${liveAt ? `<span class="pill live">Live · updated ${liveAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>` : ""}
            <span class="pill">${ev.teams} teams</span><span class="pill">${played.length}/${matches.length} matches played</span>
            <a class="pill" href="https://ftcscout.org/events/${season}/${encodeURIComponent(code)}" target="_blank" rel="noopener">FTCScout ↗</a>
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
    else if (tab === "forecast" && canForecast) eventForecast(season, meta, ev, matches);
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
  if (!quals.length) return rosterForecast(season, meta, ev);
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
        <div><b id="cut-title"></b><div class="small muted">${fmtInt(3000)} simulations of the qualification matches still to play, using ratings as of that moment. RS is ranking score.${finished ? " Drag back in time to see how the forecast compared to the final rankings." : ""}</div></div>
        <input type="range" id="cut" min="0" max="${quals.length}" value="${cutoff}" style="width:min(320px,100%)">
      </div>
    </div>
    <div class="card section" id="fc"></div>`;

  const title = () => {
    $("#cut-title").textContent = cutoff === 0 ? "Forecast when the schedule was released"
      : cutoff >= quals.length ? `All ${quals.length} qualification matches played` : `Forecast after ${quals[cutoff - 1].d}`;
  };
  const run = () => {
    title();
    const replayed = replayEvent(meta, ev, matches.map((m) => ({ ...m, played: m.actuallyPlayed ?? m.played })), cutoff).matches;
    const rows = forecastRankings(season, teams, replayed);
    const showFinal = ev.teamList.some((t) => t.rank != null) && playedQuals > 0;
    $("#fc").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Proj.</th><th>Team</th><th class="r">Current RS</th><th class="r">Proj. RS</th><th class="r">Avg rank</th><th class="r">#1</th><th class="r">Top 4</th><th class="r hide-sm">Top 8</th>${showFinal ? '<th class="r">Actual rank</th>' : ""}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="faint num">${i + 1}</td>
        <td>${teamCell(season, r.team, names.get(r.team))}</td>
        <td class="r small">${r.currentRs != null ? fmt(r.currentRs, 2) : "–"} <span class="faint" title="matches played">(${r.played} played)</span></td>
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
    title();
    clearTimeout(pending);
    pending = setTimeout(run, 60);
  };
  run();
}

// Before the schedule is out: simulate random FTC schedules from the team list.
function rosterForecast(season, meta, ev) {
  let perTeam = 5;
  $("#tab").innerHTML = `
    <div class="card card-pad">
      <div class="row" style="justify-content:space-between">
        <div><b>Predicted rankings before the schedule is released</b>
          <div class="small muted">2,000 random qualification schedules, each played out from every team's rating entering the event.${unrated ? ` ${unrated} of ${ev.teamList.length} teams haven't played this season yet, so their rating comes from past seasons (rookies start just below average). Expect early forecasts to be rough.` : ""}</div></div>
        <label class="row small">Matches per team
          <select id="per">${[4, 5, 6, 7, 8].map((n) => `<option ${n === perTeam ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      </div>
    </div>
    <div class="card section" id="fc"></div>`;
  const names = new Map(ev.teamList.map((t) => [t.team, t.name]));
  const unrated = ev.teamList.filter((t) => !t.state || t.state.n === 0).length;
  const run = () => {
    const rows = forecastFromRoster(season, meta, ev, { perTeam });
    $("#fc").innerHTML = rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Proj.</th><th>Team</th><th class="r">EPA</th><th class="r">Avg rank</th><th class="r">#1</th><th class="r">Top 4</th><th class="r hide-sm">Top 8</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="faint num">${i + 1}</td>
        <td>${teamCell(season, r.team, names.get(r.team))}</td>
        <td class="r">${epa(r.epa, meta)}</td>
        <td class="r">${fmt(r.meanRank, 1)}</td>
        <td class="r">${probCell(r.p1)}</td>
        <td class="r">${probCell(r.p4)}</td>
        <td class="r hide-sm">${probCell(r.p8)}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="empty">Not enough teams registered yet.</div>`;
  };
  $("#per").onchange = (e) => { perTeam = +e.target.value; run(); };
  run();
}

// ---------------- rankings predictor ----------------

async function rankings(r) {
  const { season } = r;
  const [meta, evs, bt] = await Promise.all([data.meta(season), data.events(season), data.ranking(season)]);
  if (stale(r)) return;
  const upcoming = evs.filter((e) => !e.finished && e.teams >= 4 && e.end >= localToday(-1)).sort((a, b) => a.start.localeCompare(b.start));
  const recent = evs.filter((e) => e.finished && e.teams >= 12).slice(0, 12);
  const list = (rows, empty) => rows.length ? `<div class="table-wrap"><table><tbody>${rows.map((e) => `
    <tr><td>${evCell(season, e.code, e.name, `${fmtRange(e.start, e.end)} · ${esc(e.loc)}`)}</td>
    <td class="small muted hide-sm">${esc(typeName(e.type))}</td><td class="r hide-sm">${e.teams} teams</td>
    <td class="r">${e.ongoing ? '<span class="pill live">Live</span> ' : ""}<a class="link" href="#/${season}/event/${encodeURIComponent(e.code)}/forecast">Predict →</a></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">${empty}</div>`;
  const pctOrDash = (x) => (x == null ? "–" : pct(x));
  app.innerHTML = `
    <div class="card card-pad">
      <div class="eyebrow">${seasonLabel(season, meta.game)}</div>
      <h1 style="margin-top:8px">Rankings predictor</h1>
      <p class="muted" style="max-width:760px;margin:8px 0 0">Who will finish where after qualifications? Before the schedule is out, we simulate thousands of random schedules from the team list. Once it's out, we play the real schedule. During the event, results are locked in as matches finish.</p>
    </div>
    ${bt ? `<div class="card card-pad section">
      <h3>Track record, ${bt.events} events</h3>
      <p class="small muted" style="margin:6px 0 10px">Predictions made with only what was known the morning each event started, compared with the final rankings.</p>
      <div class="table-wrap"><table><thead><tr><th></th><th class="r">Rank correlation</th><th class="r">Top 4 found</th><th class="r">Winner in predicted top 4</th></tr></thead><tbody>
        <tr><td><b>With the real schedule</b></td><td class="r"><b>${fmt(bt.schedule.spearman, 2)}</b></td><td class="r"><b>${pctOrDash(bt.schedule.top4)}</b></td><td class="r"><b>${pctOrDash(bt.schedule.firstInTop4)}</b></td></tr>
        <tr><td>Team list only (random schedules)</td><td class="r">${fmt((bt.noBonus ?? bt.random).spearman, 2)}</td><td class="r">${pctOrDash((bt.noBonus ?? bt.random).top4)}</td><td class="r">${pctOrDash((bt.noBonus ?? bt.random).firstInTop4)}</td></tr>
      </tbody></table></div>
    </div>` : ""}
    <div class="section-title"><div class="eyebrow">Upcoming</div><h2>Predict an upcoming event</h2></div>
    <div class="card">${list(upcoming, "No upcoming events with registered teams yet.")}</div>
    <div class="section-title"><div class="eyebrow">Look back</div><h2>Recent events</h2><p class="muted" style="margin:6px 0 0">Rewind any finished event and compare the forecast with how it turned out.</p></div>
    <div class="card">${list(recent, "No finished events yet.")}</div>`;
}

const probCell = (p) => {
  if (p < 0.005) return `<span class="faint">–</span>`;
  // strong odds get solid FIRST blue with white text; weaker odds a light tint with dark text
  const style = p >= 0.5 ? "background:#0066b3;color:#fff" : `background:color-mix(in srgb,#0066b3 ${Math.round(8 + p * 40)}%,transparent);color:var(--text)`;
  return `<span class="epa" style="${style}">${pct(p)}</span>`;
};

// ---------------- predictor ----------------

async function predict(r) {
  const { season, query } = r;
  const [meta, teams] = await Promise.all([data.meta(season), data.teams(season)]);
  if (stale(r)) return;
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
    const nums = { r: [], b: [] }, raw = { r: [], b: [] }, seen = new Set();
    $$(".predictor input").forEach((el) => {
      const v = el.value.trim(), side = el.dataset.side;
      raw[side].push(v);
      const t = /^\d{1,6}$/.test(v) ? byNum.get(+v) : null;
      let msg = "";
      if (!v) msg = "";
      else if (!/^\d{1,6}$/.test(v)) msg = `<span class="faint">Not a team number</span>`;
      else if (!t) msg = `<span class="faint">No ${season} matches for team ${esc(v)}</span>`;
      else if (seen.has(+v)) msg = `<span class="faint">Already picked</span>`;
      else { msg = `${esc(t.name)} · EPA ${fmt(t.np)}`; nums[side].push(+v); seen.add(+v); }
      $(`#who-${side}${el.dataset.i}`).innerHTML = msg;
    });
    syncQuery({ r: raw.r.filter(Boolean).join(","), b: raw.b.filter(Boolean).join(",") });
    if (!nums.r.length || !nums.b.length) {
      $("#out").innerHTML = `<div class="card empty">Enter at least one team on each side.</div>`;
      return;
    }
    const model = modelFromMeta(meta);
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

// ---------------- season stats ----------------

async function stats(r) {
  const { season } = r;
  const [meta, st] = await Promise.all([data.meta(season), data.stats(season).catch(() => null)]);
  if (stale(r)) return;
  if (!st) { app.innerHTML = `<div class="card empty">No stats for this season yet.</div>`; return; }
  const ev = (x) => `<a href="#/${season}/event/${encodeURIComponent(x.ev)}" class="small muted">${esc(x.evName)} · ${esc(x.d)}</a>`;
  const tl = (nums, side) => `<span class="alliance">${nums.map((n) => `<a class="tn ${side}" href="#/${season}/team/${n}">${n}</a>`).join(" ")}</span>`;
  const score = (x) => `<span class="final"><span class="${x.rs > x.bs ? "w" : "l"}">${x.rs}</span><span class="faint">–</span><span class="${x.bs > x.rs ? "w" : "l"}">${x.bs}</span></span>`;
  const chance = (p) => (p < 0.001 ? "under 0.1%" : pct(p, p < 0.1 ? 1 : 0));
  const card = (eyebrow, title, note, body) => `<div class="card stat-card">
    <div class="card-head"><div><div class="eyebrow">${eyebrow}</div><h2 style="margin-top:4px">${title}</h2>${note ? `<div class="small muted" style="margin-top:2px">${note}</div>` : ""}</div></div>
    <div class="table-wrap"><table><tbody>${body}</tbody></table></div></div>`;
  const teamList = (rows, val) => rows.map((t, i) => `<tr><td class="faint num" style="width:28px">${i + 1}</td><td>${teamCell(season, t.team, t.name)}</td><td class="r">${val(t)}</td></tr>`).join("");
  const matchRows = (rows, val) => rows.map((x) => `<tr><td>${ev(x)}<div>${tl(x.red, "red")} <span class="faint">vs</span> ${tl(x.blue, "blue")}</div></td><td class="r">${val(x)}</td></tr>`).join("");
  const sideRows = (rows) => rows.map((x) => `<tr><td>${ev(x)}<div>${tl(x.teams, x.side)}</div></td><td class="r"><b>${x.value}</b></td></tr>`).join("");
  const evRows = (rows) => rows.map((e) => `<tr><td>${evCell(season, e.code, e.name, `${e.played} matches`)}</td><td class="r"><b>${pct(e.accuracy)}</b></td></tr>`).join("");

  app.innerHTML = `
    <div class="card card-pad">
      <div class="eyebrow">${seasonLabel(season, meta.game)}</div>
      <h1 style="margin-top:8px">Season stats</h1>
      <p class="muted" style="margin:8px 0 0;max-width:760px">Records, leaders and surprises from ${fmtInt(meta.matches)} matches. Scores here leave out penalty points, so records are what alliances actually scored.</p>
    </div>
    <div class="grid cols-2 section stats-grid">
      ${card("Upsets", "Biggest upsets", "the winner's chance before the match", matchRows(st.upsets, (x) => `${score(x)}<div class="small"><b>${chance(x.pWin)}</b></div>`))}
      ${card("Records", "Highest alliance scores", "without penalty points", sideRows(st.highest.np))}
      ${card("Records", "Highest auto scores", "", sideRows(st.highest.auto))}
      ${card("Records", "Biggest blowouts", "winning margin without penalties", matchRows(st.blowouts, (x) => `${score(x)}<div class="small"><b>+${x.margin}</b></div>`))}
      ${card("Playoffs", "Closest playoff matches", "", matchRows(st.closest, score))}
      ${card("Leaders", "Best auto", "auto EPA", teamList(st.leaders.auto, (t) => epa(t.value, meta)))}
      ${card("Leaders", "Best teleop", "teleop EPA", teamList(st.leaders.teleop, (t) => epa(t.value, meta)))}
      ${card("Leaders", "Best endgame", "endgame EPA", teamList(st.leaders.endgame, (t) => epa(t.value, meta)))}
      ${card("Improvement", "Biggest improvers", "EPA after their 3rd match → now", teamList(st.risers, (t) => `${fmt(t.from)} → <b>${fmt(t.to)}</b>`))}
      ${card("Records", "Best records", "20+ matches, all match types", teamList(st.records, (t) => `<b>${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}</b> <span class="faint">${pct(t.pct)}</span>`))}
      ${card("Luck or clutch?", "Won more than expected", "actual wins vs the sum of their pre-match win chances", teamList(st.over, (t) => `<b class="trend-up">+${fmt(t.diff)}</b> <span class="faint small">${t.wins} vs ${fmt(t.expected)}</span>`))}
      ${card("Luck or clutch?", "Won fewer than expected", "", teamList(st.under, (t) => `<b class="trend-down">${fmt(t.diff)}</b> <span class="faint small">${t.wins} vs ${fmt(t.expected)}</span>`))}
      ${card("Regions", "Strongest countries", "median EPA, countries with 15+ active teams", st.countries.map((c, i) => `<tr><td class="faint num" style="width:28px">${i + 1}</td><td><b>${esc(c.country)}</b> <span class="small muted">${c.teams} teams</span></td><td class="r">${epa(c.median, meta)}</td></tr>`).join(""))}
      ${card("Events", "Most unpredictable events", "share of winners called, 30+ matches", evRows(st.events.unpredictable))}
      ${card("Events", "Most predictable events", "", evRows(st.events.predictable))}
    </div>`;
}

// ---------------- about / accuracy ----------------

async function about(r) {
  const { season } = r;
  const [meta, bt] = await Promise.all([data.meta(season), data.ranking(season)]);
  if (stale(r)) return;
  const a = meta.accuracy, c = meta.compare;
  const row = (k, label) => a[k] ? `<tr><td>${label}</td><td class="r">${fmtInt(a[k].matches)}</td><td class="r"><b>${pct(a[k].accuracy, 1)}</b></td><td class="r">${fmt(a[k].brier, 3)}</td><td class="r hide-sm">${fmt(a[k].scoreMae)}</td>${meta.rpNames.length ? `<td class="r hide-sm">${a[k].rpBrier != null ? fmt(a[k].rpBrier, 3) : "–"}</td>` : ""}</tr>` : "";
  const cmpRow = (k, name, note) => c?.[k] ? `<tr><td>${k === "epa" ? `<b>${name}</b>` : name}<div class="small muted">${note}</div></td><td class="r">${k === "epa" ? `<b>${pct(c[k].accuracy, 1)}</b>` : pct(c[k].accuracy, 1)}</td><td class="r">${fmt(c[k].brier, 3)}</td></tr>` : "";
  const solo = (meta.solo ?? []).map((x) => esc(x.label ?? x.robots[0])).join(", ");

  // calibration plot: predicted chance (x) vs how often the favourite won (y), 50-100%
  const W = 320, H = 260, L = 44, R = 12, T = 12, B = 40;
  const px = (v) => L + ((v - 0.5) / 0.5) * (W - L - R), py = (v) => H - B - ((v - 0.5) / 0.5) * (H - T - B);
  const ticks = [0.5, 0.75, 1].map((v) => `
    <line x1="${px(v)}" x2="${px(v)}" y1="${T}" y2="${H - B}" stroke="var(--line)"/><line x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}" stroke="var(--line)"/>
    <text x="${px(v)}" y="${H - B + 16}" text-anchor="middle" fill="var(--muted)" font-size="11">${pct(v)}</text>
    <text x="${L - 6}" y="${py(v) + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${pct(v)}</text>`).join("");
  const dots = a.calib.filter((b) => b.bin >= 0.5).map((b) => `<circle cx="${px(b.bin + 0.05)}" cy="${py(Math.max(0.5, b.winRate))}" r="${3 + Math.sqrt(b.n) / 30}" fill="var(--accent)" fill-opacity=".85"><title>Predicted ${pct(b.bin)}–${pct(b.bin + 0.1)}: favourite won ${pct(b.winRate, 1)} of ${fmtInt(b.n)} matches</title></circle>`).join("");

  app.innerHTML = `
    <div class="card card-pad"><div class="prose">
      <div class="eyebrow">${seasonLabel(season, meta.game)}</div>
      <h1 style="margin-top:8px">How the predictions work</h1>
      <p>Every team has an <b>EPA</b>, short for <i>Expected Points Added</i>: the points it adds to its alliance's score in an average match right now, split into auto, teleop and endgame. An alliance's predicted score is the sum of its two teams' EPAs, and the gap between the two alliances gives the win chance.</p>
      <p><b>Why EPA?</b> It's measured in points, so it means something on its own ("this team adds about 45 points a match"), it splits into auto, teleop and endgame, and it updates after every match. The name comes from <a class="link" href="https://www.statbotics.io">Statbotics</a>, the FRC site that introduced it. The model here goes further, for FTC: the extras below, each kept only because it predicted better on seasons it wasn't tuned on.</p>
      <ul class="muted">
        <li><b>Credit by robot.</b> Points the game manual scores per robot go to the robot that earned them instead of being split${solo ? ` (this season: ${solo})` : ""}. Point values are learned from the data and match each manual.</li>
        <li><b>Auto movement.</b> A robot that didn't move in auto gets little of its alliance's auto credit: alliances where neither robot moves score almost nothing else in auto.</li>
        <li><b>How sure we are.</b> A team we've seen a lot moves a little after a match; a new team, or one at its first event in weeks, moves more, and a well-known partner doesn't soak up an unknown partner's surprise.</li>
        <li><b>Starting ratings</b> blend the last three seasons, weighted to the most recent; rookies start a little below average.</li>
        <li><b>Penalties</b> are left out of ratings (they say more about the opponent) but count when deciding who won.</li>
      </ul>
    </div></div>

    ${c ? `<div class="section-title"><div class="eyebrow">Is EPA the best rating?</div><h2>Compared with the alternatives, ${season}</h2>
      <p class="muted" style="margin:6px 0 0;max-width:760px">Every rating predicted the same ${fmtInt(a.all.matches)} matches, each using only what was known before the match. Brier score measures the win chances themselves: 0.25 is a coin flip, lower is better.</p></div>
    <div class="grid cols-2">
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Rating</th><th class="r">Winner correct</th><th class="r">Brier</th></tr></thead><tbody>
        ${cmpRow("epa", "EPA (this site)", "points added, per robot, updated every match")}
        ${cmpRow("opr", "OPR, updated live", "what FTCScout shows, re-solved before every match")}
        ${cmpRow("avg", "Average score so far", "each team's average alliance score")}
        ${cmpRow("elo", "Elo", "wins and losses only, like chess ratings")}
      </tbody></table></div></div>
      <div class="card card-pad"><div class="small muted">Winners called by month: EPA vs OPR</div><div id="by-month"></div></div>
    </div>` : ""}

    <div class="section-title"><div class="eyebrow">Track record</div><h2>How EPA did in ${season}</h2></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th></th><th class="r">Matches</th><th class="r">Winner correct</th><th class="r">Brier</th><th class="r hide-sm">Score error (avg pts)</th>${meta.rpNames.length ? '<th class="r hide-sm">Bonus RP Brier</th>' : ""}</tr></thead>
      <tbody>${row("all", "All matches")}${row("quals", "Qualifications")}${row("elims", "Playoffs")}${row("champs", "Championships")}</tbody>
    </table></div></div>

    <div class="grid cols-2 section">
      <div class="card card-pad">
        <h3>Calibration</h3>
        <p class="small muted">When EPA gives the favourite a 75% chance, does the favourite win about 75% of the time? Dots on the dashed line mean yes; bigger dots are more matches.</p>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block;margin:6px auto 0" role="img" aria-label="Calibration plot">
          ${ticks}
          <line x1="${px(0.5)}" y1="${py(0.5)}" x2="${px(1)}" y2="${py(1)}" stroke="var(--faint)" stroke-dasharray="4 4"/>
          <text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="11">predicted chance for the favourite</text>
          <text x="12" y="${(T + H - B) / 2}" text-anchor="middle" fill="var(--muted)" font-size="11" transform="rotate(-90 12 ${(T + H - B) / 2})">how often it won</text>
          ${dots}
        </svg>
      </div>
      <div class="card card-pad">
        <h3>Season reference</h3>
        <table class="ref"><tbody>
          <tr><td class="muted">Top 1% EPA</td><td class="r">${epa(meta.percentiles.p99, meta)}</td></tr>
          <tr><td class="muted">Top 10%</td><td class="r">${epa(meta.percentiles.p90, meta)}</td></tr>
          <tr><td class="muted">Top 25%</td><td class="r">${epa(meta.percentiles.p75, meta)}</td></tr>
          <tr><td class="muted">Median team</td><td class="r">${epa(meta.percentiles.p50, meta)}</td></tr>
          <tr><td class="muted">Average alliance score now</td><td class="r">${fmt(meta.avgAlliance.np)}</td></tr>
          ${bt ? `<tr><td class="muted">Ranking forecasts checked on</td><td class="r"><a class="link" href="#/${season}/rankings">${fmtInt(bt.events)} events →</a></td></tr>` : ""}
          <tr><td class="muted">Data updated</td><td class="r small">${new Date(meta.generated).toLocaleString()}</td></tr>
        </tbody></table>
      </div>
    </div>

    <div class="card card-pad section"><div class="prose">
      <h3>Tried and dropped</h3>
      <p class="small muted" style="margin-top:6px">Ideas that sounded right but didn't predict better on held-out seasons, so they're not in the model: per-team foul ratings; less teleop credit for robots that skipped the endgame (strong robots often skip parking to keep scoring); treating robots that neither moved nor parked as broken; blending EPA with OPR; a defense term; bonus-RP chances in pre-schedule ranking forecasts.</p>
    </div></div>`;

  const bm = c?.byMonth ?? [];
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
  initAnalytics();
  const theme = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  if (theme) document.documentElement.dataset.theme = theme;
  const isDark = () => document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const label = () => $("#theme").setAttribute("aria-label", isDark() ? "Switch to light mode" : "Switch to dark mode");
  label();
  $("#theme").onclick = () => {
    document.documentElement.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("theme", document.documentElement.dataset.theme); } catch {}
    label();
  };

  state.seasons = await data.seasons();
  // default to the newest season once it has enough matches to be useful
  const metas = await Promise.all(state.seasons.map((s) => data.meta(s)));
  state.defaultSeason = (metas.find((m) => m.matches >= 1000) ?? metas[0]).season;

  $("#season").onchange = (e) => {
    const r = parseHash();
    // stay on the same kind of page; event codes differ by season, so events go to the list
    const q = r.query.toString();
    const keep = {
      teams: "teams", events: "events", rankings: "rankings", about: "about", event: "events",
      predict: `predict${q ? `?${q}` : ""}`,
      team: `team/${r.args.join("/")}`,
    }[r.page] ?? "";
    location.hash = `#/${e.target.value}/${keep}`;
  };
  wireSearch($(".nav-search"));
  window.addEventListener("hashchange", route);
  route();
}

boot();
