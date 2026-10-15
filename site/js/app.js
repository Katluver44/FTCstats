import {
  $, $$, esc, data, getJSON, fmt, pct, fmtInt, fmtDate, fmtRange, typeName, epa, teamCell, evCell,
  trend, matchTable, mountLineChart, sortableTable, radar, winBar, videoFor, videoLinks, PLAY_ICON, robot, ROBOT_PARTS } from "./ui.js";
import { SEASONS } from "./seasons.js";
import { scatter, histogram, breakdown } from "./charts.js";
import { addEventSos, sosValue, sosPlaces } from "./sos.js";
import { playoffs } from "./playoffs.js";
import { ADVANCING_TYPES, advRules } from "./advancement.js";
import { initAnalytics, trackPage } from "./analytics.js";
import { CONFIG } from "./config.js";
import { fetchLiveEvent, normalizeLive, replayEvent, forecastRankings, forecastFromRoster, modelFromMeta, standings } from "./live.js";

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

// tab title for pages with no heading (the lists, "not found" messages) and while loading
// Filter dropdowns show their name ("Type") until used; once a value has been picked, the
// blank choice reads "All types" so going back says what it means.
function labelFilters(root = document) {
  for (const sel of root.querySelectorAll("select")) {
    const o = sel.options[0];
    if (o?.dataset.all && sel.value !== "") o.text = o.dataset.all;
  }
}
document.addEventListener("change", (e) => { if (e.target instanceof HTMLSelectElement) labelFilters(e.target.parentElement ?? document); }, true);
const PAGE_TITLES = { teams: "Teams", team: "Team", events: "Events", event: "Event", match: "Match", compete: "Compete", h2h: "Head to head", sim: "SIM event", about: "Our methodology" };
const setTitle = (name) => (document.title = name ? `${name} · oddrobot` : "oddrobot · FTC ratings & match predictions");

async function route() {
  clearInterval(state.liveTimer);
  const r = parseHash();
  r.nav = ++state.nav;
  state.season = r.season;
  renderNav(r);
  // the home page fits one screen on desktop (fitHome); every other page scrolls normally
  document.body.classList.toggle("home-fit", !r.page);
  // keep the current page (dimmed) until the new one is ready, instead of flashing a blank
  // "Loading…" screen; only a slow load (over 0.6 s) shows the loading message
  app.classList.add("routing");
  const slow = setTimeout(() => { if (!stale(r)) { app.innerHTML = `<div class="loading">${robot("bot-wait", 48)}<span>Loading…</span></div>`; window.scrollTo(0, 0); } }, 600);
  const pages = { "": home, teams, team, events, event, match, compete, h2h, sim, about };
  const fn = pages[r.page] ?? notFound;
  setTitle(r.page && (PAGE_TITLES[r.page] ?? "Page not found"));
  try {
    await fn(r);
    clearTimeout(slow);
    if (!stale(r)) { app.classList.remove("routing"); window.scrollTo(0, 0); }
    if (!stale(r)) labelFilters($("#app")); // filters set from the link already read "All …"
    // a heading names the page better, e.g. "20265 Heart of RoBots · oddrobot"
    const h1 = !stale(r) && r.page && $("#app h1");
    if (h1) setTitle(h1.textContent.trim().replace(/\s+/g, " "));
    if (!stale(r)) trackPage(`/${r.season}/${[r.page, ...r.args].filter(Boolean).join("/")}`, document.title);
  } catch (e) {
    console.error(e);
    clearTimeout(slow);
    if (!stale(r)) app.classList.remove("routing");
    if (!stale(r)) app.innerHTML = `<div class="card empty">Couldn't load this page. Check the link, or try another season.</div>`;
  }
}

// the same kind of page in another season; event codes differ by season, so events go to the list
function seasonHref(s, { page, args }) {
  const keep = {
    teams: "teams", events: "events", compete: "compete", h2h: `h2h?${new URLSearchParams(location.hash.split("?")[1] ?? "")}`, about: "about", sim: "sim", event: "events", match: "events",
    team: `team/${args.join("/")}`,
  }[page] ?? "";
  return `#/${s}/${keep}`;
}

function renderNav(r) {
  const { season, page } = r;
  const years = (s) => `${s}–${String(s + 1).slice(2)}`;
  // the short form ("25–26") only shows on the narrowest phones (style.css, ≤356px), where the full label doesn't fit the header row
  $("#season .season-cur").innerHTML = `<span class="sc-long">${years(season)}</span><span class="sc-short">${years(season).slice(2)}</span>`;
  $("#season .season-btn").setAttribute("aria-label", `Season: ${years(season)}. Change season`);
  $("#season-menu").innerHTML = state.seasons
    .map((s) => `<a href="${seasonHref(s, r)}" ${s === season ? 'aria-current="true"' : ""}>
      <b>${years(s)}</b>${s === state.defaultSeason ? '<span class="now">Latest</span>' : ""}
      <span class="game">${esc(SEASONS[s]?.game ?? "")}</span></a>`)
    .join("");
  closeSeasonMenu(false);
  $$("header [data-page]").forEach((a) => {
    a.href = `#/${season}/${a.dataset.page}`;
    a.classList.toggle("active", a.dataset.page === (page === "h2h" || page === "sim" ? "compete" : page));
  });
  $(".logo").href = `#/${season}/`;
}

// season picker: a button that shows/hides a list of links, one per season
function closeSeasonMenu(refocus) {
  const btn = $("#season .season-btn");
  $("#season-menu").hidden = true;
  btn.setAttribute("aria-expanded", "false");
  if (refocus) btn.focus();
}

function wireSeasonPicker() {
  const root = $("#season"), btn = $(".season-btn", root), menu = $("#season-menu");
  const links = () => $$("a", menu);
  // keep the list inside the viewport, whatever row the button wrapped onto
  const place = () => {
    menu.style.transform = "";
    const r = menu.getBoundingClientRect();
    const dx = r.right > innerWidth - 8 ? innerWidth - 8 - r.right : r.left < 8 ? 8 - r.left : 0;
    if (dx) menu.style.transform = `translateX(${dx}px)`;
  };
  // focus a row without scrolling the page; scroll only the list
  const focusRow = (a) => {
    if (!a) return;
    a.focus({ preventScroll: true });
    if (a.offsetTop < menu.scrollTop) menu.scrollTop = a.offsetTop - 6;
    else if (a.offsetTop + a.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = a.offsetTop + a.offsetHeight - menu.clientHeight + 6;
  };
  const open = (which) => {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    place();
    const ls = links(), cur = ls.findIndex((a) => a.hasAttribute("aria-current"));
    focusRow(ls[which === "last" ? ls.length - 1 : Math.max(cur, 0)]);
  };
  btn.onclick = () => (menu.hidden ? open() : closeSeasonMenu(false));
  btn.onkeydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); open(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); open("last"); }
    else if (e.key === "Escape" && !menu.hidden) closeSeasonMenu(true);
  };
  // arrows, Home/End and Esc inside the list; Tab moves through the links as usual
  menu.onkeydown = (e) => {
    const ls = links(), i = ls.indexOf(document.activeElement);
    const go = (j) => { e.preventDefault(); focusRow(ls[(j + ls.length) % ls.length]); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(ls.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); closeSeasonMenu(true); }
  };
  // picking a season closes the list and puts focus back on the button (which
  // then names the new season); the season you're already in just closes it
  menu.onclick = (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    if (a.hasAttribute("aria-current")) e.preventDefault();
    closeSeasonMenu(true);
  };
  // a click outside closes the list and is swallowed, like a native dropdown,
  // so dismissing it can't also open whatever was underneath
  let swallow = false;
  document.addEventListener("pointerdown", (e) => {
    swallow = !menu.hidden && !root.contains(e.target);
    if (swallow) closeSeasonMenu(false);
  }, true);
  document.addEventListener("click", (e) => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  root.addEventListener("focusout", (e) => { if (!menu.hidden && e.relatedTarget && !root.contains(e.relatedTarget)) closeSeasonMenu(false); });
  addEventListener("resize", () => { if (!menu.hidden) place(); });
}

// Keep a page's filters in the URL so reloads and shared links keep them.
function syncQuery(params) {
  const [path] = location.hash.split("?");
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  history.replaceState(null, "", `${path}${q.toString() ? `?${q}` : ""}`);
}

// "2025–26 · DECODE", or just "2026–27" before the game name is known
const seasonLabel = (s, game) => `${s}–${String(s + 1).slice(2)}${game ? ` · ${esc(game)}` : ""}`;

const EPA_TIP = "EPA: points this team adds to its alliance right now (auto + teleop + endgame). Tuned to represent robot strength.";

const notFound = () => (app.innerHTML = `<div class="bot-empty">${robot("", 56)}<b>Page not found</b>
  <span class="muted">This robot drove off the field. <a class="link" href="#/${state.season}/">Back to the start →</a></span></div>`);

// ---------------- search ----------------

// Search: every team and event gets a match score, then teams and events are mixed
// by score. Exact > starts with > a word starts with > anywhere; punctuation and case
// don't matter ("ice" finds I.C.E. Robotics). Ties go to stronger teams, teams that
// have played, and events that are live or soon.
const normText = (x) => String(x ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function textScore(text, q) {
  const t = normText(text), tq = normText(q);
  if (!t || !tq) return 0;
  const tc = t.replace(/ /g, ""), qc = tq.replace(/ /g, "");
  if (t === tq || tc === qc) return 100;
  if (t.startsWith(tq) || tc.startsWith(qc)) return 80;
  if ((" " + t).includes(" " + tq)) return 60;
  // inside a word ("practice" for "ice") only for longer searches, where it is rarely noise
  if (qc.length >= 4 && (t.includes(tq) || tc.includes(qc))) return 40;
  return 0;
}
async function searchItems(season, q) {
  q = q.trim();
  if (!q) return [];
  const [played, pre, events] = await Promise.all([data.teams(season), data.pre(season), data.events(season)]);
  const teams = [...played, ...pre]; // teams that haven't played yet this season are findable too
  const isNum = /^\d+$/.test(q);
  const scored = [];
  const n = played.length || 1;
  for (const t of teams) {
    let sc = 0;
    const num = String(t.team);
    if (isNum) sc = num === q ? 120 : num.startsWith(q) ? 90 - (num.length - q.length) * 3 : 0;
    else sc = Math.max(textScore(t.name, q), textScore(t.loc, q) * 0.4);
    if (!sc) continue;
    // tie-breaks: played this season, then higher in the rankings
    sc += (t.pre ? 0 : 4) + (t.pre ? 0 : 3 * (1 - (t.rank ?? n) / n));
    scored.push({ sc, item: { href: `#/${season}/team/${t.team}`, main: num, sub: t.name, kind: "Team" } });
  }
  const today = localToday(0);
  // what people call events: "worlds", "states"
  const alias = { worlds: ["world championship"], world: ["world championship"], states: ["state championship"], state: ["state championship"] }[normText(q)] ?? [];
  for (const e of events) {
    const code = e.code.toLowerCase(), ql = q.toLowerCase();
    let sc = code === ql ? 110 : !isNum && code.startsWith(ql) && ql.length >= 3 ? 65 : 0;
    if (!isNum) sc = Math.max(sc, textScore(e.name, q), textScore(e.loc, q) * 0.4, ...alias.map((a) => textScore(e.name, a) - 5));
    if (!sc) continue;
    sc += { FIRSTChampionship: 6, Premier: 3, Championship: 3, SuperQualifier: 2, Qualifier: 1, LeagueTournament: 1 }[e.type] ?? 0;
    const soon = e.ongoing ? 6 : e.start >= today && e.start <= localToday(21) ? 4 : !e.finished ? 1 : 0;
    sc += soon + Math.min(2, (e.teams ?? 0) / 25) - e.name.length / 200; // shorter = the main event, not a division
    scored.push({ sc, item: { href: `#/${season}/event/${e.code}`, main: e.name, sub: `${fmtDate(e.start)}${e.ongoing ? " · live" : ""}`, kind: "Event" } });
  }
  scored.sort((x, y) => y.sc - x.sc);
  // up to 10, at most 7 of one kind so both show when both match
  const out = [], count = { Team: 0, Event: 0 };
  for (const { item } of scored) {
    if (count[item.kind] >= 7) continue;
    out.push(item); count[item.kind]++;
    if (out.length >= 10) break;
  }
  return out;
}

function wireSearch(wrap) {
  const input = $("input", wrap), box = $(".search-results", wrap);
  let sel = 0, items = [];
  const draw = () => {
    box.innerHTML = items.map((it, i) =>
      `<a href="${it.href}" class="${i === sel ? "sel" : ""}"><b>${esc(it.main)}</b><span class="muted small">${esc(it.sub)}</span><span class="kind">${it.kind}</span></a>`).join("")
      || (input.value.trim() ? `<div class="empty small"><span class="bot-inline">${robot("", 24)}No teams or events match.</span></div>` : "");
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

// phones: the header's search box is folded into an icon; tapping it drops the box down under the header
function wireNavSearchToggle() {
  const nav = $("header.nav"), btn = $(".nav-search-btn"), input = $(".nav-search input");
  if (!nav || !btn || !input) return;
  const set = (open) => { nav.classList.toggle("search-open", open); btn.setAttribute("aria-expanded", String(open)); };
  btn.onclick = () => {
    const open = !nav.classList.contains("search-open");
    set(open);
    if (open) input.focus();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { set(false); btn.focus(); } });
  document.addEventListener("click", (e) => { if (!nav.contains(e.target) || e.target.closest(".search-results a")) set(false); });
  window.addEventListener("hashchange", () => set(false));
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
  const { live, recent } = sum;

  // featured card: the season's top four teams, #1 + #4 vs #2 + #3
  const [t1, t2, t3, t4] = teams;
  let feature = "";
  if (t4) {
    const model = modelFromMeta(meta);
    // the top 4 by EPA, played out with their prediction ratings (pauto..., older files: the EPA)
    for (const t of [t1, t2, t3, t4]) model.setTeam(t.team, { auto: t.pauto ?? t.auto, teleop: t.pteleop ?? t.teleop, endgame: t.pendgame ?? t.endgame, foul: t.foul, n: t.matches, rp: [t.rp0, t.rp1, t.rp2] });
    const p = model.predict([t1.team, t4.team], [t2.team, t3.team]);
    const side = (cls, ts) => `<div class="feature-side ${cls}">${ts.map((t) => `<a href="#/${season}/team/${t.team}">${t.team}</a><small>${esc(t.name)}</small>`).join("")}</div>`;
    feature = `<div class="feature">
      <div class="feature-head"><b>Dream match: the top 4, predicted</b><span>${seasonLabel(season, meta.game)}</span></div>
      <div class="feature-body">
        ${side("red", [t1, t4])}
        <div class="feature-score"><span class="score red">${fmt(p.red.total, 0)}</span><span class="faint">–</span><span class="score blue">${fmt(p.blue.total, 0)}</span></div>
        ${side("blue", [t2, t3])}
      </div>
      <div class="feature-foot">${winBar(p.pRed)}<p>Red wins ${pct(p.pRed)} of the time. <a class="link" href="#/${season}/compete?r=${t1.team},${t4.team}&b=${t2.team},${t3.team}">Try your own matchup →</a></p></div>
    </div>`;
  }

  app.innerHTML = `
    <section class="hero">
      <div>
        ${banner}
        <div class="eyebrow">${seasonLabel(season, meta.game)} season</div>
        <div class="hero-title">Every FTC match, predicted.</div>
        <div class="hero-sub desk-only">Team ratings that update after every match, win chances you can check against real results, and ranking forecasts for live events.</div>
        <div class="search hero-search mobile-only" id="hero-search">${SEARCH_ICON}<input placeholder="Search teams & events" autocomplete="off"><div class="search-results"></div></div>
        <div class="hero-row">
        <div class="hero-actions">
          <a class="btn btn-solid desk-only" href="#/${season}/teams">Find a team</a>
          <a class="btn btn-outline desk-only" href="#/${season}/about">Our methodology</a>
        </div>
        <div class="hero-stats">
          <div><b>${pct(acc.accuracy, 1)}</b><span>winners called before the match</span></div>
          <div><b>${fmtInt(meta.matches)}</b><span>matches rated</span></div>
          <div><b>${fmtInt(meta.teams)}</b><span>teams</span></div>
        </div>
        </div>
      </div>
      <div class="hero-media desk-only">${feature}</div>
    </section>
    <div class="hero-below">
      <div class="grid cols-2">
        <div>
          <div class="section-title"><div class="eyebrow">Ratings</div><h2>Top teams</h2></div>
          <div class="card"><div id="top-teams"></div><a class="more" href="#/${season}/teams">All teams →</a></div>
        </div>
        <div>
          <div class="section-title"><div class="eyebrow">${live.length ? "Live" : "Results"}</div><h2>${live.length ? "Happening now" : "Recent events"}</h2></div>
          <div class="card"><div id="home-events"></div><a class="more" href="#/${season}/events">All events →</a></div>
        </div>
      </div>
    </div>`;
  wireSearch($("#hero-search"));
  // five big rows a side: who's on top, and what just happened
  const rec = (x) => `${x.wins}-${x.losses}${x.ties ? `-${x.ties}` : ""}`;
  $("#top-teams").innerHTML = `<div class="hl">${teams.slice(0, 8).map((t) => `
    <a class="hl-row" href="#/${season}/team/${t.team}">
      <span class="hl-rank">${t.rank}</span>
      <span class="hl-main"><b><span class="hl-num">${t.team}</span> ${esc(t.name)}</b><small>${esc(t.loc)}</small>
        <small class="hl-meta">${rec(t)} · Auto ${fmt(t.auto, 0)} · Teleop ${fmt(t.teleop, 0)} · Endgame ${fmt(t.endgame, 0)}</small></span>
      <span class="hl-val">${epa(t.np, meta)}<small>EPA</small></span>
    </a>`).join("")}</div>`;
  // tiny scrimmages crowd out the events people care about; skip them when there are enough others
  const evPool = live.length ? live : recent;
  const bigger = evPool.filter((e) => e.teams >= 8);
  const evs = (bigger.length >= 8 ? bigger : evPool).slice(0, 8);
  $("#home-events").innerHTML = evs.length ? `<div class="hl">${evs.map((e) => `
    <a class="hl-row" href="#/${season}/event/${e.code}">
      <span class="hl-main"><b title="${esc(e.name)}">${esc(e.name)}</b><small>${fmtRange(e.start, e.end)} · ${esc(e.loc)}</small>
        <small class="hl-meta">${esc(typeName(e.type))} · ${e.teams} teams${e.topTeams?.length ? ` · Top: ${e.topTeams.slice(0, 3).join(", ")}` : ""}</small></span>
      <span class="hl-val">${e.ongoing ? '<span class="pill live">Live</span>' : `${epa(e.strength, meta)}<small>Strength</small>`}</span>
    </a>`).join("")}</div>` : `<div class="bot-empty">${robot("", 44)}<span class="muted">No events yet this season.</span></div>`;
  fitHome();
}

// Home on a desktop screen: the page fills the window below the header, footer
// just out of sight, and shows as many list rows as fit (at least 4 a side);
// if even 4 don't fit, it shows 4 and lets the page scroll.
let homeRows = null;
function fitHome() {
  const lists = ["#top-teams .hl", "#home-events .hl"].map((q) => $(q)).filter(Boolean);
  homeRows = lists.map((l) => [l, [...l.children]]);
  refitHome();
  document.fonts?.ready.then(refitHome); // row heights change once the web font is in
}
function refitHome() {
  if (!homeRows || !document.body.classList.contains("home-fit") || !homeRows[0][0].isConnected) return;
  document.body.classList.remove("home-scroll");
  document.body.style.setProperty("--head-h", `${$("header")?.offsetHeight ?? 0}px`);
  for (const [l, rows] of homeRows) l.replaceChildren(...rows);
  if (!matchMedia("(min-width: 901px) and (min-height: 520px)").matches) return;
  let fits = true;
  for (const [l] of homeRows) {
    const box = l.parentElement; // the list's area inside its card
    while (box.scrollHeight > box.clientHeight + 1 && l.children.length > 1) l.lastElementChild.remove();
    if (box.scrollHeight > box.clientHeight + 1 || l.children.length < 4) fits = false;
  }
  // same number of rows on both sides, so the two cards line up
  const n = Math.min(...homeRows.map(([l]) => l.children.length));
  for (const [l] of homeRows) while (l.children.length > n) l.lastElementChild.remove();
  // too short a window for a useful one-screen page: 4 rows a side, and scroll
  if (!fits) {
    for (const [l, rows] of homeRows) l.replaceChildren(...rows.slice(0, 4));
    document.body.classList.add("home-scroll");
  }
}
let refitTimer;
addEventListener("resize", () => { clearTimeout(refitTimer); refitTimer = setTimeout(refitHome, 120); });

// "Columbus, OH, USA" -> "OH" (the part before the country), or "" when there's none
const regionOf = (loc) => { const p = (loc ?? "").split(", "); return p.length >= 3 ? p[p.length - 2] : ""; };
// Fill a state/region <select> from rowsFn(); hidden while the chosen country has
// fewer than two regions. Returns the refill function (call it when the country changes).
function regionSelect(sel, rowsFn, initial) {
  let first = true;
  return () => {
    const regions = [...new Set(rowsFn().map((r) => r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const keep = first ? initial : sel.value;
    first = false;
    sel.innerHTML = `<option value="" data-all="All states / regions">State / region</option>${regions.map((x) => `<option ${x === keep ? "selected" : ""}>${esc(x)}</option>`).join("")}`;
    sel.hidden = regions.length < 2;
    if (sel.hidden) sel.value = "";
    labelFilters(sel.parentElement ?? document);
  };
}
// per-device preferences (remembered columns); the page works the same without storage
const pref = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`ftcstats:${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ftcstats:${k}`, JSON.stringify(v)); } catch {} },
};

// ---------------- teams ----------------

const TABLE_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 3h11M1.5 7h11M1.5 11h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CHART_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="3.5" cy="9.5" r="1.6" fill="currentColor"/><circle cx="7" cy="5.5" r="1.6" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.6" fill="currentColor"/><circle cx="11" cy="2.8" r="1.6" fill="currentColor"/></svg>';

async function teams(r) {
  const { season, query } = r;
  // ?off=full (old links: off=1 / off=mti / scope=all); official season by default
  let off = ["1", "mti", "full"].includes(query.get("off")) || query.get("scope") === "all" ? "full" : "official";
  const [meta, played, preTable] = await Promise.all([data.meta(season), data.teams(season, off), getJSON(`data/${season}/teams-pre.json`).catch(() => null)]);
  const hasOff = meta.offTables && meta.offTables.full !== meta.offTables.official;
  if (stale(r)) return;
  const rpNames = meta.rpNames;
  // rps: bonus RPs earned in an average match (each RP's rate, 0-1, summed), one column for all of them
  const rpRate = (r, i) => Math.min(1, Math.max(0, r[`rp${i}`] ?? 0));
  // own copies (rank changes with the matches filter); plus last season's teams that
  // haven't played yet, on the EPA the model starts them on ("Predicted")
  const pre = (preTable?.rows ?? []).map((row) => {
    const o = { matches: 0, wins: 0, losses: 0, ties: 0, events: 0, trend: null, cons: null, pre: true };
    preTable.cols.forEach((c, j) => (o[c] = row[j]));
    return o;
  });
  const rows = [...played.map((o) => ({ ...o })), ...pre];
  for (const r of rows) {
    r.region = regionOf(r.loc); r.wr = r.matches ? (r.wins + r.ties / 2) / r.matches : null;
    if (r.pre) r.country = (r.loc ?? "").split(", ").pop();
    r.rps = rpNames.reduce((sum, _, i) => sum + rpRate(r, i), 0);
    rpNames.forEach((_, i) => (r[`rpr${i}`] = rpRate(r, i)));
  }
  const byEpa = [...rows].sort((a, b) => b.np - a.np);
  byEpa.forEach((r, i) => (r.rankAll = i + 1));
  byEpa.filter((r) => !r.pre).forEach((r, i) => (r.rankPlayed = i + 1));
  const countries = [...new Set(rows.map((r) => r.country).filter(Boolean))].sort();
  // phones: no chart view (a scatter is unreadable at 360px), so a shared ?view=chart opens the table
  const phone = matchMedia("(max-width: 640px)").matches;
  let view = !phone && query.get("view") === "chart" ? "chart" : "table";
  const chart = { type: query.get("chart") ?? "scatter", x: query.get("x") ?? "auto", y: query.get("y") ?? "teleop", m: query.get("m") ?? "np" };
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="view-pick desk-only" role="group" aria-label="View">
          <button type="button" data-view="table" aria-pressed="${view === "table"}">${TABLE_ICON}Table</button>
          <button type="button" data-view="chart" aria-pressed="${view === "chart"}">${CHART_ICON}Chart</button>
        </div>
        <input id="filter" placeholder="Search teams…" value="${esc(query.get("q") ?? "")}">
        <select id="country" aria-label="Country"><option value="" data-all="All countries">Country</option>${countries.map((c) => `<option ${c === query.get("country") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="state" aria-label="State or region" hidden></select>
        <select id="minm" aria-label="Number of matches played" title="Teams that have played at least this many matches; Predicted also shows teams that haven't played yet (on the EPA they start the season with)"><option value="0">Predicted</option><option value="1" selected>1+ matches</option><option value="5">5+ matches</option><option value="10">10+ matches</option><option value="25">25+ matches</option></select>
        ${hasOff ? `<div class="seg scope" role="group" aria-label="Which events count">
          ${[["official", "Season only", "Official events only: off-season events (often modified rules and lineups) never move these ratings"],
             ["full", "All events", "Adds every off-season event at 40%; modified-rules events left out"]]
            .map(([k, l, tip]) => `<a href="#" data-off="${k}" class="${k === off ? "active" : ""}" title="${tip}">${l}</a>`).join("")}
        </div>` : ""}
        <details class="col-pick"${view === "chart" ? " hidden" : ""}><summary>Columns</summary><div id="col-list"></div></details>
      </div>
      <div id="tbl"${view === "chart" ? " hidden" : ""}></div>
      <div id="charts" class="card-pad team-charts"${view === "table" ? " hidden" : ""}></div>
    </div>`;
  const cols = [
    { key: "rank", label: "#", cls: "faint num", render: (r) => r.rank },
    { key: "team", label: "Team", sort: false,
      // predicted teams (haven't played yet): an asterisk straight after the name
      // number, then name over location as one block; predicted teams get an asterisk after the name
      render: (r) => `<a class="team-cell team-cell2" href="#/${season}/team/${r.team}"><span class="n">${r.team}</span><span class="tc-text"><span class="nm">${esc(r.name)}${r.pre ? `<span class="pred-star" title="Hasn't played yet this season: its EPA is the one it starts on">*</span>` : ""}</span>${r.loc ? `<span class="tc-loc">${esc(r.loc)}</span>` : ""}</span></a>` },
    { key: "country", label: "Country", cls: "small muted", render: (r) => esc(r.country ?? "") },
    { key: "region", label: "State / region", cls: "small muted", render: (r) => esc(r.region || "–") },
    { key: "np", label: `<span title="${EPA_TIP}">EPA</span>`, cls: "c",
      render: (r) => epa(r.np, meta) },
    { key: "auto", label: "Auto", cls: "r", render: (r) => fmt(r.auto) },
    { key: "teleop", label: "Teleop", cls: "r", render: (r) => fmt(r.teleop) },
    { key: "endgame", label: "Endgame", cls: "r", render: (r) => fmt(r.endgame) },
    ...(rpNames.length ? [{ key: "rps", label: `<span title="Bonus ranking points earned in an average match (${rpNames.join(", ")})">RPs</span>`, cls: "r small hide-sm",
      render: (r) => `<span title="${rpNames.map((n, i) => `${n} ${pct(rpRate(r, i))}`).join(" · ")}">${fmt(r.rps)}</span>` }] : []),
    ...rpNames.map((n, i) => ({ key: `rpr${i}`, label: `<span title="How often it earns the ${esc(n)} RP">${esc(n)}</span>`, cls: "r small", render: (r) => pct(r[`rpr${i}`]) })),
    { key: "wins", label: "Record", cls: "r small", render: (r) => (r.matches ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}` : "–") },
    { key: "wr", label: "Win rate", cls: "r small", render: (r) => (r.wr == null ? "–" : pct(r.wr)) },
    { key: "matches", label: "Matches", cls: "r small", render: (r) => r.matches },
    { key: "events", label: "Events", cls: "r small", render: (r) => r.events ?? 0 },
    { key: "cons", label: `<span title="How far its alliance's score typically lands from the prediction (lower = steadier)">Consistency</span>`, cls: "r small",
      render: (r) => (r.cons == null ? "–" : `±${pct(r.cons)}`) },
    { key: "trend", label: "Trend", cls: "r small", render: (r) => (r.trend == null ? "–" : `<span title="EPA change over the last 10 matches">${trend(r.trend)}</span>`) },
    { key: "sos", label: `<span title="Strength of schedule, 0 to 1: how hard its qualification draws (partners and opponents) were for its ranking, as the share of random schedules at the same events that would have been easier. 0.5 = typical, 1 = hardest">SOS</span>`, cls: "r small", render: (r) => sosCell(r.sos, r.sosPlaces) },
  ];
  // Columns menu: everything but rank, team and EPA can be hidden (remembered per device).
  // Off by default: location, win rate and the extra columns added later.
  const FIXED = new Set(["rank", "team", "np"]);
  const EXTRA = ["country", "region", "matches", "events", "cons", "sos", ...rpNames.map((_, i) => `rpr${i}`)];
  const plain = (c) => c.label.replace(/<[^>]+>/g, "");
  // teamCols4: SOS and the per-RP columns start hidden (an earlier list showed them)
  // phones: #, Team, EPA and Record unless the phone has saved its own set (teamCols4m)
  const PHONE_HIDDEN = cols.filter((c) => !FIXED.has(c.key) && c.key !== "wins").map((c) => c.key);
  const colKey = phone ? "teamCols4m" : "teamCols4";
  let hiddenCols = new Set(pref.get(colKey, null) ?? (phone ? PHONE_HIDDEN : ["wr", ...EXTRA]));
  $("#col-list").innerHTML = cols.filter((c) => !FIXED.has(c.key)).map((c) =>
    `<button type="button" class="col-btn" data-k="${c.key}" aria-pressed="${!hiddenCols.has(c.key)}">${esc(plain(c))}</button>`).join("");
  let table, shown = rows;
  const mount = () => { table = sortableTable($("#tbl"), shown, cols.filter((c) => !hiddenCols.has(c.key)), { sortKey: "np", rowClass: (r) => (r.pre ? "pre-row" : "") }); };
  $("#col-list").onclick = (e) => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    const k = b.dataset.k, on = hiddenCols.has(k);
    on ? hiddenCols.delete(k) : hiddenCols.add(k);
    b.setAttribute("aria-pressed", String(on));
    pref.set(colKey, [...hiddenCols]);
    mount();
  };

  // ---- charts ----
  const metrics = [
    { key: "np", label: "EPA", get: (r) => r.np },
    { key: "auto", label: "Auto EPA", get: (r) => r.auto },
    { key: "teleop", label: "Teleop EPA", get: (r) => r.teleop },
    { key: "endgame", label: "Endgame EPA", get: (r) => r.endgame },
    ...(rpNames.length ? [{ key: "rps", label: "Bonus RPs a match", get: (r) => r.rps, d: 2 }] : []),
    { key: "wr", label: "Win rate", get: (r) => r.wr, pct: true },
    { key: "matches", label: "Matches played", get: (r) => r.matches, d: 0 },
    { key: "trend", label: "Trend (last 10 matches)", get: (r) => r.trend },
    { key: "cons", label: "Consistency (± miss)", get: (r) => r.cons, pct: true },
    { key: "sos", label: "Strength of schedule (0-1)", get: (r) => r.sos, d: 2 },
  ].map((m) => ({ ...m, show: (v, tick) => (m.pct ? pct(v) : tick ? fmt(v, Number.isInteger(v) ? 0 : 1) : fmt(v, m.d ?? 1)) }));
  const metric = (k, d) => metrics.find((m) => m.key === k) ?? metrics.find((m) => m.key === d);
  const opts = (sel) => metrics.map((m) => `<option value="${m.key}" ${m.key === sel ? "selected" : ""}>${esc(m.label)}</option>`).join("");
  const CHARTS = [["scatter", "Scatter"], ["dist", "Distribution"], ["breakdown", "Top 25 breakdown"]];
  const drawChart = () => {
    if (!CHARTS.some(([k]) => k === chart.type)) chart.type = "scatter";
    const x = metric(chart.x, "auto"), y = metric(chart.y, "teleop"), m = metric(chart.m, "np");
    const controls = chart.type === "scatter"
      ? `<label class="sel-label"><span>X</span><select data-c="x">${opts(x.key)}</select></label><button type="button" class="swap" title="Swap axes" aria-label="Swap axes">⇄</button><label class="sel-label"><span>Y</span><select data-c="y">${opts(y.key)}</select></label>`
      : chart.type === "dist" ? `<label class="sel-label"><span>Stat</span><select data-c="m">${opts(m.key)}</select></label>`
      : `<div class="pl-legend small"><span><i class="auto"></i>Auto</span><span><i class="teleop"></i>Teleop</span><span><i class="endgame"></i>Endgame</span></div>`;
    const note = {
      scatter: "",
      dist: "How many teams sit at each level. The markers show the median and what it takes to be in the top 10% and top 1%.",
      breakdown: "The 25 best teams by EPA in this list, split into what each scores in auto, teleop and endgame.",
    }[chart.type];
    $("#charts").innerHTML = `
      <div class="chart-head">
        <div class="chart-pick">${CHARTS.map(([k, l]) => `<a href="#" data-type="${k}" class="${k === chart.type ? "active" : ""}">${l}</a>`).join("")}</div>
        <div class="chart-controls">${controls}</div>
      </div>
      ${note ? `<p class="small muted chart-note">${note}</p>` : ""}
      <div id="chart-box" class="chart"></div>`;
    const box = $("#chart-box");
    // predicted teams have no matches of their own (their stats just scale with the
    // carried-over EPA); leave them off the scatter unless they're nearly all there is
    const playedShown = shown.filter((r) => !r.pre);
    if (chart.type === "scatter") scatter(box, playedShown.length >= 20 ? playedShown : shown, { x, y, href: (r) => `#/${season}/team/${r.team}` });
    else if (chart.type === "dist") histogram(box, shown, { m });
    else breakdown(box, shown, { season });
  };
  $("#charts").onclick = (e) => {
    const a = e.target.closest("[data-type]");
    if (a) { e.preventDefault(); chart.type = a.dataset.type; sync(); drawChart(); return; }
    if (e.target.closest(".swap")) { [chart.x, chart.y] = [chart.y, chart.x]; sync(); drawChart(); }
  };
  $("#charts").onchange = (e) => {
    const s = e.target.closest("[data-c]");
    if (s) { chart[s.dataset.c] = s.value; sync(); drawChart(); }
  };
  $(".view-pick").onclick = (e) => {
    const b = e.target.closest("[data-view]");
    if (!b || b.dataset.view === view) return;
    view = b.dataset.view;
    $$(".view-pick button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.view === view)));
    $("#tbl").hidden = $(".col-pick").hidden = view === "chart";
    $("#charts").hidden = view === "table";
    apply();
  };

  // default 1+ matches; ?min=0 shows teams that haven't played yet too
  if (query.get("min") != null) $("#minm").value = query.get("min");
  if ($("#minm").selectedIndex < 0) $("#minm").value = "1";
  labelFilters($(".toolbar"));
  const fillStates = regionSelect($("#state"), () => rows.filter((r) => r.country === $("#country").value), query.get("state"));
  const sync = () => {
    const m = +$("#minm").value;
    const ch = view === "chart" ? { view: "chart", chart: chart.type, ...(chart.type === "scatter" ? { x: chart.x, y: chart.y } : chart.type === "dist" ? { m: chart.m } : {}) } : {};
    syncQuery({ q: $("#filter").value.trim(), country: $("#country").value, state: $("#state").value, min: m === 1 ? "" : m, off: off === "official" ? "" : off, ...ch });
  };
  const apply = () => {
    const q = $("#filter").value.trim().toLowerCase(), c = $("#country").value, m = +$("#minm").value, st = $("#state").value;
    sync();
    for (const r of rows) r.rank = m ? r.rankPlayed : r.rankAll;
    shown = rows.filter((r) =>
      (m ? !r.pre && r.matches >= m : true) && (!c || r.country === c) && (!st || r.region === st) &&
      (!q || String(r.team).startsWith(q) || (r.name ?? "").toLowerCase().includes(q) || (r.loc ?? "").toLowerCase().includes(q)));
    if (view === "table") { if (table) table.setRows(shown); else mount(); }
    else drawChart();
  };
  $("#filter").oninput = apply; $("#minm").onchange = apply; $("#state").onchange = apply;
  $("#country").onchange = () => { fillStates(); apply(); };
  fillStates();
  // switching tables reloads the page with ?off=full (filters are kept in the query)
  if ($(".scope")) $(".scope").onclick = (e) => {
    const a = e.target.closest("[data-off]");
    if (!a) return;
    e.preventDefault();
    off = a.dataset.off;
    sync();
    teams({ ...r, query: new URLSearchParams(location.hash.split("?")[1] ?? "") });
  };
  apply();
}

// ---------------- team ----------------

async function team(r) {
  const { season, args } = r;
  const n = /^\d{1,6}$/.test(args[0] ?? "") ? +args[0] : null, view = args[1] ?? "matches";
  if (n == null) { app.innerHTML = `<div class="bot-empty">${robot("", 56)}<b>That isn't a team number</b><span class="muted">Team numbers are up to 6 digits, like 20265.</span></div>`; return; }
  // just the season summary and this team's file (ranks are precomputed); the radar fills in from the team list after
  const [meta, t] = await Promise.all([data.meta(season), data.team(season, n).catch(() => null)]);
  const videos = t ? await data.videos(season, (t.events ?? []).map((e) => e.code)) : {};
  if (stale(r)) return;
  if (!t) {
    // not played this season: if it played last season, show who it is and the EPA it starts on
    // who it is (if it played last season) and the seasons it did play, checked file by file
    const [p, playedIn] = await Promise.all([
      data.pre(season).then((list) => list.find((x) => x.team === n)),
      Promise.all(state.seasons.filter((s) => s !== season).map((s) => data.team(s, n).then((x) => (x?.matches?.length ? [s, x] : null)).catch(() => null))),
    ]);
    if (stale(r)) return;
    const seasons = playedIn.filter(Boolean);
    const others = seasons.length
      ? `<div class="row nm-seasons">${seasons.map(([s, x]) => `<a class="pill" href="#/${s}/team/${n}">${seasonLabel(s, "")} <span class="faint">#${fmtInt(x.rank)}</span></a>`).join("")}</div>`
      : "";
    // a little robot crossing an empty field: nothing to show yet, but alive
    const waiting = `<svg class="wait-field" viewBox="0 0 600 150" aria-hidden="true">
      <rect x="1" y="1" width="598" height="148" rx="14" class="wf-mat"/>
      ${[100, 200, 300, 400, 500].map((x) => `<line x1="${x}" y1="1" x2="${x}" y2="149" class="wf-line"/>`).join("")}
      <line x1="1" y1="75" x2="599" y2="75" class="wf-line"/>
      <path d="M40 112 C 160 112, 200 38, 300 38 S 440 112, 560 112" class="wf-path"/>
      <g class="wf-bot">${ROBOT_PARTS}</g>
    </svg>`;
    const header = p ? `<div class="card card-pad team-hero"><div class="th-top">
        <div class="th-id">
          <h1><span class="team-num">${n}</span> ${esc(p.name)}</h1>
          <div class="muted">${esc(p.loc ?? "")}</div>
        </div>
        <div class="th-epa">
          <div class="label" title="Carried over from its past seasons; it moves once the team plays">Predicted EPA</div>
          <b>${fmt(p.np)}</b>
          <div class="th-ranks desk-only"><span>Auto <b>${fmt(p.auto)}</b></span><span>Teleop <b>${fmt(p.teleop)}</b></span><span>Endgame <b>${fmt(p.endgame)}</b></span></div>
        </div>
      </div></div>` : "";
    app.innerHTML = `${header}
      <div class="card card-pad section no-matches">
        ${waiting}
        <h2>${p ? `No matches in ${seasonLabel(season, "")} yet` : `Team ${n}${seasons[0] ? ` · ${esc(seasons[0][1].name)}` : ""} has no matches in ${seasonLabel(season, "")}`}</h2>
        ${!p && !seasons.length ? `<p class="muted">No FTC matches on record.</p>` : ""}
        ${others}
      </div>`;
    return;
  }
  const evName = new Map((t.events ?? []).map((e) => [e.code, e.name]));
  const e = t.epa;
  // only off-season matches so far: the build lists such teams last, so a rank would mislead
  const official = t.matches.some((m) => !m.off);
  const phone = matchMedia("(max-width: 640px)").matches;
  const w = t.matches.filter((m) => m.score > m.oppScore).length;
  const l = t.matches.filter((m) => m.score < m.oppScore).length;
  const ti = t.matches.length - w - l;

  // world, country and state/province ranks (precomputed by the build), each [label, rank, out of]
  const places = t.places ?? {};


  // header: who they are and their EPA on top; then the radar, its numbers and the
  // rank tiles side by side (plus photos when there are any); awards along the bottom
  const awards = t.awards ?? [];
  const plaques = awards.filter((a) => !isBanner(a)), banners = awards.filter(isBanner);
  const fact = (b, k) => `<span class="th-fact"><b>${b}</b> ${k}</span>`;
  // ranks as one line under the EPA, e.g. "#26 World · #8 Romania · #1 BZ"
  const rankLine = !official
    ? `<span class="th-unranked" title="Only off-season matches so far; official events decide the rank">Not ranked yet</span>`
    : [["World", t.rank, t.of], places.country, places.state].filter(Boolean)
      .map(([label, rank, of]) => `<span title="out of ${fmtInt(of)}" class="${rank === 1 ? "gold-rank" : ""}"><b>#${fmtInt(rank)}</b> ${esc(label)}</span>`).join("");
  app.innerHTML = `
    <div class="card card-pad team-hero">
      <div class="th-top">
        <div class="th-left">
        <div class="th-id">
          <h1><span class="team-num">${n}</span> ${esc(t.name)}</h1>
          <div class="muted">${esc(t.loc)}${t.rookie ? ` · Rookie year ${t.rookie}` : ""}</div>
          <div class="th-facts">
            ${fact(`${w}-${l}${ti ? `-${ti}` : ""}`, "record")}
            ${fact(t.matches.length ? pct(w / t.matches.length) : "–", "win rate")}
            ${awards.length ? `<span class="th-fact th-awards-sum"><b>${awards.length}</b> award${awards.length === 1 ? "" : "s"}${banners.length ? ` · <b>${banners.length}</b> win${banners.length === 1 ? "" : "s"}` : ""}</span>` : ""}
            ${addPhotoLink(n)}
            ${shareButton(`t/${season}/${n}`, `${n} ${t.name}`)}
          </div>
        </div>
        ${awards.length ? `<div class="th-awards desk-only">
          <div class="banners">${banners.map((a) => banner(a, season)).join("")}</div><div class="plaques">${plaques.map((a) => plaque(a, season)).join("")}</div>
        </div>` : ""}
        </div>
        <div class="th-epa">
          <div class="label">${official ? "EPA · points added per match" : "EPA · carried from past seasons"}</div>
          <b>${fmt(e.np)}</b>
          <div class="th-ranks">${rankLine}</div>
        </div>
      </div>
      <div class="th-body">
        <div class="radar-box desk-only" id="radar"></div>
        <div class="th-stats desk-only">
          <div class="stat-grid" id="stat-grid"></div>
        </div>
        <div class="th-photo" id="photo-slot" hidden></div>
      </div>
    </div>
    <div class="row section" style="justify-content:space-between">
      <nav class="seg glass">
        <a href="#/${season}/team/${n}" class="${view === "matches" ? "active" : ""}">Matches</a>
        <a href="#/${season}/team/${n}/charts" class="${view === "charts" ? "active" : ""}">Charts</a>
      </nav>
    </div>
    <div id="view"></div>`;

  // meta.radarDist: each axis's spread over the season's teams (older data: from teams.json)
  (meta.radarDist ? Promise.resolve(null) : data.teams(season)).then((rows) => {
    if (stale(r) || !$("#radar")) return;
    const axes = teamAxes(meta, t, rows);
    $("#radar").innerHTML = radar(axes, { values: false });
    const pill = (ax) => {
      const top = ax.value == null ? null : Math.max(1, Math.round((1 - ax.value) * 100));
      return `<span class="stat-pct ${top === 1 ? "gold" : top != null && top <= 10 ? "hot" : top != null && top <= 25 ? "warm" : ""}">${top == null ? "–" : `Top ${top}%`}</span>`;
    };
    $("#stat-grid").innerHTML = `<div class="stat-main">${axes.filter((a) => a.main).map((ax) => `<div class="stat-card" title="${esc(ax.tip)}"><div class="k">${esc(ax.label)}</div><b>${ax.display}</b>${pill(ax)}</div>`).join("")}</div>
      <div class="stat-minor">${axes.filter((a) => !a.main).map((ax) => `<div class="stat-mini" title="${esc(ax.tip)}"><span class="k">${esc(ax.label)}</span><b>${ax.display}</b>${pill(ax)}</div>`).join("")}</div>`;
  }).catch(() => {});

  // photos come from a separate service; show the page now and add them when they arrive
  showPhotos(n, r);

  if (view === "charts") {
    // ?g=epa | compare (&vs=team for compare)
    // ?g=reliable only where FTC's score data credits some points to each robot
    const specs = SEASONS[season]?.solo ?? [];
    const GRAPHS = [["epa", "EPA"], ...(specs.length ? [["reliable", "Reliability"]] : []), ["compare", "Compare"]];
    const ms = t.matches;
    const bands = [];
    ms.forEach((m, i) => {
      const last = bands[bands.length - 1];
      if (last && last.ev === m.ev) last.to = i;
      else bands.push({ ev: m.ev, from: i, to: i, label: shortEvent(evName.get(m.ev) ?? m.ev) });
    });
    const head = (m) => `<b>${esc(evName.get(m.ev) ?? m.ev)}</b> · ${esc(m.m)}`;
    const result = (m) => `${m.score > m.oppScore ? "W" : m.score < m.oppScore ? "L" : "T"} ${m.score}–${m.oppScore}`;
    const note = (s) => ($("#chart-note").textContent = s);
    $("#view").innerHTML = `<div class="card card-pad section team-chart">
      <div class="chart-head"><nav class="seg" id="graph-pick"></nav><span id="chart-tools"></span></div>
      <p class="small muted" id="chart-note"></p><div id="chart"></div></div>`;
    // switching graphs redraws just the chart (the URL updates quietly), not the whole page
    const q = { g: GRAPHS.some(([k]) => k === r.query.get("g")) ? r.query.get("g") : "epa", vs: r.query.get("vs") ?? "" };
    const drawGraph = async () => {
      const g = q.g;
      syncQuery({ g: g === "epa" ? "" : g, vs: g === "compare" ? q.vs : "" });
      $("#graph-pick").innerHTML = GRAPHS.map(([k, l]) => `<a href="#/${season}/team/${n}/charts${k === "epa" ? "" : `?g=${k}`}" data-g="${k}" class="${k === g ? "active" : ""}">${l}</a>`).join("");
      $("#chart-tools").innerHTML = g === "compare" ? `<form id="vs-form" class="vs-form"><input id="vs" inputmode="numeric" placeholder="Compare with team #" value="${esc(q.vs)}" aria-label="Team to compare with"><button class="btn btn-solid">Compare</button></form>` : "";
      $("#chart").innerHTML = "";
      if (g === "epa") {
        // phones: the overall EPA line only (no auto / teleop / endgame split)
        note("");
        mountLineChart($("#chart"), {
          series: [
            { name: "EPA", color: "var(--text)", values: ms.map((m) => m.epa[0]), width: 2.5, smooth: true },
            ...(phone ? [] : [
              { name: "Auto", color: "#f59e0b", values: ms.map((m) => m.epa[1]), smooth: true },
              { name: "Teleop", color: "var(--accent)", values: ms.map((m) => m.epa[2]), smooth: true },
              { name: "Endgame", color: "#10b981", values: ms.map((m) => m.epa[3]), smooth: true },
            ]),
          ],
          bands, xTitle: "Match #",
          tooltip: (i) => `${head(ms[i])}<br>EPA ${fmt(ms[i].epa[0])} · ${result(ms[i])}`,
        });
      } else if (g === "reliable") {
        // quals where this robot's own points are known; share of the last 10 that scored each element
        const qs = ms.filter((m) => m.solo);
        const qBands = [];
        qs.forEach((m, i) => {
          const last = qBands[qBands.length - 1];
          if (last && last.ev === m.ev) last.to = i;
          else qBands.push({ ev: m.ev, from: i, to: i, label: shortEvent(evName.get(m.ev) ?? m.ev) });
        });
        const did = (m, j) => (m.solo[j] ?? 0) > 0;
        // neutral grey and the accent (no extra hues); the season totals live in the legend
        const COLORS = ["var(--muted)", "var(--accent)", "var(--text)", "var(--faint)"];
        note(!qs.length ? "No qualification matches with per-robot scores yet." : "Share of its last 10 quals where this robot did each one.");
        // lines start once the 10-match window is full (before that, a 0 at match 1 is just the window filling)
        const start = qs.length >= 10 ? 9 : 0;
        if (qs.length) mountLineChart($("#chart"), {
          series: specs.map((sp, j) => ({
            name: `${sp.label[0].toUpperCase() + sp.label.slice(1)} ${qs.filter((m) => did(m, j)).length}/${qs.length}`, color: COLORS[j % COLORS.length], width: 2.5,
            values: qs.map((_, i) => { if (i < start) return null; const w = qs.slice(Math.max(0, i - 9), i + 1); return Math.round((w.filter((m) => did(m, j)).length / w.length) * 100); }),
          })),
          bands: qBands, max: 100, xTitle: "Qual #",
          tooltip: (i) => `${head(qs[i])}<br>${specs.map((sp, j) => `${did(qs[i], j) ? "✓" : "✗"} ${esc(sp.label)}`).join("<br>")}`,
        });
      } else {
        const vs = /^\d{1,6}$/.test(q.vs) ? +q.vs : null;
        // keep the reader where they are: the redraw empties the chart for a moment
        $("#vs-form").onsubmit = (e) => { e.preventDefault(); q.vs = $("#vs").value.trim(); const y = scrollY; drawGraph().then(() => scrollTo(0, y)); };
        const other = vs != null && vs !== n ? await data.team(season, vs).catch(() => null) : null;
        if (stale(r) || q.g !== "compare") return;
        if (vs != null && !other) note(`Team ${vs} has no matches in ${season}.`);
        else note("");
        // nothing to compare yet: just the box (the EPA tab already shows this team's line)
        if (!other) return;
        const om = other?.matches ?? [];
        const len = Math.max(ms.length, om.length);
        const pad = (arr) => Array.from({ length: len }, (_, i) => arr[i] ?? null);
        mountLineChart($("#chart"), {
          series: [
            { name: `${n} ${t.name}`, color: "var(--accent)", values: pad(ms.map((m) => m.epa[0])), width: 2.5, smooth: true },
            ...(other ? [{ name: `${vs} ${other.name}`, color: "var(--muted)", values: pad(om.map((m) => m.epa[0])), width: 2.5, smooth: true }] : []),
          ],
          xTitle: "Match # of season",
          tooltip: (i) => [[n, ms[i]], [vs, om[i]]].filter(([, m]) => m).map(([num, m]) => `<b>${num}</b> · ${esc(evName.get(m.ev) ?? shortEvent(m.ev))} ${esc(m.m)} · EPA ${fmt(m.epa[0])}`).join("<br>") + `<br><span class="faint">match ${i + 1}</span>`,
        });
      }
    };
    $("#graph-pick").onclick = (e) => {
      const a = e.target.closest("[data-g]");
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      if (a.dataset.g !== q.g) { q.g = a.dataset.g; drawGraph(); }
    };
    drawGraph();
    return;
  }

  // one card per event, newest first; what the team won there sits beside the event name
  const awardPill = (a) => {
    const place = a.placement > 1 && !["Winner", "Finalist", "DivisionWinner", "DivisionFinalist"].includes(a.type) ? ` · ${ordinal(a.placement)}` : "";
    // gold: banners plus making the final (finalist alliances); banners alone still decide the trophy case
    const gold = isBanner(a) || ["Finalist", "DivisionFinalist"].includes(a.type);
    return `<span class="ev-award ${gold ? "win" : ""}">${esc((AWARD_NAMES[a.type] ?? a.type).replace(/ Award$/, ""))}${place}</span>`;
  };
  $("#view").innerHTML = [...t.events].reverse().map((ev) => {
    const won = (t.awards ?? []).filter((a) => a.ev === ev.code).sort((a, b) => isBanner(b) - isBanner(a) || ["Finalist", "DivisionFinalist"].includes(b.type) - ["Finalist", "DivisionFinalist"].includes(a.type));
    const ms = t.matches.filter((m) => m.ev === ev.code).map((m) => toMatch(m, n));
    const video = (m) => videoFor(videos, ev.code, m.time);
    return `<div class="card section">
      <div class="ev-head">
        <div>
          <div class="ev-title"><h2><a href="#/${season}/event/${ev.code}">${esc(ev.name)}</a></h2>${won.map(awardPill).join("")}</div>
          <div class="small muted">${typeName(ev.type)} · ${fmtDate(ev.start, { month: "short", day: "numeric", year: "numeric" })}</div>
        </div>
        <div class="ev-box">
          <div><span class="k">Rank</span><b>${ev.rank ?? "–"}</b></div>
          <div><span class="k">Record</span><b>${ev.wins != null ? `${ev.wins}-${ev.losses}${ev.ties ? `-${ev.ties}` : ""}` : "–"}</b></div>
          <div title="EPA after its last match at this event"><span class="k">EPA</span><b>${fmt(ev.epaEnd ?? ev.epaStart)}</b></div>
        </div>
      </div>
      ${matchTable(season, ms, { me: n, rpNames: meta.rpNames, video, href: (m) => matchHref(season, ev.code, m.d) })}
    </div>`;
  }).join("");
}

// The radar's five attributes, each the team's percentile among this season's
// teams with 5+ matches: points from auto, teleop and endgame, then bonus ranking
// points as one axis (seasons that have them; consistency otherwise), then win rate.
function teamAxes(meta, t, rows) {
  const e = t.epa;
  const dist = meta.radarDist;
  const pool = rows?.filter((x) => x.matches >= 5) ?? [];
  const pctile = (v, all) => {
    const xs = all.filter((x) => x != null && !Number.isNaN(x));
    if (v == null || !xs.length) return null;
    let below = 0, same = 0;
    for (const x of xs) { if (x < v) below++; else if (x === v) same++; }
    return (below + same / 2) / xs.length;
  };
  const col = (k) => dist?.[k] ?? pool.map((x) => x[k]);
  const period = (k, label) => ({ label, value: pctile(e[k], col(k)), display: fmt(e[k]), tip: `${label}: ${fmt(e[k])} points a match` });
  // bonus RPs: how many of the season's bonus RPs it earns in an average match
  const nRp = meta.rpNames.length;
  const rpSum = (get) => meta.rpNames.reduce((sum, _, i) => sum + Math.min(1, Math.max(0, get(i) ?? 0)), 0);
  const rate = (x) => (x.matches ? (x.wins + x.ties / 2) / x.matches : null);
  const w = t.matches.filter((m) => m.score > m.oppScore).length, ti = t.matches.filter((m) => m.score === m.oppScore).length;
  const myRate = t.matches.length ? (w + ti / 2) / t.matches.length : null;
  const cons = t.cons !== undefined ? t.cons : rows?.find((x) => x.team === t.team)?.cons ?? null;
  const myRp = rpSum((i) => e.rp[i]);
  // the three scoring periods lead; RPs, win rate and consistency are supporting numbers
  const main = [period("auto", "Auto"), period("teleop", "Teleop"), period("endgame", "Endgame")].map((a) => ({ ...a, main: true }));
  return [
    ...main,
    ...(nRp ? [{ label: "RPs", value: pctile(myRp, dist?.rp ?? pool.map((x) => rpSum((i) => x[`rp${i}`]))), display: fmt(myRp),
      tip: `Bonus ranking points a match: ${fmt(myRp)} (${meta.rpNames.map((nm, i) => `${nm} ${pct(Math.min(1, Math.max(0, e.rp[i])))}`).join(", ")})` }] : []),
    { label: "Win rate", value: pctile(myRate, dist?.win ?? pool.map(rate)), display: pct(myRate), tip: `Won ${pct(myRate)} of its matches (partners count too)` },
    // steadier is better, so rank by the negative of the typical miss
    { label: "Consistency", value: cons == null ? null : pctile(-cons, dist?.cons ?? pool.filter((x) => x.cons != null).map((x) => -x.cons)),
      display: cons == null ? "–" : `±${pct(cons)}`, tip: cons == null ? "Consistency: needs 5+ matches" : `Consistency: its alliance's score typically lands within ±${pct(cons)} of the prediction` },
  ];
}

function addPhotoLink(n) {
  const href = CONFIG.photoApi ? `#upload-${n}` : `${PHOTO_FORM}&title=${encodeURIComponent(`Photo for team ${n}`)}&team=${n}`;
  return `<a class="th-fact th-add" href="${href}" data-upload="${n}"${CONFIG.photoApi ? "" : ' target="_blank" rel="noopener"'}>＋ Add a photo</a>`;
}

// Team photo area: approved photos (click to see the next one), or an invite to add one.
const PHOTO_FORM = "https://github.com/Katluver44/FTCstats/issues/new?template=team-photo.yml";
function teamPhotos(n, list) {
  const add = CONFIG.photoApi ? `#upload-${n}` : `${PHOTO_FORM}&title=${encodeURIComponent(`Photo for team ${n}`)}&team=${n}`;
  const target = CONFIG.photoApi ? "" : ' target="_blank" rel="noopener"';
  if (!list.length) {
    return `<aside class="team-photo empty-photo"><a href="${add}" data-upload="${n}"${target}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="12" cy="12.5" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/></svg>
      <b>Add a photo</b><span class="small muted">Robot photos welcome.</span></a></aside>`;
  }
  const items = list.map((p, i) => `<figure class="${i ? "" : "on"}"><img src="${esc(p.file)}" alt="Team ${n}${p.caption ? `: ${esc(p.caption)}` : ""}" loading="lazy"><figcaption>${[p.caption && esc(p.caption), p.credit && `photo by ${esc(p.credit)}`].filter(Boolean).join(" · ")}</figcaption></figure>`).join("");
  return `<aside class="team-photo" data-count="${list.length}">${items}
    <div class="photo-bar">${list.length > 1 ? `<button class="photo-next" aria-label="Next photo">${list.length} photos ›</button>` : ""}<a class="small link" href="${add}" data-upload="${n}"${target}>Add a photo</a></div></aside>`;
}

// photos uploaded in this visit (the service's list is cached for a minute)
const addedPhotos = {};
function showPhotos(n, r) {
  data.photos(CONFIG.photoApi).catch(() => ({})).then((p) => {
    const slot = $("#photo-slot");
    const seen = new Set((p[n] ?? []).map((x) => x.file));
    const list = [...(addedPhotos[n] ?? []).filter((x) => !seen.has(x.file)).reverse(), ...(p[n] ?? [])];
    if ((r && stale(r)) || !slot || String(slot.dataset.team ?? n) !== String(n) || !list.length) return;
    slot.innerHTML = teamPhotos(n, list);
    slot.hidden = false;
    slot.closest(".th-body")?.classList.add("has-photo");
  });
}

// Upload dialog: shrink the photo in the browser (which also drops GPS and
// other metadata), then send it to the photo service; it shows up right away.
function openUpload(team) {
  const dlg = document.createElement("dialog");
  dlg.className = "upload-dialog";
  dlg.innerHTML = `<form method="dialog">
    <h2>Add a photo for team ${esc(team)}</h2>
    <p class="small muted">Robot photos are best. Only post people who agreed to it (a parent or guardian for anyone under 18).</p>
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
      msg.textContent = res.ok ? out.message ?? "Thanks! Your photo is up." : out.error ?? "Upload failed.";
      if (res.ok && out.photo) {
        // show it now (the photo list is cached for a minute)
        addedPhotos[team] = [...(addedPhotos[team] ?? []), { file: out.photo.url, caption: out.photo.caption, credit: "" }];
        showPhotos(team);
      }
      if (res.ok) setTimeout(() => dlg.close(), 1500);
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
      <path d="M2.5 2.5h35v49.9l-17.5-8.75-17.5 8.75z" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.5"/>
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

// Share button: a short link (/t/2025/14270, /e/…, /m/…) whose preview shows a
// card for that team, event or match (see photo-service/api/share.js)
const SHARE_ICON = '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 9V1.8M4 4.6 7 1.6l3 3M2.5 7.5v4.2h9V7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const shareButton = (path, title) => `<button class="pill share-btn" data-share="${esc(path)}" data-title="${esc(title)}" title="Copy a link that shows a preview card when shared">${SHARE_ICON} Share</button>`;
async function share(btn) {
  const url = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}${btn.dataset.share}`;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) return await navigator.share({ title: btn.dataset.title, url });
    await navigator.clipboard.writeText(url);
    const old = btn.innerHTML;
    btn.textContent = "Link copied";
    setTimeout(() => (btn.innerHTML = old), 1600);
  } catch {}
}

// YouTube's privacy-enhanced player: no cookies until the viewer presses play.
// Bilibili's outside player; "Open on Bilibili" is the fallback if it won't play.
function openVideo(id, t, title) {
  const dlg = document.createElement("dialog");
  dlg.className = "video-dialog";
  const l = videoLinks(id, t);
  dlg.innerHTML = `<div class="video-head"><b>${esc(title ?? "")}</b>
    <a class="small link" href="${l.open}" target="_blank" rel="noopener">Open on ${l.site} ↗</a>
    <button class="video-close" aria-label="Close">✕</button></div>
    <div class="video-frame"><iframe src="${l.embed}" title="${esc(title ?? "Match video")}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
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
    d: m.m, ev: m.ev, played: true, time: m.time,
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
  for (const e of evs) { e.country = e.loc.split(", ").pop() ?? ""; e.region = regionOf(e.loc); e.month = e.start.slice(0, 7); }
  const countries = [...new Set(evs.map((e) => e.country).filter(Boolean))].sort();
  const months = [...new Set(evs.map((e) => e.month))].sort();
  const monthName = (ym) => new Date(`${ym}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const status = (e) => (e.ongoing ? "live" : e.finished ? "done" : "upcoming");
  app.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="filter" placeholder="Search events…" value="${esc(query.get("q") ?? "")}">
        <select id="type" aria-label="Event type"><option value="" data-all="All types">Type</option>${types.map((t) => `<option value="${esc(t)}" ${t === query.get("type") ? "selected" : ""}>${esc(typeName(t))}</option>`).join("")}</select>
        <select id="country" aria-label="Country"><option value="" data-all="All countries">Country</option>${countries.map((c) => `<option ${c === query.get("country") ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="state" aria-label="State or region" hidden></select>
        <select id="month" aria-label="Month"><option value="" data-all="Any month">Month</option>${months.map((m) => `<option value="${m}" ${m === query.get("month") ? "selected" : ""}>${monthName(m)}</option>`).join("")}</select>
        <select id="status" aria-label="Status"><option value="" data-all="Any status">Status</option>${[["upcoming", "Upcoming"], ["live", "Live now"], ["done", "Finished"]].map(([k, l]) => `<option value="${k}" ${k === query.get("status") ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      <div id="tbl"></div>
    </div>`;
  const cols = [
    { key: "name", label: "Event", sort: false, render: (e) => evCell(season, e.code, e.name, `${esc(e.loc)} ${e.ongoing ? '<span class="pill live">Live</span>' : ""}`) },
    { key: "start", label: "Date", cls: "c small muted", render: (e) => fmtDate(e.start) },
    { key: "type", label: "Type", cls: "c small muted hide-sm", render: (e) => esc(typeName(e.type)) },
    { key: "teams", label: "Teams", cls: "r" },
    { key: "played", label: "Matches", cls: "r small hide-sm", render: (e) => (e.matches ? (e.played < e.matches ? `${e.played}/${e.matches}` : e.matches) : "–") },
    { key: "strength", label: "Strength", cls: "r desk-only", render: (e) => epa(e.strength, meta) },
  ];
  const table = sortableTable($("#tbl"), evs, cols, { sortKey: "start" });
  const fillStates = regionSelect($("#state"), () => evs.filter((e) => e.country === $("#country").value), query.get("state"));
  const apply = () => {
    const q = $("#filter").value.trim().toLowerCase(), ty = $("#type").value, c = $("#country").value, st = $("#state").value, mo = $("#month").value, stat = $("#status").value;
    syncQuery({ q: $("#filter").value.trim(), type: ty, country: c, state: st, month: mo, status: stat });
    table.setRows(evs.filter((e) => (!ty || e.type === ty) && (!c || e.country === c) && (!st || e.region === st) && (!mo || e.month === mo) && (!stat || status(e) === stat) &&
      (!q || e.name.toLowerCase().includes(q) || e.code.toLowerCase().includes(q) || e.loc.toLowerCase().includes(q))));
  };
  $("#filter").oninput = apply; $("#type").onchange = apply; $("#state").onchange = apply; $("#month").onchange = apply; $("#status").onchange = apply;
  $("#country").onchange = () => { fillStates(); apply(); };
  fillStates();
  apply();
}

// ---------------- event ----------------

async function event(r) {
  const { season, args } = r;
  const code = args[0], tab = args[1] ?? "matches";
  const [meta, ev, videos, official] = await Promise.all([data.meta(season), data.event(season, code).catch(() => null), data.videos(season, [code]), data.alliances(season)]);
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
      if (tab !== "forecast" && tab !== "advancement") draw();
    } catch (e) { console.warn(e); }
  };

  const draw = () => {
    const played = matches.filter((m) => m.played);
    const hasQuals = matches.some((m) => m.level === "Quals");
    // forecast needs a quals schedule, or no matches yet (pre-event); playoff-only events get none.
    // Once quals are done it still replays: "what did the forecast say after match N?"
    const canForecast = hasQuals || (!matches.length && ev.teamList.length >= 4);
    const hasPlayoffs = matches.some((m) => m.level && m.level !== "Quals");
    // advancement points: FIRST's numbers once the event is over, a forecast before (divisions are scored in the parent event)
    const canAdv = !!advRules(season) && ADVANCING_TYPES.has(ev.type) && !ev.divisionOf
      && (ev.adv ? true : !ev.finished && !ev.divisions && ev.teamList.length >= 4 && canForecast);
    const tabs = [["matches", "Matches"], ["teams", "Teams"], ...(ev.teamList.length >= 4 ? [["pickmap", "Pick list"]] : []), ...(hasPlayoffs ? [["playoffs", "Playoffs"]] : []), ...(canAdv ? [["advancement", "Advancement"]] : []), ...(canForecast ? [["forecast", "Rankings forecast"]] : [])];
    app.innerHTML = `
      <div class="card card-pad"><div class="page-head">
        <div>
          <div class="kicker">${esc(typeName(ev.type))} · ${fmtRange(ev.start, ev.end)} · ${esc(ev.loc)}</div>
          <h1>${esc(ev.name)}</h1>
          <div class="row" style="margin-top:8px">
            ${liveAt ? `<span class="pill live">Live · updated ${liveAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>` : ""}
            <span class="pill">${ev.teams} teams</span><span class="pill">${played.length}/${matches.length} matches played</span>
            <a class="pill desk-only" href="https://ftcscout.org/events/${season}/${encodeURIComponent(code)}" target="_blank" rel="noopener">FTCScout ↗</a>
            ${shareButton(`e/${season}/${encodeURIComponent(code)}`, ev.name)}
            ${videos?.[code]?.streams?.[0] ? `<button class="pill" data-video="${videos[code].streams[0].id}" data-t="0"${videos[code].streams[0].ext ? ' data-ext="1"' : ""} data-title="${esc(ev.name)}">▶ Event stream</button>` : ""}
          </div>
        </div>
      </div></div>
      <nav class="tabs seg glass">${tabs.map(([k, label]) => `<a href="#/${season}/event/${code}/${k}" class="${k === (tabs.some(([t]) => t === tab) ? tab : "matches") ? "active" : ""}">${label}</a>`).join("")}</nav>
      <div id="tab"></div>`;
    // On phones the tab strip scrolls sideways (style.css); keep the chosen tab in view after each redraw.
    const nav = $(".tabs"), active = nav.querySelector("a.active");
    if (active) nav.scrollLeft += active.getBoundingClientRect().right - nav.getBoundingClientRect().right;
    if (tab === "teams") eventTeams(season, meta, ev, matches);
    else if (tab === "pickmap" && ev.teamList.length >= 4) eventPickMap(season, ev);
    else if (tab === "playoffs" && hasPlayoffs) eventPlayoffs(season, meta, ev, matches, official[code], (m) => videoFor(videos, code, m.time));
    else if (tab === "forecast" && canForecast) eventForecast(season, meta, ev, matches);
    else if (tab === "advancement" && canAdv) eventAdvancement(season, meta, ev, matches, official[code]);
    else {
      // mid-event, phones only (style.css): a button above the table jumps to the first unplayed match
      // instead of a scroll past every played one
      const played = matches.filter((m) => m.played).length, nextUp = !ev.finished && played ? matches.find((m) => !m.played) : null;
      $("#tab").innerHTML = `<div class="card">
        ${nextUp ? `<div class="mt-jump"><button type="button" class="pill" id="mt-jump">${played} of ${matches.length} played · Jump to ${esc(nextUp.d)} ↓</button></div>` : ""}
        ${matchTable(season, matches, { rpNames: meta.rpNames, video: (m) => videoFor(videos, code, m.time), href: (m) => matchHref(season, code, m.d) })}</div>`;
      $("#mt-jump")?.addEventListener("click", () => $("#tab .mt tr.up")?.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
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
    <td><div class="al-teams">${a.teams.map((t) => tn(t)).join("")}</div><div class="al-name">${esc(name(a.captain))}</div></td>
    <td class="r desk-only"><b>${fmt(strength(a))}</b></td>
    <td class="r small muted desk-only">${record(a)}</td>
    <td class="small res ${a.result === "Winner" ? "res-win" : a.result === "Finalist" ? "res-final" : "muted"}">${esc(a.result)}</td>
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
    // series: every game's score, tinted by who won it
    const games = series ? s.games.filter((g) => g.played).map((g) => {
      const w = g.redScore.total > g.blueScore.total ? "red" : g.blueScore.total > g.redScore.total ? "blue" : "";
      return `<a class="bgame ${w}" href="${matchHref(season, ev.code, g.d)}" title="${esc(g.d)}">${g.redScore.total}–${g.blueScore.total}</a>`;
    }).join("") : "";
    const noShow = last && ((last.redOn && !last.redOn.length) || (last.blueOn && !last.blueOn.length));
    const pred = noShow ? `<span class="faint" title="One alliance had no robots on the field">forfeit</span>` : pRed != null ? `<span class="faint" title="Our pre-match win probability for the favourite">A${pRed >= 0.5 ? s.red.seed : s.blue.seed} ${Math.round(Math.max(pRed, 1 - pRed) * 100)}%</span>` : "";
    return `<div class="bbox">
      ${line(s.red, "red")}${line(s.blue, "blue")}
      ${games ? `<div class="bgames">${games}</div>` : ""}
      <div class="bf"><a class="bk match-link" href="${matchHref(season, ev.code, (last ?? s.games[0]).d)}" title="Match details">${esc(s.key)}${series ? " · best of 3" : ""}</a>
        <span class="bf-r">${pred}${v ? `<button class="play" data-video="${v.id}" data-t="${v.t}"${v.ext ? ' data-ext="1"' : ""} data-title="${esc(`${ev.name} · ${last.d}`)}" aria-label="Watch ${esc(s.key)}" title="Watch">${PLAY_ICON}</button>` : ""}</span></div>
    </div>`;
  };

  // a match nobody has reached yet: who it's waiting on ("Winner M-3", "A1")
  const who = (x) => (x[0] === "A" ? `<span class="seed">${x}</span>` : `<span class="faint">${x[0] === "W" ? "Winner" : "Loser"} M-${x.slice(1)}</span>`);
  const pendingBox = (s) => `<div class="bbox pending">
      <div class="bl red">${who(s.pending[0])}</div><div class="bl blue">${who(s.pending[1])}</div>
      <div class="bf"><span class="bk">${esc(s.key)}</span><span class="faint">upcoming</span></div></div>`;
  const slot = (s) => `<div class="bslot" data-key="${esc(s.key)}">${s.pending ? pendingBox(s) : box(s)}</div>`;

  let bracket, wide;
  if (p.columns) {
    // FTC double elimination, laid out like the manual's figure: one column per round,
    // upper bracket on top, lower bracket below, finals on the right across both
    const cols = p.columns, n = cols.length;
    const cell = (c, i, part, row) => `<div class="dcell" style="grid-column:${i + 1};grid-row:${row}">${(c[part] ?? []).map(slot).join("")}</div>`;
    const hasLower = cols.some((c) => c.lower?.length);
    bracket = `<div class="dgrid" style="--cols:${n}">
      ${cols.map((c, i) => `<div class="bcol-h" style="grid-column:${i + 1};grid-row:1">${esc(c.name)}</div>`).join("")}
      ${n > 1 ? `<div class="bsec-h" style="grid-column:1/${n};grid-row:2">${p.roundRobin ? "Round robin: every alliance plays every other once" : "Upper bracket"}</div>` : ""}
      ${cols.slice(0, -1).map((c, i) => cell(c, i, "upper", 3)).join("")}
      ${hasLower ? `<div class="bsec-h lower-h" style="grid-column:1/${n};grid-row:4">Lower bracket</div>${cols.slice(0, -1).map((c, i) => cell(c, i, "lower", 5)).join("")}` : ""}
      <div class="dcell dfinal" style="grid-column:${n};grid-row:${n > 1 ? `3/${hasLower ? 6 : 4}` : "2/3"}">${cols.at(-1).final.map(slot).join("")}</div>
      <svg class="dlines" aria-hidden="true"></svg>
    </div>`;
    // round robin: standings decide who reaches the final
    if (p.standings) bracket += `<div class="rr-standings"><div class="bsec-h">Round robin standings</div>
      <table><thead><tr><th></th><th>Alliance</th><th class="r">W-L</th><th class="r desk-only">Avg score</th><th></th></tr></thead><tbody>
      ${p.standings.map((r, i) => `<tr class="${i < 2 ? "adv" : ""}"><td class="faint small">${esc(r.place.replace("Tied ", "T-"))}</td>
        <td><span class="seed">A${r.a.seed}</span> ${r.a.teams.map((t) => tn(t)).join("")}</td>
        <td class="r">${r.w}-${r.l}${r.t ? `-${r.t}` : ""}</td><td class="r desk-only">${fmt(r.avg)}</td>
        <td class="small ${i < 2 ? "res-win" : "faint"}">${i < 2 ? "→ Final" : ""}</td></tr>`).join("")}
      </tbody></table><div class="po-note" style="padding-left:0">Ordered by wins, then average score; FIRST's official tiebreakers may differ.</div></div>`;
    wide = n >= 5;
  } else {
    // older seasons' best-of-3 series (and Worlds round robins): rounds left to right, the final beside them
    const finalSec = p.sections.length > 1 && p.sections.at(-1).name === "Final" ? p.sections.at(-1) : null;
    const rest = finalSec ? p.sections.slice(0, -1) : p.sections;
    const rounds = (sec) => sec.rounds.map((r) => `<div class="bcol"><div class="bcol-h">${esc(r.name)}</div><div class="bcol-b">${r.slots.map(slot).join("")}</div></div>`).join("");
    const stack = rest.map((sec) => `<div class="bsec">${sec.name && rest.length > 1 ? `<div class="bsec-h">${esc(sec.name)}</div>` : ""}
      ${sec.roundRobin ? `<div class="rr">${sec.rounds[0].slots.map(box).join("")}</div>` : `<div class="bracket" style="--cols:${sec.rounds.length}">${rounds(sec)}</div>`}</div>`).join("");
    bracket = `<div class="po-stack">${stack}</div>
      ${finalSec ? `<div class="po-final"><div class="bcol-h">Final</div>${finalSec.rounds[0].slots.map(slot).join("")}</div>` : ""}`;
    // big brackets need the full width, so the alliances go underneath
    wide = Math.max(0, ...rest.map((sec) => sec.rounds.length)) + (finalSec ? 1 : 0) >= 4;
  }

  $("#tab").innerHTML = `
    <div class="card playoffs-card ${wide ? "wide" : ""}">
      <div class="po-bracket">${bracket}</div>
      <div class="po-alliances">
        <div class="po-h">Alliances</div>
        <div class="table-wrap"><table class="alliances">
          <thead><tr><th>Seed</th><th>Teams</th><th class="r desk-only" title="Adds the EPAs of each alliance's two best robots">Strength</th><th class="r desk-only">W-L</th><th>Result</th></tr></thead>
          <tbody>${allianceRows}</tbody></table></div>
        ${official ? "" : `<div class="po-note">Seeds worked out from qualification ranks until FIRST publishes the official list.</div>`}
      </div>
    </div>`;  if (p.columns) drawBracketLines($(".dgrid"), p.feeds);
}

// Elbow lines from each match to the one its winner plays next, drawn over the
// bracket grid once it's laid out (and again whenever it resizes).
function drawBracketLines(grid, feeds) {
  const svg = $("svg.dlines", grid);
  const draw = () => {
    const g = grid.getBoundingClientRect();
    svg.setAttribute("width", grid.scrollWidth);
    svg.setAttribute("height", grid.scrollHeight);
    const at = (key) => grid.querySelector(`.bslot[data-key="${CSS.escape(key)}"] .bbox`)?.getBoundingClientRect();
    svg.innerHTML = feeds.map(([from, to, side]) => {
      const a = at(from), b = at(to);
      if (!a || !b) return "";
      const lines = grid.querySelectorAll(`.bslot[data-key="${CSS.escape(to)}"] .bl`);
      const tl = lines[side === "red" ? 0 : 1]?.getBoundingClientRect() ?? b;
      const x1 = a.right - g.left, y1 = a.top + a.height / 2 - g.top;
      const x2 = b.left - g.left, y2 = tl.top + tl.height / 2 - g.top;
      const mx = x2 - 12;
      return `<path d="M${x1},${y1}H${mx}V${y2}H${x2}"/>`;
    }).join("");
  };
  draw();
  new ResizeObserver(draw).observe(grid);
}

// SOS cell: how hard a schedule was, 0-1 (the share of random schedules that would have
// been easier; 0.5 = typical), with the ranking places it cost on hover
const sosCell = (v, places) => {
  if (v == null) return "–";
  const pl = places == null ? "" : Math.abs(places) < 0.5 ? " About even on ranking." : ` It ${places > 0 ? "cost" : "gained"} about ${fmt(Math.abs(places), 1)} ranking places per event.`;
  return `<span class="${v >= 0.8 ? "bad-text" : v <= 0.2 ? "good-text" : ""}" title="Harder than ${Math.round(v * 100)}% of random schedules.${pl}">${v.toFixed(2)}</span>`;
};

// Strength of schedule at one event: same measure as the Teams list column (site/js/sos.js)
function eventSos(season, ev, matches) {
  const ratings = new Map(ev.teamList.filter((t) => t.epaStart != null).map((t) => [t.team, { epa: t.epaStart, rp: t.state?.rp ?? [] }]));
  const quals = matches.filter((m) => m.level === "Quals" && m.red?.length === 2 && m.blue?.length === 2);
  const np = quals.flatMap((m) => (m.played && m.redScore ? [m.redScore.np, m.blueScore.np] : m.pred ? [m.pred.red.np, m.pred.blue.np] : [])).filter(Number.isFinite);
  if (!np.length) return new Map();
  const acc = addEventSos(new Map(), ratings, quals, { winRp: SEASONS[season]?.winRp ?? 2, rankBy: SEASONS[season]?.rankBy, scale: 0.28 * (np.reduce((a, b) => a + b, 0) / np.length) });
  return new Map([...acc].map(([t, a]) => [t, { v: sosValue(a), places: sosPlaces(a) }]));
}

const GEAR_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

// Event Teams tab: one row per team; a gear menu shows / hides columns (remembered per device)
function eventTeams(season, meta, ev, matches = ev.matchList) {
  const sos = eventSos(season, ev, matches);
  const rows = ev.teamList.map((t) => {
    const v = t.epaOut ?? t.epaIn ?? []; // [EPA, auto, teleop, endgame] after its last match here (before, if it hasn't played)
    return { ...t, epa: t.epaNow?.np ?? null, delta: t.epaEnd != null && t.epaStart != null ? t.epaEnd - t.epaStart : null, epaHere: t.epaEnd ?? t.epaStart ?? null,
      auto: v[1] ?? null, teleop: v[2] ?? null, endgame: v[3] ?? null, sos: sos.get(t.team)?.v ?? null, sosPlaces: sos.get(t.team)?.places ?? null,
      wr: t.wins != null && t.wins + t.losses + t.ties ? (t.wins + t.ties / 2) / (t.wins + t.losses + t.ties) : null };
  });
  const cols = [
    { key: "rank", label: "Rank", cls: "num", render: (r) => r.rank ?? "–" },
    { key: "team", label: "Team", sort: false, render: (r) => teamCell(season, r.team, r.name) },
    { key: "wins", label: "Record", cls: "r small", render: (r) => (r.wins != null ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}` : "–") },
    { key: "rp", label: `<span title="Ranking score: the event's official ranking points per match">RS</span>`, cls: "r small", render: (r) => (r.rp != null ? fmt(r.rp, 2) : "–") },
    { key: "epaHere", label: `<span title="${EPA_TIP} After its last match here; coming in, before it has played.">EPA</span>`, cls: "c", render: (r) => epa(r.epaHere, meta) },
    { key: "auto", label: "Auto", cls: "r", render: (r) => fmt(r.auto) },
    { key: "teleop", label: "Teleop", cls: "r", render: (r) => fmt(r.teleop) },
    { key: "endgame", label: "Endgame", cls: "r", render: (r) => fmt(r.endgame) },
    { key: "epaStart", label: `<span title="EPA coming into this event">EPA in</span>`, cls: "r small", render: (r) => fmt(r.epaStart) },
    { key: "delta", label: "Change", cls: "r small", render: (r) => trend(r.delta) },
    { key: "wr", label: "Win rate", cls: "r small", render: (r) => (r.wr == null ? "–" : pct(r.wr)) },
    { key: "sos", label: `<span title="Strength of schedule, 0 to 1: how hard its qualification draws (partners and opponents) were for its ranking, as the share of random schedules here that would have been easier. 0.5 = typical, 1 = hardest">SOS</span>`, cls: "r small", render: (r) => sosCell(r.sos, r.sosPlaces) },
  ];
  const FIXED = new Set(["rank", "team", "epaHere"]);
  const plain = (c) => c.label.replace(/<[^>]+>/g, "");
  // default: the original columns (record, EPA, change, SOS); the gear adds the rest.
  // Phones keep their own choice under a separate key and default to Rank, Team, Record, EPA.
  const phone = matchMedia("(max-width: 640px)").matches;
  const colKey = phone ? "eventCols2m" : "eventCols2";
  const PHONE_HIDDEN = ["rp", "auto", "teleop", "endgame", "epaStart", "delta", "wr", "sos"];
  let hidden = new Set(pref.get(colKey, phone ? PHONE_HIDDEN : ["rp", "auto", "teleop", "endgame", "epaStart", "wr"]));
  // the gear sits in the header row, in the margin right of the last column
  $("#tab").innerHTML = `<div class="card tt-card"><details class="col-pick gear-pick tt-gear"><summary title="Columns" aria-label="Choose columns">${GEAR_ICON}</summary><div id="tt-cols"></div></details><div id="tt"></div></div>`;
  $("#tt-cols").innerHTML = cols.filter((c) => !FIXED.has(c.key)).map((c) => `<button type="button" class="col-btn" data-k="${c.key}" aria-pressed="${!hidden.has(c.key)}">${esc(plain(c))}</button>`).join("");
  const mount = () => sortableTable($("#tt"), rows, cols.filter((c) => !hidden.has(c.key)), { sortKey: "epaHere" });
  mount();
  $("#tt-cols").onclick = (e) => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    const k = b.dataset.k, on = hidden.has(k);
    on ? hidden.delete(k) : hidden.add(k);
    b.setAttribute("aria-pressed", String(on));
    pref.set(colKey, [...hidden]);
    mount();
  };
}

// Pick list: every team at the event, strongest first, as auto / teleop / endgame
// stacked bars. Before any match here it ranks by EPA coming in; once matches are
// played, by EPA after each team's last match here.
function eventPickMap(season, ev) {
  const played = ev.teamList.some((t) => t.epaOut);
  const rows = ev.teamList.map((t) => {
    const v = (played && t.epaOut) || t.epaIn;
    return v && { ...t, np: v[0], auto: v[1], teleop: v[2], endgame: v[3] };
  }).filter(Boolean).sort((a, b) => b.np - a.np);
  const pos = (v) => Math.max(0, v);
  const top = Math.max(1, ...rows.map((t) => pos(t.auto) + pos(t.teleop) + pos(t.endgame)));
  const seg = (v, cls) => (v > 0 ? `<i class="${cls}" style="width:${((v / top) * 100).toFixed(2)}%"></i>` : "");
  $("#tab").innerHTML = `<div class="card card-pad">
    <div class="chart-head"><div>
        <h2 style="margin:0">Pick list</h2>
        <p class="small muted desk-only" style="margin:4px 0 0">${played ? "Ranked by EPA after each team's last match here" : "Ranked by EPA coming into the event"}, split into what each team scores in auto, teleop and endgame.</p>
      </div>
      <div class="pl-legend small"><span><i class="auto"></i>Auto</span><span><i class="teleop"></i>Teleop</span><span><i class="endgame"></i>Endgame</span></div>
    </div>
    <div class="pick-list">${rows.map((t, i) => `<a class="pl-row" href="#/${season}/team/${t.team}" title="Auto ${fmt(t.auto)} · Teleop ${fmt(t.teleop)} · Endgame ${fmt(t.endgame)}">
      <span class="pl-rank faint">${i + 1}</span>
      <span class="pl-team"><b>${t.team}</b> <span class="muted">${esc(t.name)}</span></span>
      <span class="pl-bar">${seg(t.auto, "auto")}${seg(t.teleop, "teleop")}${seg(t.endgame, "endgame")}</span>
      <b class="pl-epa">${fmt(t.np)}</b>
    </a>`).join("")}</div>
  </div>`;
}

function eventForecast(season, meta, ev, matches) {
  const quals = matches.filter((m) => m.level === "Quals");
  if (!quals.length) return rosterForecast(season, meta, ev);
  const playedQuals = quals.filter((m) => m.actuallyPlayed ?? m.played).length;
  const done = playedQuals === quals.length;
  // "simulate from": forecast as it stood after any played qual. Live events start
  // from now; finished ones from before the first match, to compare with how it went.
  let cutoff = done ? 0 : playedQuals;
  const teams = ev.teamList.map((t) => t.team);
  const finalRank = new Map(ev.teamList.map((t) => [t.team, t.rank]));
  const names = new Map(ev.teamList.map((t) => [t.team, t.name]));
  const qualName = (i) => quals[i - 1]?.d ?? `Q-${i}`;
  const asOf = (c) => (c === 0 ? "before the first match" : c === playedQuals && !done ? `now, after ${qualName(c)}` : `after ${qualName(c)}`);

  $("#tab").innerHTML = `${playedQuals ? `<div class="card card-pad fc-from">
      <label for="fc-cut"><b>Forecast as of</b> <span id="fc-as">${asOf(cutoff)}</span></label>
      <input type="range" id="fc-cut" min="0" max="${playedQuals}" step="1" value="${cutoff}" aria-label="Forecast as of match">
      <div class="small muted">Drag to replay the forecast from any point${done ? "; the last column is how it actually finished" : ""}. Each step re-runs 3,000 simulated events.</div>
    </div>` : ""}<div class="card${playedQuals ? " section" : ""}" id="fc"></div>`;

  const run = () => {
    const { model, matches: replayed } = replayEvent(meta, ev, matches.map((m) => ({ ...m, played: m.actuallyPlayed ?? m.played })), cutoff);
    const rows = forecastRankings(season, teams, replayed, 3000, { model });
    const showFinal = ev.teamList.some((t) => t.rank != null) && playedQuals > 0 && (done || cutoff < playedQuals);
    $("#fc").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Proj.</th><th>Team</th><th class="r desk-only">Current RS</th><th class="r desk-only">Proj. RS</th><th class="r">Avg rank</th><th class="r">#1</th><th class="r">Top 4</th><th class="r hide-sm">Top 8</th>${showFinal ? '<th class="r">Actual rank</th>' : ""}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="faint num">${i + 1}</td>
        <td>${teamCell(season, r.team, names.get(r.team))}</td>
        <td class="r small desk-only">${r.currentRs != null ? fmt(r.currentRs, 2) : "–"} <span class="faint" title="matches played">(${r.played} played)</span></td>
        <td class="r desk-only">${fmt(r.meanRs, 2)}</td>
        <td class="r">${fmt(r.meanRank, 1)}</td>
        <td class="r">${probCell(r.p1)}</td>
        <td class="r">${probCell(r.p4)}</td>
        <td class="r hide-sm">${probCell(r.p8)}</td>
        ${showFinal ? `<td class="r"><b>${finalRank.get(r.team) ?? "–"}</b></td>` : ""}
      </tr>`).join("")}</tbody></table></div>`;
  };
  run();
  const cut = $("#fc-cut");
  if (cut) {
    let timer;
    cut.oninput = () => {
      cutoff = +cut.value;
      $("#fc-as").textContent = asOf(cutoff);
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    };
  }
}

// Advancement points (advancement.js): computed from FIRST's rules for finished events
// (scripts/check-advancement.mjs checks them against FIRST's reports), forecast before.
function eventAdvancement(season, meta, ev, matches, official) {
  const names = new Map([...ev.teamList.map((t) => [t.team, t.name]), ...Object.entries(ev.adv?.names ?? {}).map(([t, n]) => [+t, n])]);
  if (ev.adv) {
    const adv = new Set(ev.adv.advanced), dec = new Set(ev.adv.declined);
    const showAdv = adv.size > 0 || dec.size > 0;
    $("#tab").innerHTML = `<div class="card card-pad"><div class="row" style="justify-content:space-between">
        <div class="small muted">Quals, alliance selection, playoff and judged award points, worked out from FIRST's rules and results.</div>
        <a class="pill" href="https://ftc-events.firstinspires.org/${season}/${encodeURIComponent(ev.code)}/advancementpoints" target="_blank" rel="noopener">FIRST report ↗</a>
      </div></div>
      <div class="card section"><div class="table-wrap"><table>
        <thead><tr><th>Rank</th><th>Team</th><th class="r">Total</th><th class="r hide-sm">Awards</th><th class="r hide-sm">Playoff</th><th class="r hide-sm">Selection</th><th class="r hide-sm">Quals</th>${showAdv ? '<th class="r">Advanced</th>' : ""}</tr></thead>
        <tbody>${ev.adv.rows.map(([team, total, judging, playoff, selection, qual], i) => `<tr>
          <td class="faint num">${i + 1}</td>
          <td>${teamCell(season, team, names.get(team) ?? "")}</td>
          <td class="r"><b>${total}</b></td>
          <td class="r hide-sm">${judging || '<span class="faint">–</span>'}</td>
          <td class="r hide-sm">${playoff || '<span class="faint">–</span>'}</td>
          <td class="r hide-sm">${selection || '<span class="faint">–</span>'}</td>
          <td class="r hide-sm">${qual}</td>
          ${showAdv ? `<td class="r">${adv.has(team) ? '<span class="pill">Advanced</span>' : dec.has(team) ? '<span class="faint small">Declined</span>' : ""}</td>` : ""}
        </tr>`).join("")}</tbody></table></div></div>`;
    return;
  }
  // forecast: from the schedule as it stands, or from random schedules before it's out
  const quals = matches.filter((m) => m.level === "Quals");
  const ranks = new Map(ev.teamList.filter((t) => t.rank != null).map((t) => [t.team, t.rank]));
  let rows, sims;
  if (quals.length) {
    const cutoff = quals.filter((m) => m.actuallyPlayed ?? m.played).length;
    const { model, matches: replayed } = replayEvent(meta, ev, matches.map((m) => ({ ...m, played: m.actuallyPlayed ?? m.played })), cutoff);
    rows = forecastRankings(season, ev.teamList.map((t) => t.team), replayed, (sims = 3000), { model, advancement: { official, ranks } });
  } else {
    rows = forecastFromRoster(season, meta, ev, { sims: (sims = 2000), advancement: { official } });
  }
  rows.sort((a, b) => b.eTotal - a.eTotal);
  $("#tab").innerHTML = `<div class="card card-pad"><div class="small muted">Expected points from quals, alliance selection and playoffs over ${fmtInt(sims)} simulated events; judged awards aren't forecast.</div></div>
    <div class="card section">${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Proj.</th><th>Team</th><th class="r"><span title="Expected points, without judged awards">Exp. pts</span></th><th class="r hide-sm">Quals</th><th class="r hide-sm">Selection</th><th class="r hide-sm">Playoff</th><th class="r">Win</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="faint num">${i + 1}</td>
        <td>${teamCell(season, r.team, names.get(r.team))}</td>
        <td class="r"><b>${fmt(r.eTotal, 1)}</b></td>
        <td class="r hide-sm">${fmt(r.eQual, 1)}</td>
        <td class="r hide-sm">${fmt(r.eSel, 1)}</td>
        <td class="r hide-sm">${fmt(r.ePlayoff, 1)}</td>
        <td class="r">${probCell(r.pWin)}</td>
      </tr>`).join("")}</tbody></table></div>` : `<div class="empty">Not enough teams registered yet.</div>`}</div>`;
}

// Before the schedule is out: simulate random FTC schedules from the team list.
function rosterForecast(season, meta, ev) {
  const unrated = ev.teamList.filter((t) => !t.state || t.state.n === 0).length;
  let perTeam = 5;
  $("#tab").innerHTML = `
    <div class="card card-pad">
      <div class="row" style="justify-content:space-between">
        <div><b>Predicted rankings before the schedule is released</b>
          <div class="small muted desk-only">2,000 random qualification schedules, each played out from every team's rating entering the event.${unrated ? ` ${unrated} of ${ev.teamList.length} teams haven't played this season yet, so their rating comes from past seasons (rookies start just below average). Expect early forecasts to be rough.` : ""}</div></div>
        <label class="row small">Matches per team
          <select id="per">${[4, 5, 6, 7, 8].map((n) => `<option ${n === perTeam ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      </div>
    </div>
    <div class="card section" id="fc"></div>`;
  const names = new Map(ev.teamList.map((t) => [t.team, t.name]));
  const epaIn = new Map(ev.teamList.map((t) => [t.team, t.epaStart]));
  const run = () => {
    const rows = forecastFromRoster(season, meta, ev, { perTeam });
    $("#fc").innerHTML = rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Proj.</th><th>Team</th><th class="r"><span title="${EPA_TIP}">EPA</span></th><th class="r">Avg rank</th><th class="r">#1</th><th class="r">Top 4</th><th class="r hide-sm">Top 8</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="faint num">${i + 1}</td>
        <td>${teamCell(season, r.team, names.get(r.team))}</td>
        <td class="r">${epa(epaIn.get(r.team) ?? r.epa, meta)}</td>
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

// ---------------- match ----------------

const matchHref = (season, code, d) => `#/${season}/match/${encodeURIComponent(code)}/${encodeURIComponent(d)}`;

// "Q-12" -> "Qualification 12", "SF2-1" -> "Semifinal 2, game 1", "M-14" -> "Playoff match 14"
function matchTitle(d) {
  let x;
  if ((x = d.match(/^Q-(\d+)$/))) return `Qualification ${x[1]}`;
  if ((x = d.match(/^SF(\d+)-(\d+)$/))) return `Semifinal ${x[1]}, game ${x[2]}`;
  if ((x = d.match(/^F-(\d+)$/))) return `Final, game ${x[1]}`;
  if ((x = d.match(/^M-(\d+)(?:\.(\d+))?$/))) return `Playoff match ${x[1]}${x[2] ? ` (replay ${x[2]})` : ""}`;
  return d;
}

async function match(r) {
  const { season, args } = r;
  const code = args[0], d = decodeURIComponent(args[1] ?? "");
  const [meta, ev, videos] = await Promise.all([data.meta(season), data.event(season, code).catch(() => null), data.videos(season, [code])]);
  if (stale(r)) return;
  if (!ev) {
    app.innerHTML = `<div class="card empty">No event with code “${esc(code)}” in ${seasonLabel(season, meta.game)}. <a class="link" href="#/${season}/events">Browse events →</a></div>`;
    return;
  }
  let matches = ev.matchList;
  // a live event's newest matches aren't in the saved file yet
  if (!matches.some((m) => m.d === d) && !ev.finished) {
    try {
      const raw = await fetchLiveEvent(season, code);
      if (stale(r)) return;
      matches = normalizeLive(season, raw, meta);
    } catch (e) { console.warn(e); }
  }
  const i = matches.findIndex((m) => m.d === d);
  if (i < 0) {
    app.innerHTML = `<div class="card empty">${esc(ev.name)} has no match “${esc(d)}”. <a class="link" href="#/${season}/event/${encodeURIComponent(code)}">All its matches →</a></div>`;
    return;
  }

  // replay the event up to this match: ratings going in, and after it's played
  const before = replayEvent(meta, ev, matches.slice(0, i));
  const after = replayEvent(meta, ev, matches.slice(0, i + 1));
  const m = { ...matches[i], pred: matches[i].pred ?? after.matches[i].pred };
  const isQual = m.level === "Quals";
  const rpNames = isQual ? meta.rpNames : [];
  const team = new Map(ev.teamList.map((t) => [t.team, t]));
  // qual standings just before and just after this match (playoffs use the official final ones)
  const finalRank = new Map(ev.teamList.filter((t) => t.rank != null).map((t) => [t.team, t.rank]));
  const allTeams = [...new Set([...team.keys(), ...matches.flatMap((x) => [...x.red, ...x.blue])])];
  const stBefore = isQual ? standings(season, allTeams, matches.slice(0, i), finalRank) : null;
  const stAfter = isQual ? standings(season, allTeams, matches.slice(0, i + 1), finalRank) : null;
  const p = m.pred, rs = m.redScore, bs = m.blueScore;
  const played = m.played && rs && bs;
  const winner = !played ? null : rs.total > bs.total ? "red" : bs.total > rs.total ? "blue" : "tie";
  const fav = p ? (p.pRed >= 0.5 ? "red" : "blue") : null;
  const favP = p ? Math.max(p.pRed, 1 - p.pRed) : null;
  const v = played && videoFor(videos, code, m.time);
  const prev = matches[i - 1], next = matches[i + 1];
  const Side = (s) => (s === "red" ? "Red" : "Blue");

  // scorebug: each alliance's robots beside its score, the winner's score lit and the loser's dimmed;
  // under it the win chance going in, and one line on how the prediction did
  const onField = (side) => m[`${side}On`] ?? m[side];
  const bugTeams = (s) => `<div class="bug-al ${s}">${m[s].map((t) => `<a class="bug-team ${onField(s).includes(t) ? "" : "sat-out"}" href="#/${season}/team/${t}"><b class="${s}-text">${t}</b><span>${esc(team.get(t)?.name ?? "")}${onField(s).includes(t) ? "" : " · didn't play"}</span></a>`).join("")}</div>`;
  const bugScore = (s) => {
    const v = played ? m[`${s}Score`].total : p ? fmt(p[s].total, 0) : "–";
    return `<span class="bug-n ${s}-text ${winner && winner !== "tie" && winner !== s ? "lost" : ""} ${!played ? "pred" : ""}">${v}</span>`;
  };
  const r0 = p ? Math.round(p.pRed * 100) : null;
  const verdict = !p ? (played ? "No prediction for this match" : "Not played yet")
    : !played ? `Predicted ${fmt(p.red.total, 0)}–${fmt(p.blue.total, 0)} · ${Side(fav)} favoured`
    : winner === "tie" ? `Tie · predicted ${fmt(p.red.total, 0)}–${fmt(p.blue.total, 0)}`
    : `<b class="${winner === fav ? "good-text" : "bad-text"}">${winner === fav ? "Called it" : "Upset"}</b> · predicted ${fmt(p.red.total, 0)}–${fmt(p.blue.total, 0)}`;
  const board = `<div class="bug">
    <div class="bug-row">
      ${bugTeams("red")}
      <div class="bug-score">${bugScore("red")}<span class="bug-dash">–</span>${bugScore("blue")}</div>
      ${bugTeams("blue")}
    </div>
    ${p ? `<div class="bug-chance"><span class="red-text">${r0}%</span><span class="mb-bar"><i style="width:${r0}%"></i></span><span class="blue-text">${100 - r0}%</span></div>` : ""}
    <div class="bug-verdict small muted">${p ? "Win chance before the match · " : ""}${verdict}</div>
  </div>`;

  // with a video the page is built around it: player on the left, a compact
  // scoreboard beside it; the verdict moves into that scoreboard
  const clock = (t) => { const h = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    return h ? `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`; };
  const links = v && videoLinks(v.id, v.t), openUrl = links?.open ?? "";
  const stage = v ? `<div class="match-stage section">
    <div class="stage-video" id="stage-video" data-id="${esc(v.id)}" data-t="${v.t}" data-title="${esc(`${ev.name} · ${m.d}`)}">
      ${v.ext
        // the owner turned off embedding: same spot, on YouTube
        ? `<a class="stage-play" href="${openUrl}" target="_blank" rel="noopener">
        <span class="stage-play-icon">${PLAY_ICON}</span>
        <span class="stage-play-text"><b>Watch ${esc(matchTitle(m.d))} on ${links.site} ↗</b>
          <small>${v.t ? `From ${clock(v.t)} · ` : ""}this video's owner doesn't allow playing it here</small></span>
      </a>`
        : `<button class="stage-play" data-play-inline aria-label="Play ${esc(matchTitle(m.d))}">
        <span class="stage-play-icon">${PLAY_ICON}</span>
        <span class="stage-play-text"><b>Watch ${esc(matchTitle(m.d))}</b>
          <small>${v.t ? `Event video, from ${clock(v.t)}` : "Match video"}${links.site === "YouTube" ? "" : ` · ${links.site}`}</small></span>
      </button>`}
    </div>
    <div class="stage-side">${board}</div>
  </div>` : `<div class="section">${board}</div>`;

  // line score: one row per alliance, a column per period, then each bonus RP.
  // The prediction sits small under every number; the winner's final is bold.
  const periods = [["auto", "Auto"], ["teleop", "Teleop"], ["endgame", "Endgame"], ["pen", "Penalties"], ["total", "Final"]];
  const val = (o, k) => (o == null ? null : k === "pen" ? o.total - o.np : o[k]);
  const lsCell = (s, k) => {
    const ac = played ? val(m[`${s}Score`], k) : null, pr = val(p?.[s], k);
    const main = ac ?? (pr != null ? fmt(pr, 0) : "–");
    return `<td class="c ${k === "total" ? "ls-final" : ""}"><b class="${k === "total" && winner === s ? `${s}-text` : ""} ${!played ? "faint" : ""}">${main}</b>${ac != null && pr != null ? `<small>${fmt(pr, 0)}</small>` : ""}</td>`;
  };
  const rpCell = (s, k) => {
    const ch = p?.[s]?.rp?.[k], got = played ? m[`${s}Score`].rp?.[k] : null;
    return `<td class="c ls-rp">${got == null ? '<b class="faint">–</b>' : got ? `<b class="${s}-text">✓</b>` : '<b class="faint">✗</b>'}${ch != null ? `<small>${pct(ch)}</small>` : ""}</td>`;
  };
  const lineScore = `<div class="table-wrap"><table class="line-score">
    <thead><tr><th></th>${periods.map(([, l]) => `<th class="c">${l}</th>`).join("")}${rpNames.map((nm) => `<th class="c ls-rp">${esc(nm)}</th>`).join("")}</tr></thead>
    <tbody>${["red", "blue"].map((s) => `<tr class="side-${s}"><td class="ls-who">${m[s].map((t) => `<a class="ls-team ${onField(s).includes(t) ? "" : "sat-out"}" href="#/${season}/team/${t}" data-avatar="${t}"><b class="${s}-text">${t}</b></a>`).join("")}</td>${periods.map(([k]) => lsCell(s, k)).join("")}${rpNames.map((_, k) => rpCell(s, k)).join("")}</tr>`).join("")}</tbody>
  </table></div>
  <p class="ls-note small faint">${p ? `Small numbers: our prediction${rpNames.length ? " (for bonus RPs, the chance)" : ""}.` : ""}</p>`;

  // event rank after this match, and how many places this result moved it (▲ = up the table)
  const recordOf = (x) => (x?.wins != null && (x.played ?? 1) ? `${x.wins}-${x.losses}${x.ties ? `-${x.ties}` : ""}` : "–");
  const rankCell = (t) => {
    if (!isQual) return finalRank.get(t) ?? "–";
    const b = stBefore.get(t)?.rank, a = stAfter.get(t)?.rank;
    if (a == null) return '<span class="faint">–</span>';
    const moved = played && b != null && !(m.surr ?? []).includes(t);
    return moved ? `${a} ${trend(b - a, 0)}` : `${a}`;
  };

  // each robot: rating going in, what it was expected to add, and how this match moved it
  const teamRows = ["red", "blue"].flatMap((s) => m[s].map((t) => {
    const b = before.model.epa(t), a = after.model.epa(t), row = team.get(t);
    const played1 = onField(s).includes(t);
    const delta = played && played1 ? a.np - b.np : null;
    return `<tr class="side-${s}">
      <td>${teamCell(season, t, row?.name ?? "")}${played1 ? "" : ' <span class="pill">didn\'t play</span>'}</td>
      <td class="c">${epa(b.np, meta)}</td>
      <td class="r">${delta != null ? `${fmt(a.np)} ${trend(delta)}` : '<span class="faint">–</span>'}</td>
      <td class="r small hide-sm">${fmt(b.auto)}</td><td class="r small hide-sm">${fmt(b.teleop)}</td><td class="r small hide-sm">${fmt(b.endgame)}</td>
      <td class="r">${rankCell(t)}</td>
      <td class="r small hide-sm">${recordOf(isQual ? stAfter.get(t) : row)}</td>
    </tr>`;
  })).join("");

  const when = m.time ? new Date(m.time).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ev.timezone || undefined }) : fmtRange(ev.start, ev.end);
  const evLink = `#/${season}/event/${encodeURIComponent(code)}${isQual ? "" : "/playoffs"}`;
  app.innerHTML = `
    <div class="card card-pad"><div class="page-head">
      <div>
        <div class="kicker"><a class="link" href="${evLink}">${esc(ev.name)}</a> · ${esc(when)}</div>
        <h1>${esc(matchTitle(m.d))}</h1>
        <div class="row" style="margin-top:8px">
          <a class="pill desk-only" href="https://ftcscout.org/events/${season}/${encodeURIComponent(code)}/matches" target="_blank" rel="noopener">FTCScout ↗</a>
          ${links && links.site !== "YouTube" ? `<a class="pill" href="${openUrl}" target="_blank" rel="noopener">${links.site} ↗</a>` : ""}
          ${shareButton(`m/${season}/${encodeURIComponent(code)}/${encodeURIComponent(m.d)}`, `${ev.name} · ${m.d}`)}
        </div>
      </div>
      <div class="match-actions">
        ${v ? (v.ext ? `<a class="btn btn-solid watch-cta" href="${openUrl}" target="_blank" rel="noopener">${PLAY_ICON} Watch on ${links.site} ↗</a>`
          : `<button class="btn btn-solid watch-cta" data-play-inline>${PLAY_ICON} Watch match</button>`) : ""}
        <nav class="match-steps">
          ${prev ? `<a class="btn btn-outline" href="${matchHref(season, code, prev.d)}">← ${esc(prev.d)}</a>` : ""}
          <a class="btn btn-outline" href="${evLink}">All matches</a>
          ${next ? `<a class="btn btn-outline" href="${matchHref(season, code, next.d)}">${esc(next.d)} →</a>` : ""}
        </nav>
      </div>
    </div></div>

    ${stage}

    <div class="card card-pad section ls-card"><h2>Line score</h2>${lineScore}</div>

    <div class="card section"><div class="card-pad" style="padding-bottom:6px"><h2 style="margin:0">Teams</h2><p class="small muted desk-only" style="margin:4px 0 0">Each robot's EPA going into this match, and where this result moved it${isQual ? ". Event rank and record are as of the end of this match" : ""}.</p></div><div class="table-wrap"><table class="match-teams">
      <thead><tr><th>Team</th><th class="c">EPA before</th><th class="r">After</th><th class="r hide-sm">Auto</th><th class="r hide-sm">Teleop</th><th class="r hide-sm">Endgame</th><th class="r"><span class="hide-sm">${isQual ? "Event" : "Qual"} </span>rank</th><th class="r hide-sm">Record</th></tr></thead>
      <tbody>${teamRows}</tbody></table></div></div>`;
  // team photos (when a team has one) as small avatars in the line score
  data.photos(CONFIG.photoApi).catch(() => ({})).then((p) => {
    if (stale(r)) return;
    $$("[data-avatar]").forEach((a) => {
      const ph = p[a.dataset.avatar]?.[0];
      if (ph) a.insertAdjacentHTML("afterbegin", `<img class="avatar" src="${esc(ph.file)}" alt="" loading="lazy">`);
    });
  });
}

// ---------------- compete: build any matchup ----------------

// Any teams on either side (1-4 robots each), predicted with the season's model.
// Real FTC matches are 2 v 2; other sizes just add up each robot's ratings.
// inverse error function (Giles' approximation), for turning a win chance back into a z-score
function inverf(x) {
  const w = -Math.log((1 - x) * (1 + x));
  let p;
  if (w < 5) { const v = w - 2.5; p = 2.81022636e-08; for (const c of [3.43273939e-07, -3.5233877e-06, -4.39150654e-06, 0.00021858087, -0.00125372503, -0.00417768164, 0.246640727, 1.50140941]) p = c + p * v; }
  else { const v = Math.sqrt(w) - 3; p = -0.000200214257; for (const c of [0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773, -0.0076224613, 0.00943887047, 1.00167406, 2.83297682]) p = c + p * v; }
  return p * x;
}

async function compete(r) {
  const { season, query } = r;
  const [meta, played, preTable] = await Promise.all([data.meta(season), data.teams(season), getJSON(`data/${season}/teams-pre.json`).catch(() => null)]);
  if (stale(r)) return;
  // plus last season's teams that haven't played yet, on the rating the model starts them on
  const pre = (preTable?.rows ?? []).map((row) => {
    const o = { matches: 0, wins: 0, losses: 0, ties: 0, pre: true };
    preTable.cols.forEach((c, j) => (o[c] = row[j]));
    return o;
  });
  const teams = [...played, ...pre];
  const byNum = new Map(teams.map((t) => [t.team, t]));
  const list = (k) => (query.get(k) ?? "").split(",").map((s) => s.trim());
  const size = (k, d = 2) => Math.min(4, Math.max(1, +query.get(`${k}n`) || Math.max(d, list(k).filter(Boolean).length)));
  // shown: a prediction is on screen. Editing teams dims it until Predict is pressed again;
  // a shared link with teams on both sides predicts straight away
  const st = { r: list("r"), b: list("b"), rn: size("r"), bn: size("b"), shown: false };
  const rpNames = meta.rpNames ?? [];

  const shell = () => {
    const input = (side, i) => `<div class="slot"><input autocomplete="off" placeholder="Team # or name" data-side="${side}" data-i="${i}" value="${esc(st[side][i] ?? "")}" aria-label="${side === "r" ? "Red" : "Blue"} robot ${i + 1}">
      ${st[`${side}n`] > 1 ? `<button type="button" class="slot-x" data-drop="${side}${i}" aria-label="Remove this robot">×</button>` : ""}<div class="pick" role="listbox"></div><div class="who" id="who-${side}${i}"></div></div>`;
    const sideBox = (side) => `<div class="side card ${side === "r" ? "red" : "blue"}">
      <div class="side-head"><b class="${side === "r" ? "red" : "blue"}-text">${side === "r" ? "Red" : "Blue"} alliance</b><span class="faint small">${st[`${side}n`]} robot${st[`${side}n`] > 1 ? "s" : ""}</span></div>
      ${Array.from({ length: st[`${side}n`] }, (_, i) => input(side, i)).join("")}
      ${st[`${side}n`] < 4 ? `<button type="button" class="pill add-slot" data-add="${side}">+ Add robot</button>` : ""}</div>`;
    app.innerHTML = `
      <div class="card card-pad"><div class="page-head"><div>
        <div class="kicker">${seasonLabel(season, meta.game)}</div>
        <h1>Compete</h1>
        <p class="muted desk-only" style="margin:4px 0 0">Put any teams against each other and see the predicted score, who wins and how often. Uses each team's current EPA.</p>
      </div>${competeModes(season, "compete")}</div></div>
      <div class="compete-bar section">
        <div class="row"><button type="button" class="pill" id="swap">⇄ Swap sides</button><button type="button" class="pill" id="random">Random</button><button type="button" class="pill" id="clear">Clear</button></div>
      </div>
      <div class="predictor section">${sideBox("r")}<div class="vs"><span>VS</span><button type="button" class="btn btn-solid" id="go">Predict</button></div>${sideBox("b")}</div>
      <div id="out"></div>`;
    $$(".predictor input").forEach((el) => teamPicker(el));
    $$("[data-add]").forEach((b) => (b.onclick = () => { st[`${b.dataset.add}n`]++; shell(); $(`.predictor input[data-side="${b.dataset.add}"][data-i="${st[`${b.dataset.add}n`] - 1}"]`)?.focus(); }));
    $$("[data-drop]").forEach((b) => (b.onclick = () => { const s = b.dataset.drop[0], i = +b.dataset.drop.slice(1); st[s].splice(i, 1); st[`${s}n`]--; const prev = st.shown && $("#out").innerHTML; st.shown = false; shell(); keepDimmed(prev); }));
    $("#swap").onclick = () => { [st.r, st.b, st.rn, st.bn] = [st.b, st.r, st.bn, st.rn]; shell(); };
    $("#clear").onclick = () => { st.r = []; st.b = []; st.shown = false; shell(); $(".predictor input")?.focus(); };
    $("#go").onclick = () => { st.shown = true; st.animate = true; run(); };
    // four random teams with 5+ matches this season, 2 v 2
    $("#random").onclick = () => {
      const pool = played.filter((x) => x.matches >= 5), t = [];
      while (t.length < 4 && t.length < pool.length) { const n = `${pool[Math.floor(Math.random() * pool.length)].team}`; if (!t.includes(n)) t.push(n); }
      [st.r, st.b, st.rn, st.bn, st.shown, st.animate] = [t.slice(0, 2), t.slice(2), 2, 2, true, true];
      shell();
    };
    run();
  };

  // Team picker for one slot: type a number or a name, pick from the season's teams
  // (strongest first), arrow keys + Enter work. Typing a full number works without picking.
  const byEpa = [...teams].sort((a, b) => b.np - a.np);
  const teamPicker = (el) => {
    const box = el.parentElement.querySelector(".pick");
    let items = [], sel = 0;
    const set = (v) => { if ((st[el.dataset.side][+el.dataset.i] ?? "") !== v) { st[el.dataset.side][+el.dataset.i] = v; edited(); } };
    const draw = () => {
      const q = el.value.trim().toLowerCase();
      const taken = new Set([...st.r, ...st.b].filter((v, k) => v && v !== el.value.trim()).map(Number));
      const match = (t) => !q || String(t.team).startsWith(q) || t.name.toLowerCase().includes(q);
      items = byEpa.filter((t) => !taken.has(t.team) && match(t)).slice(0, 8);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      box.innerHTML = items.length
        ? items.map((t, k) => `<button type="button" class="pick-item ${k === sel ? "sel" : ""}" data-k="${k}"><b>${t.team}</b><span>${esc(t.name)}</span><small class="faint">${t.remote ? "no rating yet" : t.pre ? "not played yet" : `${t.matches} match${t.matches === 1 ? "" : "es"}`}</small>${epa(t.np, meta)}</button>`).join("")
        : `<div class="pick-empty">No ${seasonLabel(season, "")} team matches “${esc(el.value.trim())}”</div>`;
      box.classList.add("open");
    };
    const close = () => box.classList.remove("open");
    const choose = (k) => {
      const t = items[k];
      if (!t) return;
      el.value = `${t.team}`;
      set(el.value);
      close();
      // jump to the next empty slot, so building a match is just pick, pick, pick
      const next = $$(".predictor input").find((x) => !x.value.trim());
      if (next) next.focus(); else $("#go").focus();
    };
    el.onfocus = () => { sel = 0; draw(); };
    // a half-typed name isn't a team yet: only numbers count until one is picked
    el.oninput = () => { sel = 0; draw(); set(/^\d+$/.test(el.value.trim()) ? el.value.trim() : ""); };
    el.onblur = () => setTimeout(close, 120);
    el.onkeydown = (e) => {
      if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") { choose(sel); e.preventDefault(); }
      else if (e.key === "Escape") { close(); el.blur(); }
    };
    box.onmousedown = (e) => { const b = e.target.closest("[data-k]"); if (b) { e.preventDefault(); choose(+b.dataset.k); } };
  };

  const run = () => {
    const nums = { r: [], b: [] }, seen = new Set();
    for (const side of ["r", "b"]) for (let i = 0; i < st[`${side}n`]; i++) {
      const v = st[side][i] ?? "", t = /^\d{1,6}$/.test(v) ? byNum.get(+v) : null;
      let msg = "";
      if (!v) msg = "";
      else if (!/^\d{1,6}$/.test(v)) msg = `<span class="faint">Not a team number</span>`;
      else if (!t) msg = `<span class="faint">No team ${esc(v)} this season or last</span>`;
      else if (seen.has(+v)) msg = `<span class="faint">Already picked</span>`;
      else { msg = `<a href="#/${season}/team/${t.team}">${esc(t.name)}</a> · EPA ${fmt(t.np)} · ${t.matches} match${t.matches === 1 ? "" : "es"}`; nums[side].push(+v); seen.add(+v); }
      const who = $(`#who-${side}${i}`);
      if (who) who.innerHTML = msg;
    }
    const keep = (side) => st[side].slice(0, st[`${side}n`]).filter(Boolean).join(",");
    syncQuery({ r: keep("r"), b: keep("b"), rn: st.rn !== 2 || st.bn !== 2 ? st.rn : "", bn: st.rn !== 2 || st.bn !== 2 ? st.bn : "" });
    const ready = nums.r.length > 0 && nums.b.length > 0;
    $("#go").disabled = !ready;
    $("#go").title = ready ? "" : "Add at least one team on each side";
    if (!ready) st.shown = false;
    if (!st.shown) { $("#out").innerHTML = ""; return; }

    const model = modelFromMeta(meta);
    for (const n of [...nums.r, ...nums.b]) {
      const t = byNum.get(n);
      model.setTeam(n, { auto: t.pauto ?? t.auto, teleop: t.pteleop ?? t.teleop, endgame: t.pendgame ?? t.endgame, n: t.matches, rp: [t.rp0, t.rp1, t.rp2] });
    }
    const p = model.predict(nums.r, nums.b);
    const fav = p.pRed >= 0.5 ? "red" : "blue", favP = Math.max(p.pRed, 1 - p.pRed);
    const Side = (s) => (s === "red" ? "Red" : "Blue");
    const margin = Math.abs(p.red.total - p.blue.total);
    // best of 3 (playoff series), ties ignored
    const bo3 = (q) => q * q * (3 - 2 * q);
    const sure = (q) => (q > 0.995 ? "over 99%" : pct(q));
    const uneven = nums.r.length !== 2 || nums.b.length !== 2;

    const side = (s) => `<div class="feature-side ${s}">${nums[s[0]].map((n) => `<a href="#/${season}/team/${n}">${n}</a><small>${esc(byNum.get(n).name)}</small>`).join("")}</div>`;
    const board = `<div class="feature match-board">
      <div class="feature-head"><b>Predicted score</b><span class="phase">${nums.r.length} v ${nums.b.length}</span></div>
      <div class="feature-body">
        ${side("red")}
        <div class="feature-score"><span class="score red">${fmt(p.red.total, 0)}</span><span class="faint">–</span><span class="score blue">${fmt(p.blue.total, 0)}</span></div>
        ${side("blue")}
      </div>
      <div class="feature-foot">${winBar(p.pRed)}<p>${Side(fav)} wins ${sure(favP)} of the time, by about ${fmt(margin, 0)} points. In a best of 3, ${Side(fav).toLowerCase()} takes the series ${sure(bo3(favP))} of the time.</p></div>
    </div>`;

    const rows = [["auto", "Auto"], ["teleop", "Teleop"], ["endgame", "Endgame"], ["np", "No-penalty total"], ["pen", "Penalty points"], ["total", "Final"]];
    const val = (o, k) => (k === "pen" ? o.total - o.np : o[k]);
    const maxOf = Math.max(1, ...["auto", "teleop", "endgame"].flatMap((k) => [p.red[k], p.blue[k]]));
    const cell = (o, k, s) => `<td class="r"><b>${fmt(val(o, k), 0)}</b></td>
      <td class="bk-cell hide-sm">${["auto", "teleop", "endgame"].includes(k) ? `<span class="bk-bar"><i class="${s}" style="width:${Math.max(0, Math.round((o[k] / maxOf) * 100))}%"></i></span>` : ""}</td>`;
    const breakdown = `<div class="table-wrap"><table class="breakdown">
      <thead><tr><th></th><th class="r red-text">Red</th><th class="hide-sm"></th><th class="r blue-text">Blue</th><th class="hide-sm"></th></tr></thead>
      <tbody>${rows.map(([k, label]) => `<tr class="${k === "total" ? "tot" : ""}"><td class="muted">${label}</td>${cell(p.red, k, "red")}${cell(p.blue, k, "blue")}</tr>`).join("")}</tbody>
    </table></div>
    <p class="small muted" style="margin:10px 4px 0">Penalty points are the fouls the other alliance is expected to give away (the league average).</p>`;

    const rpCard = rpNames.length ? `<div class="card card-pad"><h3>Bonus ranking points</h3><div class="table-wrap"><table class="breakdown">
      <thead><tr><th></th><th class="r red-text">Red</th><th class="r blue-text">Blue</th></tr></thead>
      <tbody>${rpNames.map((nm, k) => `<tr><td class="muted">${esc(nm)}</td><td class="r">${pct(p.red.rp[k])}</td><td class="r">${pct(p.blue.rp[k])}</td></tr>`).join("")}
        <tr class="tot"><td class="muted">Win</td><td class="r">${pct(p.pRed)}</td><td class="r">${pct(1 - p.pRed)}</td></tr></tbody>
    </table></div></div>` : "";

    // who carries each alliance: every robot's EPA and its share of the alliance's points
    const robotRows = ["red", "blue"].flatMap((s) => {
      const ns = nums[s[0]], tot = ns.reduce((a, n) => a + byNum.get(n).np, 0) || 1;
      return ns.map((n) => {
        const t = byNum.get(n);
        return `<tr class="side-${s}"><td>${teamCell(season, n, t.name)}</td><td class="c">${epa(t.np, meta)}</td>
          <td class="r small hide-sm">${fmt(t.auto)}</td><td class="r small hide-sm">${fmt(t.teleop)}</td><td class="r small hide-sm">${fmt(t.endgame)}</td>
          <td class="r">${pct(t.np / tot)}</td><td class="r small hide-sm">${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}</td></tr>`;
      });
    }).join("");

    $("#out").classList.remove("stale", "playing");
    st.anim = (st.anim ?? 0) + 1; // stop any match still playing
    $("#out").innerHTML = `
      <div class="section">${board}</div><div class="out-rest">
      ${uneven ? `<p class="small muted section compete-note">Real FTC matches are 2 v 2. With other sizes each side's score is the sum of its robots' ratings, so read it as a what-if (field space and shared goals aren't modelled).</p>` : ""}
      <div class="grid ${rpCard ? "cols-2" : ""} section desk-only">
        <div class="card card-pad"><h3>Score breakdown</h3>${breakdown}</div>
        ${rpCard}
      </div>
      <div class="section-title"><h2>Robots</h2><p class="muted desk-only" style="margin:6px 0 0">Each robot's EPA and how much of its alliance's points it brings.</p></div>
      <div class="card"><div class="table-wrap"><table class="match-teams">
        <thead><tr><th>Team</th><th class="c">EPA</th><th class="r hide-sm">Auto</th><th class="r hide-sm">Teleop</th><th class="r hide-sm">Endgame</th><th class="r">Share</th><th class="r hide-sm">Record</th></tr></thead>
        <tbody>${robotRows}</tbody></table></div></div></div>`;
    if (st.animate) { st.animate = false; playMatch(p, `${nums.r.length} v ${nums.b.length}`); }
  };

  // Play the predicted match out over ~3 s on a 2:30 match clock: auto points in the
  // first 30 s, teleop across the rest, endgame in the last 15 s. Each alliance runs a
  // little ahead of or behind its pace (a random wobble that fades out by the buzzer),
  // so the lead swings and the win bar swings with a live win chance before settling
  // on the prediction. Click the board to skip.
  const playMatch = (p, label) => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const out = $("#out"), board = $(".match-board", out);
    const red = $(".feature-score .score.red", out), blue = $(".feature-score .score.blue", out), phase = $(".phase", out);
    const bar = $(".feature-foot .wp-red", out), pctEl = $(".feature-foot .wp-label", out);
    out.classList.add("playing");
    const token = (st.anim = (st.anim ?? 0) + 1), T = 2700, END = 3000, t0 = performance.now();
    const clip = (sec, a, b) => Math.min(1, Math.max(0, (sec - a) / (b - a)));
    // a side's pace: share of a period's points done at u (0-1), pushed ahead or behind by
    // two slow random waves; the u(1-u) factor pins it to 0 at the start and 1 at the end
    const pace = () => {
      const w = [0, 1].map(() => ({ f: 1 + Math.random() * 2, ph: Math.random() * 6.3, a: 0.5 + Math.random() * 0.5 }));
      return (u) => Math.min(1, Math.max(0, u + 1.1 * u * (1 - u) * w.reduce((sum, x) => sum + x.a * Math.sin(6.283 * x.f * u + x.ph), 0) / 2));
    };
    const curves = (o) => ({ auto: pace(), teleop: pace(), o, best: 0 });
    const R = curves(p.red), B = curves(p.blue);
    // never let a score go down, whatever the wobble does
    const at = (c, sec) => (c.best = Math.max(c.best, c.o.auto * c.auto(clip(sec, 0, 30)) + c.o.teleop * c.teleop(clip(sec, 30, 150)) + c.o.endgame * clip(sec, 135, 150)));
    // live win chance: lead so far plus the expected rest of the margin, with the
    // spread shrinking as less of the match is left (its full size implied by pRed)
    const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
    const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
    const E = p.red.total - p.blue.total, avg = (p.red.total + p.blue.total) / 2 || 1;
    const zPred = Math.abs(p.pRed - 0.5) > 0.01 ? Math.SQRT2 * inverf(2 * p.pRed - 1) : 0;
    const sigma = Math.max(avg * 0.2, zPred && Math.sign(zPred) === Math.sign(E) ? E / zPred : avg * 0.3);
    const setBar = (q) => {
      const r100 = Math.round(q * 100);
      if (bar) bar.style.width = `${r100}%`;
      if (pctEl) { pctEl.textContent = `${Math.max(r100, 100 - r100)}%`; pctEl.className = `wp-label ${r100 >= 50 ? "red" : "blue"}`; }
    };
    const finish = () => {
      out.classList.remove("playing"); phase.textContent = label;
      red.textContent = fmt(p.red.total, 0); blue.textContent = fmt(p.blue.total, 0); setBar(p.pRed);
    };
    board.onclick = () => { st.anim++; finish(); };
    // a timer rather than requestAnimationFrame, so a background tab still finishes
    const timer = setInterval(() => frame(performance.now()), 30);
    const frame = (now) => {
      if (token !== st.anim || !red.isConnected) return clearInterval(timer);
      const el = now - t0, sec = Math.min(150, (el / T) * 150), done = el >= T;
      const left = Math.ceil(150 - sec);
      phase.textContent = done ? "Penalties" : `${sec < 30 ? "Auto" : sec < 120 ? "Teleop" : "Endgame"} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      const rs = at(R, sec), bs = at(B, sec);
      red.textContent = fmt(done ? p.red.total : rs, 0);
      blue.textContent = fmt(done ? p.blue.total : bs, 0);
      const rem = Math.max(0, 1 - (sec / 150));
      // swing freely early on, then ease onto the prediction over the last ~40 s
      const live = Phi((rs - bs + E * rem) / (sigma * Math.sqrt(rem) + 1e-6));
      setBar(done ? p.pRed : p.pRed + (live - p.pRed) * Math.min(1, rem / 0.27));
      if (el >= END) { clearInterval(timer); finish(); }
    };
    frame(t0);
  };
  // a team changed: keep the old prediction on screen, dimmed, until Predict is pressed
  const keepDimmed = (prev) => {
    st.anim = (st.anim ?? 0) + 1;
    $("#out").classList.remove("playing");
    if (prev && !$("#go").disabled) { $("#out").innerHTML = prev; $("#out").classList.add("stale"); }
  };
  const edited = () => {
    const prev = $("#out").innerHTML;
    st.shown = false;
    run();
    keepDimmed(prev);
  };
  st.shown = st.r.some(Boolean) && st.b.some(Boolean);
  shell();
}

// Predict a match | Head to head: the two Compete modes
// ---------------- SIM event ----------------

// Any list of teams as a pretend event: random qualification schedules, played out
// from each team's current rating (scrimmages, off-season planning, "what if").
async function sim(r) {
  const { season, query } = r;
  const [meta, played, preTable, events] = await Promise.all([data.meta(season), data.teams(season), getJSON(`data/${season}/teams-pre.json`).catch(() => null), data.events(season)]);
  if (stale(r)) return;
  const pre = (preTable?.rows ?? []).map((row) => { const o = { matches: 0, pre: true }; preTable.cols.forEach((c, j) => (o[c] = row[j])); return o; });
  const byNum = new Map([...pre, ...played].map((t) => [t.team, t]));
  const byEpa = [...byNum.values()].sort((a, b) => b.np - a.np);
  const st = {
    teams: [...new Set((query.get("teams") ?? "").split(",").map(Number).filter((n) => n > 0))].slice(0, 80),
    per: Math.min(10, Math.max(3, +query.get("per") || 5)),
    from: query.get("from") ?? "",
  };
  const evOpts = [...events].filter((e) => e.teams >= 4).sort((a, b) => b.start.localeCompare(a.start));
  app.innerHTML = `
    <div class="card card-pad"><div class="page-head"><div>
      <div class="kicker">${seasonLabel(season, meta.game)}</div>
      <h1>SIM event</h1>
      <p class="muted desk-only" style="margin:4px 0 0">Pick any teams and see how a qualification tournament between them would likely rank: thousands of random schedules, each played out from every team's current EPA.</p>
    </div>${competeModes(season, "sim")}</div></div>
    <div class="compete-bar section">
      <div class="row">
        <div class="slot sim-ev"><input id="sim-ev" autocomplete="off" placeholder="Load an event's teams…" aria-label="Load an event's teams"><div class="pick" role="listbox"></div></div>
        <button type="button" class="pill" id="sim-random">Random 16</button>
        <button type="button" class="pill" id="sim-clear">Clear</button>
      </div>
      <div class="row sim-per"><span class="small muted">Matches per team</span>
        <nav class="chart-pick" id="sim-per">${[4, 5, 6, 7, 8, 9, 10].map((n) => `<a href="#" data-n="${n}" class="${n === st.per ? "active" : ""}">${n}</a>`).join("")}</nav></div>
    </div>
    <div class="sim-board section">
      <div class="side sim-teams">
        <div class="side-head"><b>Teams</b><span class="faint small" id="sim-count"></span></div>
        <div class="sim-chips" id="sim-chips"></div>
        <div class="slot"><input id="sim-add" autocomplete="off" placeholder="Add a team: number or name" aria-label="Add a team"><div class="pick" role="listbox"></div></div>
      </div>
    </div>
    <div class="card section" id="sim-out"></div>`;

  const sync = () => syncQuery({ teams: st.teams.join(","), per: st.per === 5 ? "" : st.per, from: st.from });
  let timer;
  const run = () => {
    sync();
    const nums = st.teams;
    if (nums.length < 4) { $("#sim-out").innerHTML = `<div class="empty">Add at least 4 teams, or load an event's teams.</div>`; return; }
    $("#sim-out").innerHTML = `<div class="loading">Simulating…</div>`;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const teamList = nums.map((n) => {
        const t = byNum.get(n);
        return { team: n, name: t?.name ?? "", state: t ? { auto: t.pauto ?? t.auto, teleop: t.pteleop ?? t.teleop, endgame: t.pendgame ?? t.endgame, n: t.matches, rp: [t.rp0 ?? 0, t.rp1 ?? 0, t.rp2 ?? 0] } : null };
      });
      const rows = forecastFromRoster(season, meta, { teamList, type: null }, { perTeam: st.per });
      $("#sim-out").innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Proj.</th><th>Team</th><th class="c"><span title="${EPA_TIP}">EPA</span></th><th class="r">Avg rank</th><th class="r">#1</th><th class="r">Top 4</th><th class="r hide-sm">Top 8</th></tr></thead>
        <tbody>${rows.map((x, i) => `<tr>
          <td class="faint num">${i + 1}</td>
          <td>${byNum.has(x.team) ? teamCell(season, x.team, byNum.get(x.team).name) : `<span class="team-cell"><span class="n">${x.team}</span><span class="nm">${esc(remoteTeams.get(x.team) ?? "")} <span class="faint small">no rating yet</span></span></span>`}</td>
          <td class="c">${byNum.has(x.team) ? epa(byNum.get(x.team).np, meta) : "–"}</td>
          <td class="r">${fmt(x.meanRank, 1)}</td><td class="r">${probCell(x.p1)}</td><td class="r">${probCell(x.p4)}</td><td class="r hide-sm">${probCell(x.p8)}</td>
        </tr>`).join("")}</tbody></table></div>`;
    }, 30);
  };
  const drawTeams = () => {
    $("#sim-count").textContent = `${st.teams.length} team${st.teams.length === 1 ? "" : "s"}`;
    $("#sim-chips").innerHTML = st.teams.map((n) => {
      const t = byNum.get(n);
      return `<span class="sim-chip"><a href="#/${season}/team/${n}"><b>${n}</b> <span>${esc(t?.name ?? remoteTeams.get(n) ?? "new team")}</span></a>${t ? epa(t.np, meta) : ""}<button type="button" data-drop="${n}" aria-label="Remove ${n}">×</button></span>`;
    }).join("");
    const taken = new Set(st.teams);
    teamTypeahead($("#sim-add"), byEpa.filter((t) => !taken.has(t.team)), meta, add, { remote: true });
  };
  const changed = () => { drawTeams(); run(); };
  function add(n) {
    if (!st.teams.includes(n) && st.teams.length < 80) st.teams.push(n);
    $("#sim-add").value = "";
    changed();
    $("#sim-add").focus();
  }
  $("#sim-chips").onclick = (e) => {
    const b = e.target.closest("[data-drop]");
    if (!b) return;
    e.preventDefault();
    st.teams = st.teams.filter((n) => n !== +b.dataset.drop);
    st.from = "";
    changed();
  };
  $("#sim-per").onclick = (e) => {
    const a = e.target.closest("[data-n]");
    if (!a) return;
    e.preventDefault();
    st.per = +a.dataset.n;
    $$("#sim-per a").forEach((x) => x.classList.toggle("active", x === a));
    run();
  };
  $("#sim-clear").onclick = () => { st.teams = []; st.from = ""; $("#sim-ev").value = ""; changed(); };
  $("#sim-random").onclick = () => {
    const pool = played.filter((x) => x.matches >= 5), pickd = new Set();
    while (pickd.size < Math.min(16, pool.length)) pickd.add(pool[Math.floor(Math.random() * pool.length)].team);
    st.teams = [...pickd]; st.from = ""; $("#sim-ev").value = "";
    changed();
  };

  // event search: same picker as the team boxes; picking one loads its team list
  const evInput = $("#sim-ev"), evBox = evInput.parentElement.querySelector(".pick");
  let evItems = [], evSel = 0;
  const drawEv = () => {
    const q = evInput.value.trim().toLowerCase();
    evItems = evOpts.filter((e) => !q || e.name.toLowerCase().includes(q) || e.code.toLowerCase().startsWith(q) || (e.loc ?? "").toLowerCase().includes(q)).slice(0, 8);
    evSel = Math.min(evSel, Math.max(0, evItems.length - 1));
    evBox.innerHTML = evItems.length
      ? evItems.map((e, k) => `<button type="button" class="pick-item ev-pick ${k === evSel ? "sel" : ""}" data-k="${k}"><b>${esc(e.name)}</b><span>${fmtRange(e.start, e.end)} · ${esc(e.loc ?? "")}</span><small class="faint">${e.teams} teams</small></button>`).join("")
      : `<div class="pick-empty">No event matches “${esc(evInput.value.trim())}”</div>`;
    evBox.classList.add("open");
  };
  const chooseEv = async (k) => {
    const e = evItems[k];
    if (!e) return;
    evBox.classList.remove("open");
    evInput.value = e.name;
    const ev = await data.event(season, e.code).catch(() => null);
    if (!ev || stale(r)) return;
    st.teams = ev.teamList.map((t) => t.team);
    st.from = e.code;
    changed();
  };
  evInput.onfocus = () => { evSel = 0; evInput.select(); drawEv(); };
  evInput.oninput = () => { evSel = 0; drawEv(); };
  evInput.onblur = () => setTimeout(() => evBox.classList.remove("open"), 120);
  evInput.onkeydown = (e) => {
    if (e.key === "ArrowDown") { evSel = Math.min(evItems.length - 1, evSel + 1); drawEv(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { evSel = Math.max(0, evSel - 1); drawEv(); e.preventDefault(); }
    else if (e.key === "Enter") { chooseEv(evSel); e.preventDefault(); }
    else if (e.key === "Escape") { evBox.classList.remove("open"); evInput.blur(); }
  };
  evBox.onmousedown = (e) => { const b = e.target.closest("[data-k]"); if (b) { e.preventDefault(); chooseEv(+b.dataset.k); } };
  if (st.from) evInput.value = events.find((e) => e.code === st.from)?.name ?? "";

  changed();
}

const competeModes = (season, cur) => `<nav class="chart-pick mode-pick" aria-label="Compete mode">
  ${[["compete", "Predict a match"], ["h2h", "Head to head"], ["sim", "SIM event"]].map(([k, l]) => `<a href="#/${season}/${k}" class="${k === cur ? "active" : ""}">${l}</a>`).join("")}</nav>`;

// Type-ahead for one team input (number or name), strongest first; same look as Compete's.
// remote: also search every FTC team on FTCScout (teams with no rating this season),
// filling in when the season's own list has fewer than 8 matches
const remoteTeams = new Map(); // number -> name, for teams found that way
function teamTypeahead(el, list, meta, onPick, { remote = false } = {}) {
  const box = el.parentElement.querySelector(".pick");
  let items = [], sel = 0, extra = [], remoteTimer, asked = "";
  const lookup = (q) => {
    clearTimeout(remoteTimer);
    if (!remote || q.length < 2 || q === asked) return;
    remoteTimer = setTimeout(async () => {
      asked = q;
      try {
        const res = await fetch("https://api.ftcscout.org/graphql", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `query($q:String!){teamsSearch(searchText:$q,limit:8){number name}}`, variables: { q } }) });
        const found = (await res.json())?.data?.teamsSearch ?? [];
        for (const f of found) remoteTeams.set(f.number, f.name);
        const known = new Set(list.map((t) => t.team));
        extra = found.filter((f) => !known.has(f.number)).map((f) => ({ team: f.number, name: f.name, matches: 0, np: null, remote: true }));
        if (el.value.trim().toLowerCase() === q && document.activeElement === el) draw(true);
      } catch {}
    }, 250);
  };
  const draw = (fromRemote = false) => {
    const q = el.value.trim().toLowerCase();
    if (!fromRemote) { extra = []; lookup(q); }
    const local = list.filter((t) => !q || String(t.team).startsWith(q) || t.name.toLowerCase().includes(q)).slice(0, 8);
    items = [...local, ...extra.filter((x) => !local.some((l) => l.team === x.team))].slice(0, 8);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    box.innerHTML = items.length
      ? items.map((t, k) => `<button type="button" class="pick-item ${k === sel ? "sel" : ""}" data-k="${k}"><b>${t.team}</b><span>${esc(t.name)}</span><small class="faint">${t.remote ? "no rating yet" : t.pre ? "not played yet" : `${t.matches} match${t.matches === 1 ? "" : "es"}`}</small>${epa(t.np, meta)}</button>`).join("")
      : `<div class="pick-empty">No team matches “${esc(el.value.trim())}”</div>`;
    box.classList.add("open");
  };
  const choose = (k) => { const t = items[k]; if (!t) return; el.value = `${t.team}`; box.classList.remove("open"); onPick(t.team); };
  el.onfocus = () => { sel = 0; draw(); };
  el.oninput = () => { sel = 0; draw(); };
  el.onblur = () => setTimeout(() => box.classList.remove("open"), 120);
  el.onkeydown = (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") { if (/^\d{1,6}$/.test(el.value.trim()) && !items.length) onPick(+el.value.trim()); else choose(sel); e.preventDefault(); }
    else if (e.key === "Escape") { box.classList.remove("open"); el.blur(); }
  };
  box.onmousedown = (e) => { const b = e.target.closest("[data-k]"); if (b) { e.preventDefault(); choose(+b.dataset.k); } };
}

// Head to head: two teams side by side, this season or across every season.
// ?a=<team>&b=<team>&view=season|career
async function h2h(r) {
  const { season, query } = r;
  const num = (k) => (/^\d{1,6}$/.test(query.get(k) ?? "") ? +query.get(k) : null);
  const A = num("a"), B = num("b"), view = query.get("view") === "career" ? "career" : "season";
  const [meta, rows] = await Promise.all([data.meta(season), data.teams(season)]);
  if (stale(r)) return;
  const byEpa = [...rows].sort((x, y) => y.np - x.np);
  const href = (o) => `#/${season}/h2h?${new URLSearchParams(Object.entries({ a: A ?? "", b: B ?? "", view, ...o }).filter(([, v]) => v !== "" && v != null && !(v === "season"))).toString()}`;
  const slot = (side, n) => `<div class="side card ${side === "a" ? "red" : "blue"}">
      <div class="side-head"><b class="${side === "a" ? "red" : "blue"}-text">${side === "a" ? "Team A" : "Team B"}</b></div>
      <div class="slot"><input autocomplete="off" placeholder="Team # or name" id="h2h-${side}" value="${n ?? ""}" aria-label="${side === "a" ? "First" : "Second"} team"><div class="pick" role="listbox"></div><div class="who" id="who-${side}"></div></div></div>`;
  app.innerHTML = `
    <div class="card card-pad"><div class="page-head"><div>
      <div class="kicker">${seasonLabel(season, meta.game)}</div>
      <h1>Head to head</h1>
      <p class="muted desk-only" style="margin:4px 0 0">Two teams side by side: this season's ratings and every match they've played against or with each other, or their whole careers.</p>
    </div>${competeModes(season, "h2h")}</div></div>
    <div class="compete-bar section">
      <nav class="chart-pick" aria-label="Compare over">${[["season", "This season"], ["career", "Career"]].map(([k, l]) => `<a href="${href({ view: k })}" class="${k === view ? "active" : ""}">${l}</a>`).join("")}</nav>
      <div class="row"><button type="button" class="pill" id="h2h-swap">⇄ Swap</button></div>
    </div>
    <div class="predictor section">${slot("a", A)}<div class="vs"><span>VS</span></div>${slot("b", B)}</div>
    <div id="out"></div>`;
  teamTypeahead($("#h2h-a"), byEpa, meta, (n) => (location.hash = href({ a: n })));
  teamTypeahead($("#h2h-b"), byEpa, meta, (n) => (location.hash = href({ b: n })));
  $("#h2h-swap").onclick = () => (location.hash = href({ a: B ?? "", b: A ?? "" }));

  const seasons = view === "career" ? [...state.seasons].sort((x, y) => x - y) : [season];
  const load = (n) => (n == null ? Promise.resolve(null) : Promise.all(seasons.map((s) => data.team(s, n).catch(() => null))));
  const [ta, tb] = await Promise.all([load(A), load(B)]);
  if (stale(r)) return;
  const cur = (all) => all?.[seasons.indexOf(season)] ?? null;
  const anyOf = (all) => all?.find(Boolean) ?? null;
  for (const [side, n, all] of [["a", A, ta], ["b", B, tb]]) {
    const t = view === "career" ? anyOf(all) : cur(all);
    $(`#who-${side}`).innerHTML = n == null ? "" : t ? `<a href="#/${season}/team/${n}">${esc(t.name)}</a>` : `<span class="faint">No ${view === "career" ? "" : `${season} `}matches for team ${n}</span>`;
  }
  const out = $("#out");
  if (A == null || B == null || !(view === "career" ? anyOf(ta) && anyOf(tb) : cur(ta) && cur(tb))) {
    out.innerHTML = `<div class="section"><div class="card empty">Pick two teams${view === "season" ? " that have played this season" : ""}.</div></div>`;
    return;
  }
  if (A === B) { out.innerHTML = `<div class="section"><div class="card empty">Pick two different teams.</div></div>`; return; }

  // one row of the tale of the tape: mirrored bars, the better side in its colour
  const tape = (label, va, vb, show, { low = false, tip = "", text = null, cls = "" } = {}) => {
    const ok = va != null && vb != null;
    const better = !ok || va === vb ? 0 : (low ? va < vb : va > vb) ? -1 : 1;
    const size = (v, o) => {
      if (v == null) return 0;
      // low = a rank share (0 = best, 1 = last): the bar is the share of teams it beat
      if (low) return Math.max(2, Math.round((1 - v) * 100));
      const top = Math.max(v, o ?? 0, 1e-9);
      return Math.max(0, Math.round((Math.max(0, v) / top) * 100));
    };
    return `<div class="tape-row${cls ? ` ${cls}` : ""}"${tip ? ` title="${esc(tip)}"` : ""}>
      <b class="tape-v ${better === -1 ? "win red-text" : "muted"}">${va == null ? "–" : text ? text[0] : show(va)}</b>
      <span class="tape-bar left"><i class="red" style="width:${size(va, vb)}%"></i></span>
      <span class="tape-k">${label}</span>
      <span class="tape-bar"><i class="blue" style="width:${size(vb, va)}%"></i></span>
      <b class="tape-v r ${better === 1 ? "win blue-text" : "muted"}">${vb == null ? "–" : text ? text[1] : show(vb)}</b></div>`;
  };
  const rate = (x) => (x.length ? x.filter((m) => m.score > m.oppScore).length / x.length : null);
  const rpSum = (t) => (meta.rpNames.length ? meta.rpNames.reduce((sum, _, i) => sum + Math.min(1, Math.max(0, t.epa.rp?.[i] ?? 0)), 0) : null);
  const names = (n, t) => `<a href="#/${season}/team/${n}"><b>${n}</b> ${esc(t.name)}</a>`;
  const headRow = (ta1, tb1) => `<div class="tape-head"><span class="red-text">${names(A, ta1)}</span><span class="blue-text r">${names(B, tb1)}</span></div>`;

  // matches the two shared, from A's side: against each other, and as partners
  const shared = (ma, s) => {
    const vs = ma.filter((m) => m.opps.includes(B)), withB = ma.filter((m) => m.partners.includes(B));
    return { vs, withB, s };
  };
  const recordOf = (ms) => {
    const w = ms.filter((m) => m.score > m.oppScore).length, l = ms.filter((m) => m.score < m.oppScore).length;
    return `${w}-${l}${ms.length - w - l ? `-${ms.length - w - l}` : ""}`;
  };
  const meetTable = (groups, evNames) => {
    const rowsH = groups.flatMap(({ vs, withB, s }) => [...vs.map((m) => ({ m, s, kind: "vs" })), ...withB.map((m) => ({ m, s, kind: "with" }))])
      .sort((x, y) => (y.m.time ?? 0) - (x.m.time ?? 0));
    if (!rowsH.length) return `<div class="card empty">They haven't played ${view === "career" ? "each other or together in any season" : "each other or together this season"}.</div>`;
    return `<div class="card"><div class="table-wrap"><table class="meet">
      <thead><tr>${view === "career" ? "<th>Season</th>" : ""}<th>Event</th><th>Match</th><th>How</th><th class="c" title="${A}'s alliance first">Score</th><th class="c hide-sm">Result for ${A}</th></tr></thead>
      <tbody>${rowsH.map(({ m, s, kind }) => `<tr>
        ${view === "career" ? `<td class="small muted">${s}–${String(s + 1).slice(2)}</td>` : ""}
        <td class="small"><a href="#/${s}/event/${m.ev}">${esc(evNames.get(`${s}:${m.ev}`) ?? m.ev)}</a></td>
        <td><a class="match-link" href="${matchHref(s, m.ev, m.m)}">${esc(m.m)}</a></td>
        <td class="small">${kind === "vs" ? "Against" : `<span class="muted">Together</span>`}</td>
        <td class="c"><span class="final"><span class="${m.score > m.oppScore ? "w" : "l"}">${m.score}</span><span class="faint">–</span><span class="${m.oppScore > m.score ? "w" : "l"}">${m.oppScore}</span></span></td>
        <td class="c small hide-sm">${m.score > m.oppScore ? "Won" : m.score < m.oppScore ? "Lost" : "Tie"}</td></tr>`).join("")}</tbody></table></div></div>`;
  };
  const evNames = new Map();
  seasons.forEach((s, i) => { for (const t of [ta[i], tb[i]]) for (const e of t?.events ?? []) evNames.set(`${s}:${e.code}`, e.name); });

  // awards side by side: one row per award either team has won, in the usual order
  // (alliance results first, then judged awards); hover a row for where each was won
  const awardsOf = (all) => seasons.flatMap((s, i) => (all[i]?.awards ?? []).map((a) => ({ ...a, s })));
  const awardsCard = () => {
    const la = awardsOf(ta), lb = awardsOf(tb);
    const ORDER = ["Winner", "DivisionWinner", "Finalist", "DivisionFinalist", "ConferenceFinalist"];
    const types = [...ORDER, ...Object.keys(AWARD_NAMES).filter((k) => !ORDER.includes(k))].filter((k) => la.some((a) => a.type === k) || lb.some((a) => a.type === k));
    if (!types.length) return `<div class="card empty desk-only">Neither team has won an award ${view === "career" ? "yet" : "this season"}.</div>`;
    const where = (n, list) => list.map((a) => `${a.placement > 1 && !/Winner|Finalist/.test(a.type) ? `${ordinal(a.placement)} · ` : ""}${a.evName ?? a.ev}${view === "career" ? ` (${a.s}–${String(a.s + 1).slice(2)})` : ""}`).join("; ");
    return `<div class="card card-pad desk-only"><div class="tape">${types.map((k) => {
      const xa = la.filter((a) => a.type === k), xb = lb.filter((a) => a.type === k);
      const label = (AWARD_NAMES[k] ?? k).replace(/ Award$/, "");
      return tape(label, xa.length, xb.length, (v) => fmtInt(v), { tip: [xa.length ? `${A}: ${where(A, xa)}` : "", xb.length ? `${B}: ${where(B, xb)}` : ""].filter(Boolean).join("\n") });
    }).join("")}</div></div>`;
  };
  // phones: the tape's Awards row is the summary; the per-award breakdown is desk-only
  const awardsTitle = `<div class="section-title desk-only"><h2>Awards</h2><p class="muted desk-only" style="margin:6px 0 0">How many times each team has won each award${view === "career" ? " across every season" : " this season"}, counting 2nd and 3rd places. Hover a row for where.</p></div>`;

  if (view === "season") {
    const a = cur(ta), b = cur(tb);
    const g = shared(a.matches, season);
    out.innerHTML = `
      <div class="section card card-pad">${headRow(a, b)}<div class="tape">
        ${tape("EPA", a.epa.np, b.epa.np, (v) => fmt(v), { tip: EPA_TIP })}
        ${tape("Auto", a.epa.auto, b.epa.auto, (v) => fmt(v), { cls: "desk-only" })}
        ${tape("Teleop", a.epa.teleop, b.epa.teleop, (v) => fmt(v), { cls: "desk-only" })}
        ${tape("Endgame", a.epa.endgame, b.epa.endgame, (v) => fmt(v), { cls: "desk-only" })}
        ${meta.rpNames.length ? tape("Bonus RPs", rpSum(a), rpSum(b), (v) => fmt(v), { tip: "Bonus ranking points earned in an average match", cls: "desk-only" }) : ""}
        ${tape("Win rate", rate(a.matches), rate(b.matches), (v) => pct(v), { tip: "Share of matches won (partners count too)" })}
        ${tape("Matches", a.matches.length, b.matches.length, (v) => fmtInt(v))}
        ${tape("World rank", a.rank / a.of, b.rank / b.of, () => "", { low: true, text: [`#${fmtInt(a.rank)}`, `#${fmtInt(b.rank)}`], tip: `Bars: share of the season's ${fmtInt(a.of)} teams ranked below` })}
        ${tape("Awards", (a.awards ?? []).length, (b.awards ?? []).length, (v) => fmtInt(v))}
      </div></div>
      ${awardsTitle}${awardsCard()}
      <div class="section-title"><h2>EPA through the season</h2><p class="muted desk-only" style="margin:6px 0 0">By match number (1st match, 2nd, …) so seasons of different lengths line up.</p></div>
      <div class="card card-pad"><div id="chart"></div></div>
      <div class="section-title"><h2>When they met</h2><p class="muted" style="margin:6px 0 0">Against each other: <b>${recordOf(g.vs)}</b> for ${A} · Together: <b>${recordOf(g.withB)}</b> · scores show ${A}'s alliance first</p></div>
      ${meetTable([g], evNames)}`;
    const len = Math.max(a.matches.length, b.matches.length);
    const pad = (arr) => Array.from({ length: len }, (_, i) => arr[i] ?? null);
    mountLineChart($("#chart"), {
      series: [
        { name: `${A} ${a.name}`, color: "var(--red)", values: pad(a.matches.map((m) => m.epa[0])), width: 2.5, smooth: true },
        { name: `${B} ${b.name}`, color: "var(--blue)", values: pad(b.matches.map((m) => m.epa[0])), width: 2.5, smooth: true },
      ],
      tooltip: (i) => [[A, a.matches[i]], [B, b.matches[i]]].filter(([, m]) => m).map(([n, m]) => `<b>${n}</b> · ${esc(shortEvent(evNames.get(`${season}:${m.ev}`) ?? m.ev))} ${esc(m.m)} · EPA ${fmt(m.epa[0])}`).join("<br>") + `<br><span class="faint">match ${i + 1}</span>`,
    });
    return;
  }

  // career: raw EPA isn't comparable across games, so seasons compare by world rank (top x%)
  const groups = seasons.map((s, i) => (ta[i] && tb[i] ? shared(ta[i].matches, s) : null)).filter(Boolean);
  const total = (all) => {
    const ss = all.filter(Boolean), ms = ss.flatMap((t) => t.matches), aw = ss.flatMap((t) => t.awards ?? []);
    const best = ss.reduce((bst, t, i) => (t.rank && (!bst || t.rank / t.of < bst.p) ? { p: t.rank / t.of, t } : bst), null);
    return { seasons: ss.length, matches: ms.length, rate: rate(ms), awards: aw.length, banners: aw.filter(isBanner).length, best: best?.p ?? null };
  };
  const ca = total(ta), cb = total(tb);
  const topPct = (p) => `Top ${Math.max(1, Math.round(p * 100))}%`;
  const seasonRows = seasons.map((s, i) => {
    const a = ta[i], b = tb[i];
    if (!a && !b) return "";
    return tape(`${s}–${String(s + 1).slice(2)} <small class="faint">${esc(SEASONS[s]?.game ?? "")}</small>`, a?.rank ? a.rank / a.of : null, b?.rank ? b.rank / b.of : null,
      (v) => topPct(v), { low: true, text: [a ? `#${fmtInt(a.rank)}` : "–", b ? `#${fmtInt(b.rank)}` : "–"], tip: `${a ? `${A}: #${fmtInt(a.rank)} of ${fmtInt(a.of)}, EPA ${fmt(a.epa.np)}` : `${A} didn't play`} · ${b ? `${B}: #${fmtInt(b.rank)} of ${fmtInt(b.of)}, EPA ${fmt(b.epa.np)}` : `${B} didn't play`}` });
  }).reverse().join("");
  const allVs = groups.flatMap((x) => x.vs), allWith = groups.flatMap((x) => x.withB);
  out.innerHTML = `
    <div class="section card card-pad">${headRow(anyOf(ta), anyOf(tb))}<div class="tape">
      ${tape("Seasons", ca.seasons, cb.seasons, (v) => fmtInt(v))}
      ${tape("Matches", ca.matches, cb.matches, (v) => fmtInt(v))}
      ${tape("Win rate", ca.rate, cb.rate, (v) => pct(v))}
      ${tape("Best season", ca.best, cb.best, (v) => topPct(v), { low: true, tip: "Best world rank in any season, as a share of that season's teams" })}
      ${tape("Awards", ca.awards, cb.awards, (v) => fmtInt(v))}
      ${tape("Wins (banners)", ca.banners, cb.banners, (v) => fmtInt(v), { tip: "Event wins and Inspire awards" })}
    </div></div>
    <div class="section-title"><h2>Season by season</h2><p class="muted desk-only" style="margin:6px 0 0">World rank each season; bars compare it as a share of that season's teams, since each game scores differently and EPAs don't compare across seasons. Hover for EPAs.</p></div>
    <div class="card card-pad"><div class="tape">${seasonRows}</div></div>
    ${awardsTitle}${awardsCard()}
    <div class="section-title"><h2>When they met</h2><p class="muted" style="margin:6px 0 0">Against each other: <b>${recordOf(allVs)}</b> for ${A} · Together: <b>${recordOf(allWith)}</b> · scores show ${A}'s alliance first</p></div>
    ${meetTable(groups, evNames)}`;
}

// ---------------- about / accuracy ----------------

async function about(r) {
  const { season } = r;
  const [meta, bt] = await Promise.all([data.meta(season), data.ranking(season)]);
  if (stale(r)) return;
  const a = meta.accuracy, c = meta.compare;
  const row = (k, label) => a[k] ? `<tr><td>${label}</td><td class="r">${fmtInt(a[k].matches)}</td><td class="r"><b>${pct(a[k].accuracy, 1)}</b></td><td class="r">${fmt(a[k].brier, 3)}</td><td class="r hide-sm">${fmt(a[k].scoreMae)}</td>${meta.rpNames.length ? `<td class="r hide-sm">${a[k].rpBrier != null ? fmt(a[k].rpBrier, 3) : "–"}</td>` : ""}</tr>` : "";
  const cmpRow = (k, name, note) => c?.[k] ? `<tr><td>${k === "epa" ? `<b>${name}</b>` : name}<div class="small muted desk-only">${note}</div></td><td class="r">${k === "epa" ? `<b>${pct(c[k].accuracy, 1)}</b>` : pct(c[k].accuracy, 1)}</td><td class="r">${fmt(c[k].brier, 3)}</td></tr>` : "";
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
      <p><b>EPA and predictions.</b> The <b>EPA</b> in team lists, team pages and "Top teams" is tuned to show how strong each robot is right now: the EPA a team brings to an event should match what it actually scores there. Win chances, predicted scores and ranking forecasts come from the same match data but with settings tuned only to call matches well (for example, pulling every rating a little toward average, which would understate the best robots in a list), so they don't follow exactly from the EPAs shown.</p>
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
      <div class="card about-tbl"><div class="table-wrap"><table>
        <thead><tr><th>Rating</th><th class="r">Winner correct</th><th class="r">Brier</th></tr></thead><tbody>
        ${cmpRow("epa", "EPA (this site)", "points added, per robot, updated every match")}
        ${cmpRow("opr", "OPR, updated live", "what FTCScout shows, re-solved before every match")}
        ${cmpRow("avg", "Average score so far", "each team's average alliance score")}
        ${cmpRow("elo", "Elo", "wins and losses only, like chess ratings")}
      </tbody></table></div></div>
      <div class="card card-pad desk-only"><div class="small muted">Winners called by month: EPA vs OPR</div><div id="by-month"></div></div>
    </div>` : ""}

    <div class="section-title"><div class="eyebrow">Track record</div><h2>How EPA did in ${season}</h2></div>
    <div class="card about-tbl"><div class="table-wrap"><table>
      <thead><tr><th></th><th class="r">Matches</th><th class="r">Winner correct</th><th class="r">Brier</th><th class="r hide-sm">Score error (avg pts)</th>${meta.rpNames.length ? '<th class="r hide-sm">Bonus RP Brier</th>' : ""}</tr></thead>
      <tbody>${row("all", "All matches")}${row("quals", "Qualifications")}${row("elims", "Playoffs")}${row("champs", "Championships")}</tbody>
    </table></div></div>

    <div class="grid cols-2 section">
      <div class="card card-pad desk-only">
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

    <div class="card card-pad section desk-only"><div class="prose">
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
  // the logo robot is drawn from the same parts as everywhere else (index.html has a plain fallback)
  const logoBot = $(".logo-bot .bot-g");
  if (logoBot) logoBot.innerHTML = ROBOT_PARTS;
  // dark only (no theme toggle); forget a light choice saved by the old toggle
  document.documentElement.dataset.theme = "dark";
  try { localStorage.removeItem("theme"); } catch {}

  // one small file says which seasons exist and which to open by default
  const index = await getJSON("data/index.json").catch(() => null);
  if (index) {
    state.seasons = index.seasons;
    state.defaultSeason = index.default;
  } else {
    state.seasons = await data.seasons();
    state.defaultSeason = state.seasons[0];
  }

  wireSeasonPicker();
  wireSearch($(".nav-search"));
  wireNavSearchToggle();
  // match page: play in the page's own player (and bring it into view)
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-play-inline]")) return;
    const box = $("#stage-video");
    if (!box) return;
    if (!box.querySelector("iframe")) {
      const { id, t, title } = box.dataset;
      box.innerHTML = `<iframe src="${videoLinks(id, +t || 0).embed}" title="${esc(title)}"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    }
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.addEventListener("click", (e) => { const b = e.target.closest("[data-share]"); if (b) { e.preventDefault(); share(b); } });
  // match videos: one player dialog for every ▶ button
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-video]");
    if (!b) return;
    e.preventDefault();
    // the owner turned off embedding: open it on YouTube at the same moment
    if (b.dataset.ext) { open(videoLinks(b.dataset.video, +b.dataset.t || 0).open, "_blank", "noopener"); return; }
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
  // whole-row clicks: a row whose main link is an event, team or match opens it, so
  // people don't have to hit the name itself
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.target.closest("a, button, input, select, label")) return;
    const row = e.target.closest("#app tbody tr");
    const link = row?.querySelector("a.ev-cell, a.team-cell, a.match-link");
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
