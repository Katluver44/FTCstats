// Team-list charts: scatter (any two stats), distribution (histogram of one) and
// breakdown (top teams' auto / teleop / endgame as stacked bars). Plain SVG.
import { esc, fmt } from "./ui.js";

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}
// axis range padded a little and snapped to tick steps
function scale(vals, n = 5) {
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const step = niceStep((hi - lo) / n);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}
const quantile = (sorted, q) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))))];

// Redraws on resize; returns nothing. draw(width) fills el.
function responsive(el, draw) {
  el._ro?.disconnect();
  let last = 0;
  const run = () => { const w = el.clientWidth; if (w && w !== last) { last = w; draw(w); } };
  el._ro = new ResizeObserver(run);
  el._ro.observe(el);
  run();
}

// metric: { key, label, get(row), show(value) }
export function scatter(el, rows, { x, y, href, labelTop = 8 }) {
  let pts = rows.map((r) => ({ r, vx: x.get(r), vy: y.get(r) })).filter((p) => Number.isFinite(p.vx) && Number.isFinite(p.vy));
  // a few far-low outliers stretch the axes and push the crowd into the
  // bottom-left corner: leave off the lowest 0.5% on each axis
  if (pts.length > 200) {
    const cut = (vals) => quantile(vals.sort((a, b) => a - b), 0.005);
    const loX = cut(pts.map((p) => p.vx)), loY = cut(pts.map((p) => p.vy));
    pts = pts.filter((p) => p.vx >= loX && p.vy >= loY);
  }
  if (!pts.length) { el.innerHTML = `<div class="empty">Nothing to plot.</div>`; return; }
  // best teams (by EPA) get labels and draw on top
  pts.sort((a, b) => a.r.np - b.r.np);
  const top = new Set(pts.slice(-labelTop).map((p) => p.r.team));
  // a little room around the data (top teams' labels, dots off the axis lines);
  // ticks stay on round numbers inside it
  const padded = (vals, lo0 = 0.12, hi0 = 0.12) => {
    const mn = Math.min(...vals), mx = Math.max(...vals), span = mx - mn || 1;
    const lo = mn - span * lo0, hi = mx + span * hi0;
    return { lo, hi, ticks: scale([lo, hi], 6).ticks.filter((t) => t >= lo && t <= hi) };
  };
  const sx = padded(pts.map((p) => p.vx)), sy = padded(pts.map((p) => p.vy));
  // correlation and least-squares line
  const n = pts.length, mx = pts.reduce((s, p) => s + p.vx, 0) / n, my = pts.reduce((s, p) => s + p.vy, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.vx - mx) * (p.vy - my); sxx += (p.vx - mx) ** 2; syy += (p.vy - my) ** 2; }
  const corr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, slope = sxx ? sxy / sxx : 0;
  const medX = quantile(pts.map((p) => p.vx).sort((a, b) => a - b), 0.5), medY = quantile(pts.map((p) => p.vy).sort((a, b) => a - b), 0.5);

  responsive(el, (W) => {
    const H = Math.round(Math.min(560, Math.max(340, W * 0.5)));
    const P = { l: 58, r: 18, t: 14, b: 50 };
    const X = (v) => P.l + ((v - sx.lo) / (sx.hi - sx.lo)) * (W - P.l - P.r);
    const Y = (v) => P.t + (1 - (v - sy.lo) / (sy.hi - sy.lo)) * (H - P.t - P.b);
    let g = "";
    for (const t of sy.ticks) g += `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${P.l - 8}" y="${Y(t) + 4}" text-anchor="end">${y.show(t, true)}</text>`;
    for (const t of sx.ticks) g += `<line class="grid-line" y1="${P.t}" y2="${H - P.b}" x1="${X(t)}" x2="${X(t)}"/><text x="${X(t)}" y="${H - P.b + 18}" text-anchor="middle">${x.show(t, true)}</text>`;
    g += `<line class="med-line" x1="${X(medX)}" x2="${X(medX)}" y1="${P.t}" y2="${H - P.b}"/><line class="med-line" x1="${P.l}" x2="${W - P.r}" y1="${Y(medY)}" y2="${Y(medY)}"/>`;
    // trend line, clipped to the plot box
    const clipY = (v) => Math.min(sy.hi, Math.max(sy.lo, v));
    const fy = (vx) => my + slope * (vx - mx);
    const xa = sx.lo, xb = sx.hi;
    const inv = (vy) => (slope ? mx + (vy - my) / slope : null);
    const ends = [xa, xb].map((vx) => { const vy = fy(vx); if (vy === clipY(vy)) return [vx, vy]; const vyc = clipY(vy); return [inv(vyc) ?? vx, vyc]; });
    if (corr != null && Math.abs(corr) > 0.1) g += `<line class="fit-line" x1="${X(ends[0][0])}" y1="${Y(ends[0][1])}" x2="${X(ends[1][0])}" y2="${Y(ends[1][1])}"/>`;
    const rr = pts.length > 3000 ? 2.6 : pts.length > 800 ? 3.2 : 4;
    const dots = pts.map((p) => `<circle class="${top.has(p.r.team) ? "dot top" : "dot"}" cx="${X(p.vx).toFixed(1)}" cy="${Y(p.vy).toFixed(1)}" r="${top.has(p.r.team) ? 5 : rr}"/>`).join("");
    // labels: best team first, each in the first spot (right, left, above, below, diagonals)
    // that doesn't cover another label or run off the plot; skipped if none fits
    const boxes = [];
    const labels = pts.filter((p) => top.has(p.r.team)).reverse().map((p) => {
      const cx = X(p.vx), cy = Y(p.vy), w = String(p.r.team).length * 7 + 2, h = 13;
      const spots = [[6, -h - 3], [8, -h / 2], [-w / 2, -h - 7], [-6 - w, -h - 3], [-8 - w, -h / 2], [6, 3], [-w / 2, 7], [-6 - w, 3]];
      for (const [dx, dy] of spots) {
        const b = [cx + dx, cy + dy, cx + dx + w, cy + dy + h];
        if (b[0] < P.l || b[2] > W - P.r || b[1] < P.t || b[3] > H - P.b) continue;
        if (boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
        boxes.push(b);
        return `<text class="dot-label" x="${b[0] + 1}" y="${b[3] - 2}">${p.r.team}</text>`;
      }
      return "";
    }).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}<g>${dots}</g>${labels}
      <circle class="dot-ring" r="8" style="display:none"/>
      <text class="axis-title" x="${(P.l + W - P.r) / 2}" y="${H - 8}" text-anchor="middle">${esc(x.label)}</text>
      <text class="axis-title" transform="translate(14 ${(P.t + H - P.b) / 2}) rotate(-90)" text-anchor="middle">${esc(y.label)}</text>
    </svg><div class="tip"></div>`;
    const svg = el.querySelector("svg"), tip = el.querySelector(".tip"), ring = el.querySelector(".dot-ring");
    const px = pts.map((p) => [X(p.vx), Y(p.vy)]);
    let hit = null;
    svg.onpointermove = (e) => {
      const b = svg.getBoundingClientRect(), k = W / b.width;
      const mx0 = (e.clientX - b.left) * k, my0 = (e.clientY - b.top) * k;
      let best = -1, bd = 14 * 14;
      for (let i = px.length - 1; i >= 0; i--) { const d = (px[i][0] - mx0) ** 2 + (px[i][1] - my0) ** 2; if (d < bd) { bd = d; best = i; } }
      hit = best >= 0 ? pts[best] : null;
      svg.style.cursor = hit ? "pointer" : "";
      if (!hit) { tip.style.display = ring.style.display = "none"; return; }
      ring.setAttribute("cx", px[best][0]); ring.setAttribute("cy", px[best][1]); ring.style.display = "";
      tip.innerHTML = `<b>${hit.r.team}</b> ${esc(hit.r.name)}<br><span class="muted">${esc(x.label)}</span> ${x.show(hit.vx)} · <span class="muted">${esc(y.label)}</span> ${y.show(hit.vy)}`;
      tip.style.display = "block";
      const left = px[best][0] / k, top0 = px[best][1] / k;
      tip.style.left = `${Math.max(4, Math.min(left + 14, b.width - tip.offsetWidth - 4))}px`;
      tip.style.top = `${Math.max(4, top0 - tip.offsetHeight - 10)}px`;
    };
    svg.onpointerleave = () => { hit = null; tip.style.display = ring.style.display = "none"; };
    svg.onclick = () => { if (hit) location.hash = href(hit.r); };
  });
}

export function histogram(el, rows, { m }) {
  const vals = rows.map((r) => m.get(r)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) { el.innerHTML = `<div class="empty">Nothing to plot.</div>`; return; }
  const step = niceStep((vals[vals.length - 1] - vals[0]) / 36 || 1);
  const lo = Math.floor(vals[0] / step) * step;
  const nb = Math.max(1, Math.ceil((vals[vals.length - 1] - lo) / step + 1e-9) || 1);
  const bins = new Array(nb).fill(0);
  for (const v of vals) bins[Math.min(nb - 1, Math.floor((v - lo) / step))]++;
  const hi = lo + nb * step, maxC = Math.max(...bins);
  const sy = scale([0, maxC], 4);
  const marks = [["Median", 0.5], ["Top 10%", 0.9], ["Top 1%", 0.99]].map(([l, q]) => [l, quantile(vals, q)]);

  responsive(el, (W) => {
    const H = Math.round(Math.min(460, Math.max(300, W * 0.38)));
    const P = { l: 52, r: 18, t: 44, b: 50 };
    const X = (v) => P.l + ((v - lo) / (hi - lo)) * (W - P.l - P.r);
    const Y = (c) => P.t + (1 - c / sy.hi) * (H - P.t - P.b);
    let g = "";
    for (const t of sy.ticks) g += `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${P.l - 8}" y="${Y(t) + 4}" text-anchor="end">${t}</text>`;
    const xt = scale([lo, hi], 8).ticks.filter((t) => t >= lo && t <= hi);
    for (const t of xt) g += `<text x="${X(t)}" y="${H - P.b + 18}" text-anchor="middle">${m.show(t, true)}</text>`;
    const bw = X(lo + step) - X(lo);
    const bars = bins.map((c, i) => `<rect class="bar" data-i="${i}" x="${X(lo + i * step) + 1}" y="${Y(c)}" width="${Math.max(1, bw - 2)}" height="${Math.max(0, H - P.b - Y(c))}" rx="2"/>`).join("");
    const mk = marks.map(([l, v], i) => `<line class="mark-line" x1="${X(v)}" x2="${X(v)}" y1="${P.t - 4}" y2="${H - P.b}"/><text class="mark" x="${X(v)}" y="${P.t - 10 - (i % 2) * 16}" text-anchor="middle">${l} ${m.show(v)}</text>`).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}${bars}${mk}
      <line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}"/>
      <text class="axis-title" x="${(P.l + W - P.r) / 2}" y="${H - 8}" text-anchor="middle">${esc(m.label)}</text>
      <text class="axis-title" transform="translate(14 ${(P.t + H - P.b) / 2}) rotate(-90)" text-anchor="middle">Teams</text>
    </svg><div class="tip"></div>`;
    const svg = el.querySelector("svg"), tip = el.querySelector(".tip");
    svg.onpointermove = (e) => {
      const b = e.target.closest?.(".bar");
      el.querySelectorAll(".bar.on").forEach((x) => x.classList.remove("on"));
      if (!b) { tip.style.display = "none"; return; }
      b.classList.add("on");
      const i = +b.dataset.i, c = bins[i];
      tip.innerHTML = `<b>${c.toLocaleString()}</b> team${c === 1 ? "" : "s"}<br><span class="muted">${m.show(lo + i * step)} – ${m.show(lo + (i + 1) * step)}</span>`;
      tip.style.display = "block";
      const r = svg.getBoundingClientRect(), k = W / r.width;
      tip.style.left = `${Math.max(4, Math.min((X(lo + (i + 0.5) * step)) / k - tip.offsetWidth / 2, r.width - tip.offsetWidth - 4))}px`;
      tip.style.top = `${Math.max(4, Y(c) / k - tip.offsetHeight - 8)}px`;
    };
    svg.onpointerleave = () => { tip.style.display = "none"; el.querySelectorAll(".bar.on").forEach((x) => x.classList.remove("on")); };
  });
}

// top teams by EPA, each bar split into auto / teleop / endgame
export function breakdown(el, rows, { season, n = 25 }) {
  const list = [...rows].sort((a, b) => b.np - a.np).slice(0, n);
  if (!list.length) { el.innerHTML = `<div class="empty">Nothing to plot.</div>`; return; }
  el._ro?.disconnect();
  const pos = (v) => Math.max(0, v ?? 0);
  const top = Math.max(1, ...list.map((t) => pos(t.auto) + pos(t.teleop) + pos(t.endgame)));
  const seg = (v, cls) => (v > 0 ? `<i class="${cls}" style="width:${((v / top) * 100).toFixed(2)}%"></i>` : "");
  el.innerHTML = `<div class="pick-list">${list.map((t, i) => `<a class="pl-row" href="#/${season}/team/${t.team}" title="Auto ${fmt(t.auto)} · Teleop ${fmt(t.teleop)} · Endgame ${fmt(t.endgame)}">
      <span class="pl-rank faint">${i + 1}</span>
      <span class="pl-team"><b>${t.team}</b> <span class="muted">${esc(t.name)}</span></span>
      <span class="pl-bar">${seg(t.auto, "auto")}${seg(t.teleop, "teleop")}${seg(t.endgame, "endgame")}</span>
      <b class="pl-epa">${fmt(t.np)}</b>
    </a>`).join("")}</div>`;
}
