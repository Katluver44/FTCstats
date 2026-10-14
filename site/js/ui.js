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
  // videos for just these events ({code: {streams, uploads}}); events without video have no file
  async videos(s, codes) {
    const got = await Promise.all(codes.map((c) => getJSON(`data/${s}/videos/${c}.json`).catch(() => null)));
    return Object.fromEntries(codes.map((c, i) => [c, got[i]]).filter(([, v]) => v));
  },
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
  // last season's teams that haven't played yet this season, on the EPA they start with
  async pre(s) {
    const t = await getJSON(`data/${s}/teams-pre.json`).catch(() => null);
    if (!t) return [];
    if (!t._objs) t._objs = t.rows.map((row) => { const o = { matches: 0, pre: true }; t.cols.forEach((c, j) => (o[c] = row[j])); return o; });
    return t._objs;
  },
  async team(s, n) {
    const bucket = await getJSON(`data/${s}/team/${Math.floor(n / 10)}x.json`).catch(() => ({}));
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
  // table: "official" | "mti" (off-season through MTI) | "full" (all off-season);
  // meta.offTables names each one's file (teams.json when a season has no off-season)
  async teams(s, table = "official") {
    const file = table === "official" ? "teams.json" : (await getJSON(`data/${s}/meta.json`)).offTables?.[table] ?? "teams.json";
    const { cols, rows } = await getJSON(`data/${s}/${file}`);
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
const LEAD_SECONDS = 5; // Arjun: a long lead is worse than occasionally landing a few seconds in; FIRST stamps the match at the scorekeeper's "start"
export function videoFor(videos, evCode, time) {
  const v = videos?.[evCode];
  if (!v || !time) return null;
  const up = v.uploads.find((u) => Math.abs(u.t - time) < 90e3);
  if (up) return { id: up.id, t: up.at ?? 0, ext: up.ext, platform: up.platform }; // at: the match's listed spot in a longer video (these lists run ~40 s early already)
  const s = v.streams.find((s) => time >= s.start && time <= s.end);
  return s ? { id: s.id, t: Math.max(0, Math.round((time - s.start) / 1000) - LEAD_SECONDS), ext: s.ext } : null;
}

// Player and "open on the site" links for a video id. YouTube ids are bare; Bilibili ones are
// "bili:BV…" ("bili:BV…/p3" = page 3 of a multi-part upload). t: seconds in.
export function videoLinks(id, t = 0) {
  const b = String(id).match(/^bili:(BV\w+)(?:\/p(\d+))?$/);
  if (b) {
    const p = +(b[2] ?? 1);
    return { site: "Bilibili", embed: `https://player.bilibili.com/player.html?bvid=${b[1]}&p=${p}&t=${t}&autoplay=0&danmaku=0`,
      open: `https://www.bilibili.com/video/${b[1]}/?p=${p}&t=${t}` };
  }
  const e = encodeURIComponent(id);
  return { site: "YouTube", embed: `https://www.youtube-nocookie.com/embed/${e}?start=${t}&autoplay=1&rel=0`, open: `https://www.youtube.com/watch?v=${e}&t=${t}s` };
}

export const PLAY_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.2v7.6L8.6 5Z" fill="currentColor"/></svg>';

// outline play-circle, as in Statbotics' video column
const VIDEO_ICON = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="1.3"/><path d="M7.1 5.6v6.8L12.4 9Z" fill="currentColor"/></svg>';

export function matchTable(s, matches, { me, rpNames = [], video, href } = {}) {
  if (!matches.length) return `<div class="empty">No matches yet.</div>`;
  const slots = Math.max(2, ...matches.map((m) => Math.max(m.red.length, m.blue.length)));
  const teams = (side, nums) => Array.from({ length: slots }, (_, i) =>
    nums[i] != null ? `<td class="c"><a class="tn ${side} ${nums[i] === me ? "me" : ""}" href="#/${s}/team/${nums[i]}">${nums[i]}</a></td>` : "<td></td>").join("");
  const rows = matches.map((m) => {
    const rs = m.redScore?.total ?? m.redScore?.np, bs = m.blueScore?.total ?? m.blueScore?.np;
    const pr = m.pred?.red?.rp?.map((p) => p > 0.5), pb = m.pred?.blue?.rp?.map((p) => p > 0.5);
    const pred = m.pred?.red?.np != null
      ? `${rpDots("red", pr, rpNames, "likely to earn")} <span class="pscore">${fmt(m.pred.red.total ?? m.pred.red.np, 0)}–${fmt(m.pred.blue.total ?? m.pred.blue.np, 0)}</span> ${rpDots("blue", pb, rpNames, "likely to earn")}`
      : "";
    const final = m.played
      ? `${rpDots("red", m.redScore.rp, rpNames)} <span class="final"><span class="${rs > bs ? "w" : "l"}">${rs}</span><span class="faint">–</span><span class="${bs > rs ? "w" : "l"}">${bs}</span></span> ${rpDots("blue", m.blueScore.rp, rpNames)}`
      : `<span class="faint small">upcoming</span>`;
    return `<tr>
      ${m.evName ? `<td class="small"><a href="#/${s}/event/${m.ev}">${esc(m.evName)}</a></td>` : ""}
      ${video ? `<td class="vid-cell">${(() => {
        if (!m.played) return "";
        const v = video(m);
        return v ? `<button class="vid" data-video="${v.id}" data-t="${v.t}"${v.ext ? ' data-ext="1"' : ""} data-title="${esc(m.d)}" aria-label="Watch ${esc(m.d)}" title="Watch this match">${VIDEO_ICON}</button>`
          : `<span class="vid none" title="No video found for this match">${VIDEO_ICON}</span>`;
      })()}</td>` : ""}
      <td class="lvl">${href ? `<a class="match-link" href="${href(m)}">${esc(m.d)}</a>` : esc(m.d)}</td>
      ${teams("red", m.red)}${teams("blue", m.blue)}
      <td class="c hide-sm">${pred}</td>
      <td class="c">${winBar(m.pred?.pRed)}</td>
      <td class="c">${final}</td>
    </tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="mt">
    <thead><tr>${video ? '<th class="c vid-cell">Video</th>' : ""}${matches[0].evName ? "<th>Event</th>" : ""}<th>Match</th><th class="c" colspan="${slots}">Red</th><th class="c" colspan="${slots}">Blue</th><th class="c hide-sm"><span class="th-tip" data-tip="Predicted score before the match (red–blue), from each team's EPA.${rpNames.length ? " Icons: bonus RPs each alliance was likely to earn." : ""}">Pred</span></th><th class="c"><span class="th-tip" data-tip="Chance of winning before the match. The number is the favourite's chance, in its colour; the bar shows red vs blue.">Win prob</span></th><th class="c"><span class="th-tip" data-tip="Final score including penalty points (red–blue); the winner is in green.${rpNames.length ? " Icons: bonus RPs earned (hover them to see which)." : ""}">Final</span></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------- line chart ----------
// series: [{ name, color, values: number[] }], bands: [{ from, to, label }]
// values may contain nulls (gaps); dash: dashed line; max: fixed top of the y axis
export function mountLineChart(el, { series, bands = [], tooltip, zero = true, max = null }) {
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
    const hi = max ?? (zero ? Math.max(10, ...all) * 1.08 : Math.ceil(Math.max(...all) / 5) * 5 + 2);
    const x = (i) => P.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - P.l - P.r));
    const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const step = niceStep((hi - lo) / 4);
    let g = "";
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      g += `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
    }
    bands.forEach((b, i) => {
      const x0 = x(b.from) - (b.from ? (x(1) - x(0)) / 2 : 0), x1 = x(b.to) + (b.to < n - 1 ? (x(1) - x(0)) / 2 : 0);
      if (i % 2) g += `<rect x="${x0}" y="${P.t}" width="${Math.max(0, x1 - x0)}" height="${H - P.t - P.b}" fill="var(--band)"/>`;
      // fit the label to its band (about 6px per character), or skip it
      const fit = Math.floor((x1 - x0 - 6) / 6);
      if (fit >= 4) {
        const text = b.label.length > fit ? `${b.label.slice(0, fit - 1)}…` : b.label;
        g += `<text x="${(x0 + x1) / 2}" y="${H - 6}" text-anchor="middle">${esc(text)}<title>${esc(b.label)}</title></text>`;
      }
    });
    const paths = vis.map((s) => {
      const d = smoothPath((s.smooth ? soften(s.values) : s.values).map((v, i) => (v == null ? null : [x(i), y(v)])));
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="5 4"' : ""}/>`;
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

// For trend lines (series with smooth: true): a Gaussian-weighted average of nearby
// points, wider on long series, so the line shows the trend rather than every
// match-to-match wobble. Gaps (null) stay gaps; tooltips still read the raw values.
function soften(vals) {
  const n = vals.length, w = Math.min(6, Math.round(n / 30));
  if (w < 1) return vals;
  const sd = w / 2;
  return vals.map((v, i) => {
    if (v == null) return null;
    let sum = 0, wt = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) {
      if (vals[k] == null) continue;
      const g = Math.exp(-((k - i) ** 2) / (2 * sd * sd));
      sum += g * vals[k]; wt += g;
    }
    return sum / wt;
  });
}

// SVG path through points ([x, y] or null for gaps) as a monotone cubic curve
// (Fritsch–Carlson): smooth, but never bulges past a real data point.
function smoothPath(pts) {
  let d = "";
  const f = (n) => n.toFixed(1);
  for (let i = 0; i < pts.length; ) {
    if (!pts[i]) { i++; continue; }
    const run = [];
    while (i < pts.length && pts[i]) run.push(pts[i++]);
    const n = run.length;
    d += `M${f(run[0][0])},${f(run[0][1])}`;
    if (n < 3) { for (let k = 1; k < n; k++) d += `L${f(run[k][0])},${f(run[k][1])}`; continue; }
    const dx = [], m = [];
    for (let k = 0; k < n - 1; k++) { dx[k] = run[k + 1][0] - run[k][0]; m[k] = (run[k + 1][1] - run[k][1]) / (dx[k] || 1); }
    const t = [m[0]];
    for (let k = 1; k < n - 1; k++) t[k] = m[k - 1] * m[k] <= 0 ? 0 : (3 * (dx[k - 1] + dx[k])) / ((2 * dx[k] + dx[k - 1]) / m[k - 1] + (dx[k] + 2 * dx[k - 1]) / m[k]);
    t[n - 1] = m[n - 2];
    for (let k = 0; k < n - 1; k++) {
      const [x0, y0] = run[k], [x1, y1] = run[k + 1], h = dx[k] / 3;
      d += `C${f(x0 + h)},${f(y0 + t[k] * h)} ${f(x1 - h)},${f(y1 - t[k + 1] * h)} ${f(x1)},${f(y1)}`;
    }
  }
  return d;
}

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

// Save rows as a CSV file. cols: [{ label, get(row) }]
export function downloadCsv(filename, cols, rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [cols.map((c) => cell(c.label)), ...rows.map((r) => cols.map((c) => cell(c.get(r))))].map((l) => l.join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const CSV_ICON = '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5v7.5M3.8 6 7 9.2 10.2 6M2 12.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Sortable table: cols [{ key, label, cls, render(row), sort? }]
export function sortableTable(el, rows, cols, { sortKey, desc = true, pageSize = 100, rowClass = null } = {}) {
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
      `<tr${rowClass?.(r) ? ` class="${rowClass(r)}"` : ""}>${cols.map((c) => `<td class="${c.cls ?? ""} ${c.key === key ? "col-sorted" : ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("");
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
  return {
    setRows(r) { rows = r; shown = pageSize; draw(); },
    // every row (not just the shown page), in the current sort order
    sorted() { return [...rows].sort((a, b) => { const av = a[key], bv = b[key]; if (av == null) return 1; if (bv == null) return -1; return (av > bv ? 1 : av < bv ? -1 : 0) * dir; }); },
  };
}


// ---------- radar chart ----------
// axes: [{ label, value (0-1, the team's season percentile), tip }]. Rings at every 20%.
export function radar(axes, { size = 300, values = true } = {}) {
  const n = axes.length, c = size / 2, R = size / 2 - (values ? 58 : 46);
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [c + Math.cos(a) * r, c + Math.sin(a) * r];
  };
  const poly = (r) => axes.map((_, i) => pt(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");
  const rings = [0.2, 0.4, 0.6, 0.8, 1].map((f) => `<polygon points="${poly(R * f)}" class="rd-ring"/>`).join("");
  const spokes = axes.map((_, i) => { const [x, y] = pt(i, R); return `<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="rd-ring"/>`; }).join("");
  const shape = axes.map((ax, i) => pt(i, R * Math.max(0.03, ax.value)).map((v) => v.toFixed(1)).join(",")).join(" ");
  const dots = axes.map((ax, i) => { const [x, y] = pt(i, R * Math.max(0.03, ax.value)); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" class="rd-dot"><title>${esc(ax.tip)}</title></circle>`; }).join("");
  const labels = axes.map((ax, i) => {
    const [x, y] = pt(i, R + 16);
    const anchor = Math.abs(x - c) < 4 ? "middle" : x > c ? "start" : "end";
    const dy = y < c - R * 0.6 ? -6 : y > c + R * 0.6 ? 12 : 4;
    return `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" class="rd-label">${esc(ax.label)}${values ? `<tspan x="${x.toFixed(1)}" dy="13" class="rd-val">${ax.value == null ? "–" : `top ${Math.max(1, Math.round((1 - ax.value) * 100))}%`}</tspan>` : ""}<title>${esc(ax.tip)}</title></text>`;
  }).join("");
  return `<svg class="radar" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(axes.map((a) => `${a.label}: ${a.tip}`).join("; "))}">
    ${rings}${spokes}<polygon points="${shape}" class="rd-shape"/>${dots}${labels}</svg>`;
}
