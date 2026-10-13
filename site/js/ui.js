// Small shared helpers: data loading, formatting, and shared UI pieces.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const cache = new Map();
export function getJSON(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    }).catch((e) => { cache.delete(url); throw e; }));
  }
  return cache.get(url);
}

export const data = {
  seasons: () => getJSON("data/seasons.json"),
  meta: (s) => getJSON(`data/${s}/meta.json`),
  events: (s) => getJSON(`data/${s}/events.json`),
  event: (s, code) => getJSON(`data/${s}/event/${code}.json`),
  summary: (s) => getJSON(`data/${s}/summary.json`),
  videos: (s) => getJSON(`data/${s}/videos.json`).catch(() => ({})),
  alliances: (s) => getJSON(`data/${s}/alliances.json`).catch(() => ({})),
  // approved photos: from the upload service when configured, plus any stored in the repo
  async photos(api) {
    const [repo, svc] = await Promise.all([
      getJSON("photos/index.json").catch(() => ({})),
      api ? getJSON(`${api}/api/photos`).catch(() => ({})) : {},
    ]);
    const out = { ...repo };
    for (const [team, list] of Object.entries(svc)) {
      out[team] = [...(out[team] ?? []), ...list.map((p) => ({ file: p.url, caption: p.caption, credit: "" }))];
    }
    return out;
  },
  ranking: (s) => getJSON(`data/${s}/ranking.json`).catch(() => null),
  async team(s, n) {
    const bucket = await getJSON(`data/${s}/team/${Math.floor(n / 100)}.json`).catch(() => ({}));
    if (!bucket[n]) throw new Error(`no team ${n}`);
    return bucket[n];
  },
  rows(cols, rows) {
    return rows.map((r, i) => {
      const o = { rank: i + 1 };
      cols.forEach((c, j) => (o[c] = r[j]));
      return o;
    });
  },
  async teams(s) {
    const { cols, rows } = await getJSON(`data/${s}/teams.json`);
    if (!rows._objs) rows._objs = rows.map((r, i) => {
      const o = { rank: i + 1 };
      cols.forEach((c, j) => (o[c] = r[j]));
      return o;
    });
    return rows._objs;
  },
};

export const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
export const pct = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
export const fmtInt = (x) => (x == null ? "–" : Number(x).toLocaleString());

export function fmtDate(s, opts = { month: "short", day: "numeric" }) {
  if (!s) return "";
  const d = new Date(`${s}T12:00:00`);
  return d.toLocaleDateString(undefined, opts);
}
export function fmtRange(a, b) {
  if (!b || a === b) return fmtDate(a, { month: "short", day: "numeric", year: "numeric" });
  return `${fmtDate(a)} – ${fmtDate(b, { month: "short", day: "numeric", year: "numeric" })}`;
}

const TYPE_NAMES = {
  FIRSTChampionship: "Worlds", Championship: "Championship", SuperQualifier: "Super Qualifier",
  Qualifier: "Qualifier", LeagueTournament: "League Tournament", LeagueMeet: "League Meet",
  Scrimmage: "Scrimmage", Premier: "Premier", OffSeason: "Off-season", NonAdvancement: "Scrimmage",
  Other: "Other", InnovationChallenge: "Innovation", Kickoff: "Kickoff",
};
export const typeName = (t) => TYPE_NAMES[t] ?? t;

// EPA chip, colored by where the value sits in this season's distribution.
export function epa(v, meta, d = 1) {
  if (v == null) return `<span class="epa e25">–</span>`;
  const p = meta.percentiles;
  const cls = v >= p.p99 ? "e99" : v >= p.p90 ? "e90" : v >= p.p75 ? "e75" : v >= p.p25 ? "e50" : "e25";
  return `<span class="epa ${cls}">${fmt(v, d)}</span>`;
}

export function teamCell(s, n, name) {
  return `<a class="team-cell" href="#/${s}/team/${n}"><span class="n">${n}</span><span class="nm">${esc(name)}</span></a>`;
}

export function evCell(s, code, name, sub) {
  return `<a class="ev-cell" href="#/${s}/event/${code}"><span class="n">${esc(name)}</span><span class="nm">${sub}</span></a>`;
}

export function trend(v, d = 1) {
  if (v == null || Math.abs(v) < 0.5) return `<span class="faint">—</span>`;
  return v > 0 ? `<span class="trend-up">▲ ${fmt(v, d)}</span>` : `<span class="trend-down">▼ ${fmt(-v, d)}</span>`;
}

// Dot meter: value out of max, as `n` dots.
export function dots(value, max, n = 20) {
  const on = Math.max(0, Math.min(n, Math.round((value / Math.max(1e-9, max)) * n)));
  return `<span class="dots">${"<i class=on></i>".repeat(on)}${"<i></i>".repeat(n - on)}</span>`;
}

export function meter(label, value, max, display) {
  return `<div class="meter"><span class="k">${esc(label)}</span>${dots(value, max)}<span class="v">${display ?? fmt(value)}</span></div>`;
}

// Bonus-RP icons: one per ranking point, in the alliance colour when earned
// (or predicted > 50%), faded when not. Hovering names each RP.
const RP_ICONS = {
  // DECODE
  movement: '<path d="M2 8h9M8 4.5 11.5 8 8 11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  goal: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="2.3" fill="currentColor"/>',
  pattern: '<rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor"/><rect x="9" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor"/>',
  // BIOBUZZ
  swarm: '<path d="M8 1.8 13.4 5v6L8 14.2 2.6 11V5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  pollinator: '<circle cx="8" cy="4.6" r="2.4" fill="currentColor"/><circle cx="11.4" cy="8" r="2.4" fill="currentColor"/><circle cx="8" cy="11.4" r="2.4" fill="currentColor"/><circle cx="4.6" cy="8" r="2.4" fill="currentColor"/><circle cx="8" cy="8" r="1.6" fill="var(--surface)"/>',
};
const rpIcon = (name, i) => {
  const key = Object.keys(RP_ICONS).find((k) => String(name ?? "").toLowerCase().startsWith(k));
  const body = key ? RP_ICONS[key] : `<text x="8" y="12" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">${i + 1}</text>`;
  const n = String(name ?? "").match(/\d+$/)?.[0]; // "Pollinator 2" gets a small 2
  return `<svg viewBox="0 0 16 16" width="14" height="14">${body}${n ? `<text x="15" y="16" text-anchor="end" font-size="7" font-weight="800" fill="currentColor">${n}</text>` : ""}</svg>`;
};
const rpDots = (side, arr, names = [], verb = "earned") => {
  if (!arr) return "";
  const tip = names.length ? `${side === "red" ? "Red" : "Blue"} ${verb}: ${arr.map((x, i) => `${names[i] ?? `RP ${i + 1}`} ${x ? "✓" : "✗"}`).join(" · ")}` : "";
  return `<span class="rpd ${side}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${arr.map((x, i) => `<i class="${x ? "on" : ""}">${rpIcon(names[i], i)}</i>`).join("")}</span>`;
};

// Slim red/blue bar with the favourite's chance beside it, always in the same place.
export function winBar(pRed) {
  if (pRed == null) return `<span class="faint">–</span>`;
  const r = Math.round(pRed * 100);
  const fav = r >= 50 ? "red" : "blue";
  return `<span class="wp" title="Red ${r}% · Blue ${100 - r}%"><span class="wp-track"><span class="wp-red" style="width:${r}%"></span></span><span class="wp-label ${fav}">${Math.max(r, 100 - r)}%</span></span>`;
}

// One row per match.
// m: { d, red, blue, played, redScore:{np, rp}, blueScore, pred:{pRed, red:{np, rp}, blue:{np, rp}} }
// Video for a match: a per-match upload (FIRST's own, or a timestamped spot in an
// uploaded event video) if there is one, otherwise the event's livestream
// recording at the moment the match started.
const LEAD_SECONDS = 20; // start a little early: field visible before "go", and most streams are within ±20s of official times
export function videoFor(videos, evCode, time) {
  const v = videos?.[evCode];
  if (!v || !time) return null;
  const up = v.uploads.find((u) => Math.abs(u.t - time) < 90e3);
  if (up) return { id: up.id, t: up.at ?? 0 }; // at: the match's listed spot in a longer video (these lists run ~40 s early already)
  const s = v.streams.find((s) => time >= s.start && time <= s.end);
  return s ? { id: s.id, t: Math.max(0, Math.round((time - s.start) / 1000) - LEAD_SECONDS) } : null;
}

export const PLAY_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.2v7.6L8.6 5Z" fill="currentColor"/></svg>';

export function matchTable(s, matches, { me, rpNames = [], video, href } = {}) {
  if (!matches.length) return `<div class="empty">No matches yet.</div>`;
  const slots = Math.max(2, ...matches.map((m) => Math.max(m.red.length, m.blue.length)));
  const teams = (side, nums) => Array.from({ length: slots }, (_, i) =>
    nums[i] != null ? `<td class="c"><a class="tn ${side} ${nums[i] === me ? "me" : ""}" href="#/${s}/team/${nums[i]}">${nums[i]}</a></td>` : "<td></td>").join("");
  const rows = matches.map((m) => {
    const rs = m.redScore?.total ?? m.redScore?.np, bs = m.blueScore?.total ?? m.blueScore?.np;
    // upsets (the favourite lost) get a faint red row
    const upset = m.played && m.pred && rs !== bs && (m.pred.pRed > 0.5) !== (rs > bs);
    const pr = m.pred?.red?.rp?.map((p) => p > 0.5), pb = m.pred?.blue?.rp?.map((p) => p > 0.5);
    const pred = m.pred?.red?.np != null
      ? `${rpDots("red", pr, rpNames, "likely to earn")} <span class="pscore">${fmt(m.pred.red.total ?? m.pred.red.np, 0)}–${fmt(m.pred.blue.total ?? m.pred.blue.np, 0)}</span> ${rpDots("blue", pb, rpNames, "likely to earn")}`
      : "";
    const final = m.played
      ? `${rpDots("red", m.redScore.rp, rpNames)} <span class="final"><span class="${rs > bs ? "w" : "l"}">${rs}</span><span class="faint">–</span><span class="${bs > rs ? "w" : "l"}">${bs}</span></span> ${rpDots("blue", m.blueScore.rp, rpNames)}`
      : `<span class="faint small">upcoming</span>`;
    return `<tr class="${upset ? "upset" : ""}">
      ${m.evName ? `<td class="small"><a href="#/${s}/event/${m.ev}">${esc(m.evName)}</a></td>` : ""}
      <td class="lvl">${(() => {
        const v = m.played && video?.(m);
        const label = href ? `<a class="match-link" href="${href(m)}">${esc(m.d)}</a>` : esc(m.d);
        return `<span class="lvl-cell">${label}${v ? `<button class="play" data-video="${v.id}" data-t="${v.t}" data-title="${esc(m.d)}" aria-label="Watch ${esc(m.d)}" title="Watch this match">${PLAY_ICON}</button>` : ""}</span>`;
      })()}</td>
      ${teams("red", m.red)}${teams("blue", m.blue)}
      <td class="c hide-sm">${pred}</td>
      <td class="c">${winBar(m.pred?.pRed)}</td>
      <td class="c">${final}</td>
    </tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="mt">
    <thead><tr>${matches[0].evName ? "<th>Event</th>" : ""}<th>Match</th><th class="c" colspan="${slots}">Red</th><th class="c" colspan="${slots}">Blue</th><th class="c hide-sm"><span class="th-tip" data-tip="Predicted score before the match (red–blue), from each team's EPA.${rpNames.length ? " Icons: bonus RPs each alliance was likely to earn." : ""}">Pred</span></th><th class="c"><span class="th-tip" data-tip="Chance of winning before the match. The number is the favourite's chance, in its colour; the bar shows red vs blue. A faint red row means the favourite lost.">Win prob</span></th><th class="c"><span class="th-tip" data-tip="Final score including penalty points (red–blue); the winner is in green.${rpNames.length ? " Icons: bonus RPs earned (hover them to see which)." : ""}">Final</span></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------- line chart ----------
// series: [{ name, color, values: number[] }], bands: [{ from, to, label }]
export function mountLineChart(el, { series, bands = [], tooltip, zero = true }) {
  const hidden = new Set();
  const legend = document.createElement("div");
  legend.className = "series-toggle";
  legend.innerHTML = series.map((s, i) =>
    `<button data-i="${i}"><i style="background:${s.color}"></i>${esc(s.name)}</button>`).join("");
  const box = document.createElement("div");
  box.className = "chart";
  el.replaceChildren(legend, box);

  const draw = () => {
    const W = box.clientWidth || 600, H = 260, P = { l: 36, r: 10, t: 16, b: 24 };
    const vis = series.filter((_, i) => !hidden.has(i));
    const n = Math.max(...series.map((s) => s.values.length));
    const all = vis.flatMap((s) => s.values).filter((v) => v != null);
    const lo = zero ? Math.min(0, ...all) : Math.floor(Math.min(...all) / 5) * 5 - 5;
    const hi = zero ? Math.max(10, ...all) * 1.08 : Math.ceil(Math.max(...all) / 5) * 5 + 2;
    const x = (i) => P.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - P.l - P.r));
    const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const step = niceStep((hi - lo) / 4);
    let g = "";
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      g += `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
    }
    bands.forEach((b, i) => {
      const x0 = x(b.from) - (b.from ? (x(1) - x(0)) / 2 : 0), x1 = x(b.to) + (b.to < n - 1 ? (x(1) - x(0)) / 2 : 0);
      if (i % 2) g += `<rect x="${x0}" y="${P.t}" width="${Math.max(0, x1 - x0)}" height="${H - P.t - P.b}" fill="var(--surface-2)" opacity=".6"/>`;
      // fit the label to its band (about 6px per character), or skip it
      const fit = Math.floor((x1 - x0 - 6) / 6);
      if (fit >= 4) {
        const text = b.label.length > fit ? `${b.label.slice(0, fit - 1)}…` : b.label;
        g += `<text x="${(x0 + x1) / 2}" y="${H - 6}" text-anchor="middle">${esc(text)}<title>${esc(b.label)}</title></text>`;
      }
    });
    const paths = vis.map((s) => {
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}${paths}<line class="cursor" y1="${P.t}" y2="${H - P.b}" stroke="var(--faint)" stroke-dasharray="3 3" style="display:none"/></svg><div class="tip"></div>`;
    const svg = box.querySelector("svg"), tip = box.querySelector(".tip"), cur = box.querySelector(".cursor");
    svg.onpointermove = (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (n - 1))));
      cur.setAttribute("x1", x(i)); cur.setAttribute("x2", x(i)); cur.style.display = "";
      tip.innerHTML = tooltip(i, vis);
      tip.style.display = "block";
      const left = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(left + 12, r.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `8px`;
    };
    svg.onpointerleave = () => { tip.style.display = "none"; cur.style.display = "none"; };
  };
  legend.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const i = +b.dataset.i;
    hidden.has(i) ? hidden.delete(i) : hidden.add(i);
    b.classList.toggle("off", hidden.has(i));
    draw();
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(box);
}

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

// Sortable table: cols [{ key, label, cls, render(row), sort? }]
export function sortableTable(el, rows, cols, { sortKey, desc = true, pageSize = 100 } = {}) {
  let key = sortKey, dir = desc ? -1 : 1, shown = pageSize;
  const draw = () => {
    const sorted = [...rows].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    });
    const head = cols.map((c) =>
      `<th class="${c.cls ?? ""} ${c.sort === false ? "" : "sortable"} ${c.key === key ? `sorted col-sorted ${dir > 0 ? "asc" : ""}` : ""}" data-k="${c.key}">${c.label}</th>`).join("");
    const body = sorted.slice(0, shown).map((r) =>
      `<tr>${cols.map((c) => `<td class="${c.cls ?? ""} ${c.key === key ? "col-sorted" : ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("");
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="empty">Nothing matches.</td></tr>`}</tbody></table></div>${
      sorted.length > shown ? `<button class="more">Show more (${fmtInt(sorted.length - shown)} left)</button>` : ""}`;
    el.querySelectorAll("th.sortable").forEach((th) => (th.onclick = () => {
      const k = th.dataset.k;
      if (k === key) dir = -dir; else { key = k; dir = -1; }
      draw();
    }));
    const more = el.querySelector(".more");
    if (more) more.onclick = () => { shown += pageSize * 2; draw(); };
  };
  draw();
  return { setRows(r) { rows = r; shown = pageSize; draw(); } };
}

