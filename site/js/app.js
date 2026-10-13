import {
  $, $$, esc, data, getJSON, fmt, pct, fmtInt, fmtDate, fmtRange, typeName, epa, teamCell, evCell,
  trend, matchTable, mountLineChart, sortableTable, meter, winBar, videoFor, PLAY_ICON } from "./ui.js";
import { SEASONS } from "./seasons.js";
import { playoffs } from "./playoffs.js";
import { initAnalytics, trackPage } from "./analytics.js";
import { CONFIG } from "./config.js";
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
    const pages = { "": home, teams, team, events, event, about };
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
      <div class="feature-foot">${winBar(p.pRed)}<p>Red wins ${pct(p.pRed)} of the time.</p></div>
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
          <a class="btn btn-outline" href="#/${season}/about">Our methodology</a>
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
          <div class="card">${eventList(season, meta, (live.length ? live : recent).slice(0, 8))}<a class="more" href="#/${season}/events">All events →</a></div>
        </div>
      </div>
      <div class="section-title"><div class="eyebrow">Competition</div><h2>Strongest events</h2><p class="muted" style="margin:6px 0 0">Ranked by the average EPA of each event's top 8 teams.</p></div>
      <div class="card">${eventList(season, meta, strongest)}</div>
    </div>`;
  wireSearch($("#hero-search"));
  // two-line rows (team, then location) so they line up with the events list beside it
  $("#top-teams").innerHTML = `<div class="table-wrap"><table class="home-list"><tbody>${teams.slice(0, 8).map((t) => `
    <tr><td class="faint num" style="width:32px">${t.rank}</td>
    <td><a class="ev-cell" href="#/${season}/team/${t.team}"><span class="n">${t.team} ${esc(t.name)}</span><span class="nm">${esc(t.loc)}</span></a></td>
    <td class="r">${epa(t.np, meta)}</td></tr>`).join("")}</tbody></table></div>`;
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
  // "Season only": ratings and records from official events, ignoring off-season events
  const seasonRows = rows.filter((r) => r.matchesS > 0)
    .map((r) => ({ ...r, np: r.npS, auto: r.autoS, teleop: r.teleopS, endgame: r.endgameS, matches: r.matchesS, wins: r.winsS, losses: r.lossesS, ties: r.tiesS, trend: null }))
    .sort((a, b) => b.np - a.np).map((r, i) => ({ ...r, rank: i + 1 }));
  let scope = query.get("scope") === "all" ? "all" : "season"; // official events by default
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="filter" placeholder="Search teams…" value="${esc(query.get("q") ?? "")}">
        <select id="country" aria-label="Country"><option value="">All countries</option>${countries.map((c) => `<option ${c === query.get("country") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="minm" aria-label="Minimum matches played"><option value="1">Any number of matches</option><option value="10">Played 10+ matches</option><option value="25">Played 25+ matches</option></select>
        <div class="seg scope" role="group" aria-label="Which events count">
          <a href="#" data-scope="season" title="Ratings as of each team's last official event; off-season events ignored">Season only</a>
          <a href="#" data-scope="all" title="Ratings from every event, including off-season ones">All events</a>
        </div>
        <span class="small muted" id="count"></span>
        <a class="small link" href="#/${season}/about" style="margin-left:auto">Our methodology</a>
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
    syncQuery({ q: $("#filter").value.trim(), country: c, min: m > 1 ? m : "", scope: scope === "all" ? "all" : "" });
    $$(".scope a").forEach((a) => a.classList.toggle("active", a.dataset.scope === scope));
    const shown = (scope === "season" ? seasonRows : rows).filter((r) =>
      (!c || r.country === c) && r.matches >= m &&
      (!q || String(r.team).startsWith(q) || r.name.toLowerCase().includes(q) || r.loc.toLowerCase().includes(q)));
    $("#count").textContent = `${fmtInt(shown.length)} teams`;
    table.setRows(shown);
  };
  $("#filter").oninput = apply; $("#country").onchange = apply; $("#minm").onchange = apply;
  $(".scope").onclick = (e) => {
    const a = e.target.closest("[data-scope]");
    if (!a) return;
    e.preventDefault();
    scope = a.dataset.scope;
    apply();
  };
  apply();
}

// ---------------- team ----------------

async function team(r) {
  const { season, args } = r;
  const n = /^\d{1,6}$/.test(args[0] ?? "") ? +args[0] : null, view = args[1] ?? "matches";
  if (n == null) { app.innerHTML = `<div class="card empty">That isn't a team number.</div>`; return; }
  // just the season summary and this team's file: ranks and meter scales are precomputed
  const [meta, t, videos] = await Promise.all([data.meta(season), data.team(season, n).catch(() => null), data.videos(season)]);
  if (stale(r)) return;
  if (!t) {
    app.innerHTML = `<div class="card empty">Team ${n} has no matches in ${season}. ${state.seasons.filter((s) => s !== season).map((s) => `<a class="link" href="#/${s}/team/${n}">Try ${s}</a>`).join(" ")}</div>`;
    return;
  }
  const evName = new Map((t.events ?? []).map((e) => [e.code, e.name]));
  const e = t.epa;
  const w = t.matches.filter((m) => m.score > m.oppScore).length;
  const l = t.matches.filter((m) => m.score < m.oppScore).length;
  const ti = t.matches.length - w - l;
  const decided = t.matches.filter((m) => m.score !== m.oppScore);
  const correct = decided.filter((m) => (m.pWin > 0.5) === (m.score > m.oppScore)).length;

  // rank tiles: world, country, state/province (precomputed by the build)
  const tile = (rank, label, of) => `<div class="tile"><b>#${rank}</b><div class="k">${esc(label)}</div><div class="s">out of ${fmtInt(of)}</div></div>`;
  const places = t.places ?? {};
  const tiles = [
    tile(t.rank, "World", t.of),
    places.country ? tile(places.country[1], places.country[0], places.country[2]) : "",
    places.state ? tile(places.state[1], places.state[0], places.state[2]) : "",
  ].join("");

  const mm = meta.meterMax ?? { np: e.np, auto: e.auto, teleop: e.teleop, endgame: e.endgame };
  const max = (k) => mm[k];
  const top = { np: mm.np };

  app.innerHTML = `
    <div class="card card-pad"><div class="team-head"><div class="team-main">
      <div class="page-head">
        <div>
          <h1><span class="team-num">${n}</span> ${esc(t.name)}</h1>
          <div class="muted" style="margin-top:4px">${esc(t.loc)}${t.rookie ? ` · Rookie year ${t.rookie}` : ""}</div>
          <div class="small muted" style="margin-top:2px">#${fmtInt(t.rank)} of ${fmtInt(t.of)} · ${w}-${l}${ti ? `-${ti}` : ""} · ${t.matches.length ? pct(w / t.matches.length) : "–"} win rate · predicted ${decided.length ? pct(correct / decided.length) : "–"} of its matches</div>
        </div>
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
    </div>${teamPhotos(n, [])}</div></div>
    <div class="tiles-row section">${trophyCase(season, t.awards ?? []).replace(TILES_SLOT, tiles)}</div>
    <div class="row section" style="justify-content:space-between">
      <nav class="seg glass">
        <a href="#/${season}/team/${n}" class="${view === "matches" ? "active" : ""}">Matches</a>
        <a href="#/${season}/team/${n}/charts" class="${view === "charts" ? "active" : ""}">Charts</a>
      </nav>
    </div>
    <div id="view"></div>`;

  // photos come from a separate service; show the page now and add them when they arrive
  data.photos(CONFIG.photoApi).then((p) => {
    const box = $(".team-photo");
    if (!stale(r) && box && p[n]?.length) box.outerHTML = teamPhotos(n, p[n]);
  }).catch(() => {});

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
    const video = (m) => videoFor(videos, ev.code, m.time);
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
          <div><span class="k">EPA out</span><b>${fmt(ev.epaEnd)}${ev.epaStart != null && ev.epaEnd != null && Math.abs(ev.epaEnd - ev.epaStart) >= 0.5 ? `<span class="delta ${ev.epaEnd > ev.epaStart ? "trend-up" : "trend-down"}">${ev.epaEnd > ev.epaStart ? "▲" : "▼"}</span>` : ""}</b></div>
        </div>
      </div>
      ${matchTable(season, ms, { me: n, rpNames: meta.rpNames, video })}
    </div>`;
  }).join("");
}

// Team photo area: approved photos (click to see the next one), or an invite to add one.
const PHOTO_FORM = "https://github.com/Katluver44/FTCstats/issues/new?template=team-photo.yml";
function teamPhotos(n, list) {
  const add = CONFIG.photoApi ? `#upload-${n}` : `${PHOTO_FORM}&title=${encodeURIComponent(`Photo for team ${n}`)}&team=${n}`;
  const target = CONFIG.photoApi ? "" : ' target="_blank" rel="noopener"';
  if (!list.length) {
    return `<aside class="team-photo empty-photo"><a href="${add}" data-upload="${n}"${target}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="12" cy="12.5" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/></svg>
      <b>Add a photo</b><span class="small muted">Robot photos welcome. Shown after review.</span></a></aside>`;
  }
  const items = list.map((p, i) => `<figure class="${i ? "" : "on"}"><img src="${esc(p.file)}" alt="Team ${n}${p.caption ? `: ${esc(p.caption)}` : ""}" loading="lazy"><figcaption>${[p.caption && esc(p.caption), p.credit && `photo by ${esc(p.credit)}`].filter(Boolean).join(" · ")}</figcaption></figure>`).join("");
  return `<aside class="team-photo" data-count="${list.length}">${items}
    <div class="photo-bar">${list.length > 1 ? `<button class="photo-next" aria-label="Next photo">${list.length} photos ›</button>` : ""}<a class="small link" href="${add}" data-upload="${n}"${target}>Add a photo</a></div></aside>`;
}

// Upload dialog: shrink the photo in the browser (which also drops GPS and
// other metadata), then send it to the photo service for review.
function openUpload(team) {
  const dlg = document.createElement("dialog");
  dlg.className = "upload-dialog";
  dlg.innerHTML = `<form method="dialog">
    <h2>Add a photo for team ${esc(team)}</h2>
    <p class="small muted">Robot photos are best. Only post people who agreed to it (a parent or guardian for anyone under 18). Photos appear after review.</p>
    <input type="file" accept="image/jpeg,image/png,image/webp" required>
    <input type="text" maxlength="140" placeholder="Caption (optional)" class="cap">
    <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <label class="small"><input type="checkbox" required> I took this photo or have permission to share it.</label>
    <div class="msg small"></div>
    <div class="row"><button value="cancel" formnovalidate class="btn btn-outline">Cancel</button><button value="send" class="btn btn-solid">Upload</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const form = dlg.querySelector("form"), msg = dlg.querySelector(".msg");
  form.addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "send") return;
    e.preventDefault();
    const file = form.querySelector('input[type="file"]').files[0];
    if (!file) return;
    msg.textContent = "Uploading…";
    try {
      const blob = await shrinkImage(file, 1600, 0.85);
      const res = await fetch(`${CONFIG.photoApi}/api/upload`, {
        method: "POST", body: blob,
        headers: { "Content-Type": "image/jpeg", "X-Team": team, "X-Caption": encodeURIComponent(form.querySelector(".cap").value), "X-Website": form.querySelector(".hp").value },
      });
      const out = await res.json().catch(() => ({}));
      msg.textContent = res.ok ? out.message ?? "Thanks! Your photo will appear after review." : out.error ?? "Upload failed.";
      if (res.ok) setTimeout(() => dlg.close(), 2500);
    } catch {
      msg.textContent = "Couldn't read that image. Try a JPG or PNG.";
    }
  });
  dlg.addEventListener("close", () => dlg.remove());
}

// Draw the photo at most `max` px wide/tall and re-encode as JPEG.
async function shrinkImage(file, max, quality) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail()), "image/jpeg", quality));
}

// Award names for the trophy case tooltips.
const AWARD_NAMES = {
  Inspire: "Inspire Award", Think: "Think Award", Connect: "Connect Award", Innovate: "Innovate Award",
  Control: "Control Award", Motivate: "Motivate Award", Design: "Design Award", Reach: "Reach Award",
  Sustain: "Sustain Award", Promote: "Promote Award", Compass: "Compass Award", JudgesChoice: "Judges' Choice",
  Winner: "Winning Alliance", Finalist: "Finalist Alliance", DivisionWinner: "Division Winner",
  DivisionFinalist: "Division Finalist", ConferenceFinalist: "Conference Finalist", TopRanked: "Top Ranked",
  DeansListWinner: "Dean's List Winner", DeansListFinalist: "Dean's List Finalist", DeansListSemiFinalist: "Dean's List Semi-Finalist",
};
const ordinal = (n) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

// Trophy case beside the rank tiles: plaques for judged awards on the left,
// blue banners (event wins and 1st-place Inspire) on the right, like FIRST's.
const isBanner = (a) => ["Winner", "DivisionWinner"].includes(a.type) || (a.type === "Inspire" && a.placement <= 1);
const SHORT = {
  Inspire: "INSPIRE", Think: "THINK", Connect: "CONNECT", Innovate: "INNOVATE", Control: "CONTROL", Motivate: "MOTIVATE",
  Design: "DESIGN", Reach: "REACH", Sustain: "SUSTAIN", Promote: "PROMOTE", Compass: "COMPASS", JudgesChoice: "JUDGES",
  Winner: "WINNER", Finalist: "FINALIST", DivisionWinner: "DIVISION", DivisionFinalist: "DIVISION", ConferenceFinalist: "FINALIST",
  TopRanked: "TOP SEED", DeansListWinner: "DEAN'S", DeansListFinalist: "DEAN'S", DeansListSemiFinalist: "DEAN'S",
};
function banner(a, season) {
  const label = a.type === "Inspire" ? "INSPIRE" : "WIN";
  return `<a class="banner-icon" href="#/${season}/event/${encodeURIComponent(a.ev)}" title="${esc(AWARD_NAMES[a.type] ?? a.type)} · ${esc(a.evName)}">
    <svg viewBox="0 0 40 56" width="40" height="56" aria-hidden="true">
      <path d="M0 0h40v56l-20-10-20 10z" fill="#0b4f9c"/>
      <text x="20" y="25" text-anchor="middle" font-size="${label.length > 3 ? 8 : 11}" font-weight="900" fill="#fff">${label}</text>
    </svg></a>`;
}
// Event name split into short lines for a plaque, e.g. "Romania" / "Championship".
function bannerLines(name, max = 12, lines = 3) {
  const words = name.replace(/^FIRST\s+/i, "").replace(/\s+presented by.*$/i, "").split(/\s+/);
  const out = [""];
  for (const w of words) {
    if ((out[out.length - 1] + " " + w).trim().length > max && out[out.length - 1]) out.push(w);
    else out[out.length - 1] = (out[out.length - 1] + " " + w).trim();
  }
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/.{0,2}$/, "…"); }
  return out;
}
function plaque(a, season) {
  const first = (a.placement || 1) <= 1 && !/Finalist/.test(a.type);
  const place = a.placement > 1 && !["Winner", "Finalist", "DivisionWinner", "DivisionFinalist"].includes(a.type) ? `${ordinal(a.placement)} place` : "";
  const name = (AWARD_NAMES[a.type] ?? a.type).replace(/ Award$/, "");
  const nameLines = bannerLines(name, 10, 2);
  return `<a class="plaque-icon" href="#/${season}/event/${encodeURIComponent(a.ev)}" title="${esc(AWARD_NAMES[a.type] ?? a.type)}${place ? ` · ${place}` : ""} · ${esc(a.evName)}">
    <svg viewBox="0 0 60 76" width="60" height="76" aria-hidden="true">
      <rect width="60" height="76" rx="3" fill="${first ? "#6e4024" : "#1b1b1b"}"/>
      <rect x="2" y="2" width="56" height="72" rx="2" fill="none" stroke="${first ? "#8a5634" : "#333"}"/>
      <rect x="7" y="7" width="46" height="62" rx="1.5" fill="#2b7b82"/>
      <rect x="12" y="20" width="36" height="38" fill="#fff"/>
      <rect x="12" y="12" width="14" height="5" rx="1" fill="#f57e25"/>
      ${nameLines.map((l, k) => `<text x="30" y="${(place ? 33 : 37) + k * 7 - (nameLines.length - 1) * 3.5}" text-anchor="middle" font-size="6.2" font-weight="800" fill="#163a5f">${esc(l.toUpperCase())}</text>`).join("")}
      ${place ? `<text x="30" y="47" text-anchor="middle" font-size="5.2" fill="#4f4c4d">${place}</text>` : ""}
      <text x="30" y="54" text-anchor="middle" font-size="4.6" fill="#7a7a7a">${season}</text>
    </svg></a>`;
}
function trophyCase(season, awards) {
  const banners = awards.filter(isBanner), plaques = awards.filter((a) => !isBanner(a));
  return `<div class="plaques">${plaques.map((a) => plaque(a, season)).join("")}</div>
    <div class="tiles">${TILES_SLOT}</div>
    <div class="banners">${banners.map((a) => banner(a, season)).join("")}</div>`;
}
const TILES_SLOT = "%%TILES%%";

// YouTube's privacy-enhanced player: no cookies until the viewer presses play.
function openVideo(id, t, title) {
  const dlg = document.createElement("dialog");
  dlg.className = "video-dialog";
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?start=${t}&autoplay=1&rel=0`;
  dlg.innerHTML = `<div class="video-head"><b>${esc(title ?? "")}</b>
    <a class="small link" href="https://www.youtube.com/watch?v=${encodeURIComponent(id)}&t=${t}s" target="_blank" rel="noopener">Open on YouTube ↗</a>
    <button class="video-close" aria-label="Close">✕</button></div>
    <div class="video-frame"><iframe src="${src}" title="${esc(title ?? "Match video")}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const close = () => dlg.close();
  dlg.querySelector(".video-close").onclick = close;
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); }); // click outside
  dlg.addEventListener("close", () => dlg.remove()); // stops playback
}

const shortEvent = (name) => name.replace(/\s+(Championship|Qualifier|Tournament)$/i, "").trim();

function toMatch(m, me) {
  const mine = [me, ...m.partners];
  const isRed = m.side === "red";
  const bits = (arr, bit) => arr?.map((x) => (x & bit ? 1 : 0));
  const mySide = { np: m.pred[0], rp: bits(m.rp, 1) }, oppSide = { np: m.pred[1], rp: bits(m.orp, 1) };
  return {
    d: m.m, played: true, time: m.time,
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
  const [meta, ev, videos, official] = await Promise.all([data.meta(season), data.event(season, code).catch(() => null), data.videos(season), data.alliances(season)]);
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
    const hasQuals = matches.some((m) => m.level === "Quals");
    // forecast needs a quals schedule, or no matches yet (pre-event); playoff-only events get none
    const canForecast = hasQuals || (!matches.length && ev.teamList.length >= 4);
    const hasPlayoffs = matches.some((m) => m.level && m.level !== "Quals");
    const tabs = [["matches", "Matches"], ["teams", "Teams"], ...(hasPlayoffs ? [["playoffs", "Playoffs"]] : []), ...(canForecast ? [["forecast", "Rankings forecast"]] : [])];
    app.innerHTML = `
      <div class="card card-pad"><div class="page-head">
        <div>
          <div class="kicker">${esc(typeName(ev.type))} · ${fmtRange(ev.start, ev.end)} · ${esc(ev.loc)}</div>
          <h1>${esc(ev.name)}</h1>
          <div class="row" style="margin-top:8px">
            ${liveAt ? `<span class="pill live">Live · updated ${liveAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>` : ""}
            <span class="pill">${ev.teams} teams</span><span class="pill">${played.length}/${matches.length} matches played</span>
            <a class="pill" href="https://ftcscout.org/events/${season}/${encodeURIComponent(code)}" target="_blank" rel="noopener">FTCScout ↗</a>
            ${videos?.[code]?.streams?.[0] ? `<button class="pill" data-video="${videos[code].streams[0].id}" data-t="0" data-title="${esc(ev.name)}">▶ Event stream</button>` : ""}
          </div>
        </div>
        <div class="big-epa"><div class="label">Winner predicted</div><b>${decided.length ? pct(correct / decided.length) : "–"}</b><div class="label">${correct} of ${decided.length} matches</div></div>
      </div></div>
      <nav class="tabs seg glass">${tabs.map(([k, label]) => `<a href="#/${season}/event/${code}/${k}" class="${k === tab ? "active" : ""}">${label}</a>`).join("")}</nav>
      <div id="tab"></div>`;
    if (tab === "teams") eventTeams(season, meta, ev);
    else if (tab === "playoffs" && hasPlayoffs) eventPlayoffs(season, meta, ev, matches, official[code], (m) => videoFor(videos, code, m.time));
    else if (tab === "forecast" && canForecast) eventForecast(season, meta, ev, matches);
    else $("#tab").innerHTML = `<div class="card">${matchTable(season, matches, { rpNames: meta.rpNames, video: (m) => videoFor(videos, code, m.time) })}</div>`;
  };

  draw();
  if (maybeLive) {
    refresh();
    state.liveTimer = setInterval(() => document.visibilityState === "visible" && refresh(), 60_000);
  }
}

// Alliance selections and the bracket (see playoffs.js for how they're worked out).
function eventPlayoffs(season, meta, ev, matches, official, video) {
  const p = playoffs(matches, ev.teamList, official, { finished: ev.finished });
  const team = new Map(ev.teamList.map((t) => [t.team, t]));
  const name = (n) => team.get(n)?.name ?? "";
  // alliance strength: the two best robots play, so add their EPAs at the end of the event
  const strength = (a) => a.teams.map((t) => team.get(t)?.epaEnd ?? 0).sort((x, y) => y - x).slice(0, 2).reduce((x, y) => x + y, 0);
  const tn = (n, side = "") => `<a class="tn ${side}" href="#/${season}/team/${n}" title="${esc(name(n))}">${n}</a>`;
  const record = (a) => `${a.wins}-${a.losses}${a.ties ? `-${a.ties}` : ""}`;

  const allianceRows = p.alliances.map((a) => `<tr class="${a.result === "Winner" ? "champ" : ""}">
    <td class="num"><span class="seed">A${a.seed}</span></td>
    <td>${teamCell(season, a.captain, name(a.captain))}</td>
    <td class="small">${a.teams.slice(1).map((t) => `${tn(t)} <span class="muted hide-sm">${esc(name(t))}</span>`).join("<br>") || '<span class="faint">–</span>'}</td>
    <td class="c"><b>${fmt(strength(a))}</b></td>
    <td class="c small">${record(a)}</td>
    <td class="small ${a.result === "Winner" ? "res-win" : a.result === "Finalist" ? "res-final" : "muted"}">${a.result === "Winner" ? "🏆 Winner" : esc(a.result)}</td>
  </tr>`).join("");

  // one bracket box: two alliance lines with the score (or series wins)
  const box = (s) => {
    const last = s.games.filter((g) => g.played).at(-1);
    const v = last && video(last);
    const series = s.games.length > 1;
    const pRed = s.games[0].pred?.pRed;
    const line = (a, side) => {
      const won = s.winner === a, lost = s.winner && !won;
      const score = !last ? "" : series ? (side === "red" ? s.redWins : s.blueWins) : (side === "red" ? last.redScore.total : last.blueScore.total);
      return `<div class="bl ${side} ${won ? "won" : ""} ${lost ? "lost" : ""}">
        <span class="seed">A${a.seed}</span><span class="bt">${a.teams.map((t) => tn(t, side)).join("")}</span><b class="bs">${score}</b></div>`;
    };
    const games = series ? s.games.filter((g) => g.played).map((g) => `${g.redScore.total}–${g.blueScore.total}`).join(", ") : "";
    return `<div class="bbox">
      <div class="bh"><span>${esc(s.key)}${series ? " · best of 3" : ""}</span>
        ${v ? `<button class="play" data-video="${v.id}" data-t="${v.t}" data-title="${esc(`${ev.name} · ${last.d}`)}" aria-label="Watch ${esc(s.key)}" title="Watch">${PLAY_ICON}</button>` : ""}</div>
      ${line(s.red, "red")}${line(s.blue, "blue")}
      <div class="bf">${games ? `<span>${games}</span>` : ""}${pRed != null ? `<span class="faint" title="Our pre-match win probability">Pred ${pRed >= 0.5 ? `A${s.red.seed}` : `A${s.blue.seed}`} ${Math.round(Math.max(pRed, 1 - pRed) * 100)}%</span>` : ""}</div>
    </div>`;
  };

  const sections = p.sections.map((sec) => sec.roundRobin
    ? `<div class="bsec"><h3>${esc(sec.name)}</h3><div class="rr">${sec.rounds[0].slots.map(box).join("")}</div></div>`
    : `<div class="bsec">${sec.name ? `<h3>${esc(sec.name)}</h3>` : ""}<div class="bracket" style="--cols:${sec.rounds.length}">
        ${sec.rounds.map((r) => `<div class="bcol"><div class="bcol-h">${esc(r.name)}</div><div class="bcol-b">${r.slots.map(box).join("")}</div></div>`).join("")}
      </div></div>`).join("");

  $("#tab").innerHTML = `
    <div class="section-title"><h2>Alliances</h2><p class="muted" style="margin:6px 0 0">Strength adds the EPAs of each alliance's two best robots.${official ? "" : " Seeds worked out from qualification ranks until FIRST publishes the official list."}</p></div>
    <div class="card"><div class="table-wrap"><table class="alliances">
      <thead><tr><th>Seed</th><th>Captain</th><th>Picks</th><th class="c">Strength</th><th class="c">Record</th><th>Result</th></tr></thead>
      <tbody>${allianceRows}</tbody></table></div></div>
    <div class="section-title"><h2>Bracket</h2></div>
    <div class="card card-pad bracket-wrap">${sections}</div>`;
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
    const { model, matches: replayed } = replayEvent(meta, ev, matches.map((m) => ({ ...m, played: m.actuallyPlayed ?? m.played })), cutoff);
    const rows = forecastRankings(season, teams, replayed, 3000, { model });
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
  const unrated = ev.teamList.filter((t) => !t.state || t.state.n === 0).length;
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

const probCell = (p) => {
  if (p < 0.005) return `<span class="faint">–</span>`;
  // strong odds get solid FIRST blue with white text; weaker odds a light tint with dark text
  const style = p >= 0.5 ? "background:#0066b3;color:#fff" : `background:color-mix(in srgb,#0066b3 ${Math.round(8 + p * 40)}%,transparent);color:var(--text)`;
  return `<span class="epa" style="${style}">${pct(p)}</span>`;
};

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
      <h1 style="margin-top:8px">Our methodology</h1>
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
          ${bt ? `<tr><td class="muted">Ranking forecasts checked on</td><td class="r">${fmtInt(bt.events)} events</td></tr>` : ""}
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

  // one small file says which seasons exist and which to open by default
  const index = await getJSON("data/index.json").catch(() => null);
  if (index) {
    state.seasons = index.seasons;
    state.defaultSeason = index.default;
  } else {
    state.seasons = await data.seasons();
    const metas = await Promise.all(state.seasons.map((s) => data.meta(s)));
    state.defaultSeason = (metas.find((m) => m.matches >= 1000) ?? metas[0]).season;
  }

  $("#season").onchange = (e) => {
    const r = parseHash();
    // stay on the same kind of page; event codes differ by season, so events go to the list
    const keep = {
      teams: "teams", events: "events", about: "about", event: "events",
      team: `team/${r.args.join("/")}`,
    }[r.page] ?? "";
    location.hash = `#/${e.target.value}/${keep}`;
  };
  wireSearch($(".nav-search"));
  // match videos: one player dialog for every ▶ button
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-video]");
    if (!b) return;
    e.preventDefault();
    openVideo(b.dataset.video, +b.dataset.t || 0, b.dataset.title);
  });
  addEventListener("hashchange", () => $$(".video-dialog").forEach((d) => d.close()));
  // team photos: upload dialog when the photo service is configured
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-upload]");
    if (!link || !CONFIG.photoApi) return;
    e.preventDefault();
    openUpload(link.dataset.upload);
  });
  // whole-row clicks: a row whose main link is an event or team opens it, so
  // people don't have to hit the name itself (match rows have several links, so they're left alone)
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.target.closest("a, button, input, select, label")) return;
    const row = e.target.closest("#app tbody tr");
    const link = row?.querySelector("a.ev-cell, a.team-cell");
    if (link && !getSelection().toString()) location.hash = link.getAttribute("href");
  });
  // team photos: "N photos ›" cycles through them
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".photo-next");
    if (!btn) return;
    const figs = [...btn.closest(".team-photo").querySelectorAll("figure")];
    const i = figs.findIndex((f) => f.classList.contains("on"));
    figs[i].classList.remove("on");
    figs[(i + 1) % figs.length].classList.add("on");
  });
  window.addEventListener("hashchange", route);
  route();
}

boot();
