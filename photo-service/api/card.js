// GET /api/card?kind=team|event|match&season=2025&id=14270[&d=Q-12] -> 1200x630 PNG
//     /api/card?kind=site                                         -> the card for a bare oddbot.org link
// The preview image Discord, iMessage, Instagram etc. show for a shared link.
import { ImageResponse } from "@vercel/og";
import { describe } from "../lib/share.js";

const C = { bg: "#121212", panel: "#1c1c1c", line: "#2e2e2e", text: "#ececec", muted: "#a8a5a6", accent: "#4da3ea", red: "#ff5a5f", blue: "#4da3ea", gold: "#f2c94c",
  auto: "#f59e0b", teleop: "#4da3ea", endgame: "#10b981" };
// tiny element builder (no JSX here): h("div", {style}, ...children)
// Roboto, matching the site (the built-in font has no bold); fetched once per instance
let fonts;
async function loadFonts() {
  if (fonts) return fonts;
  // without a browser user agent, Google Fonts serves plain TTF files, which the renderer reads
  const css = await (await fetch("https://fonts.googleapis.com/css2?family=Roboto:wght@400;700;900&family=Anton")).text();
  const faces = [...css.matchAll(/font-family:\s*'([^']+)';[^}]*?font-weight:\s*(\d+);[^}]*?src:\s*url\(([^)]+)\)/g)].map((m) => [m[1], +m[2], m[3]]);
  fonts = await Promise.all(faces.map(async ([name, weight, url]) => ({ name, weight, style: "normal", data: await (await fetch(url)).arrayBuffer() })));
  return fonts;
}
const h = (type, style, ...children) => ({ type, props: { style: { display: "flex", ...style }, children: children.flat().filter((c) => c != null && c !== false) } });
const fmt = (x, d = 1) => (x == null ? "–" : Number(x).toFixed(d));
const pct = (x) => `${Math.round(x * 100)}%`;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

const logo = (season) => h("div", { justifyContent: "space-between", alignItems: "center", width: "100%" },
  h("div", { alignItems: "center", gap: 14 },
    h("div", { position: "relative", width: 44, height: 44 },
      ...[[3, 31, C.text], [12, 22, C.text], [21, 26, C.text], [29, 14, C.accent], [36, 4, C.accent]].map(([x, y, c], i) =>
        h("div", { position: "absolute", left: x, top: y, width: i === 4 ? 9 : 7, height: i === 4 ? 9 : 7, borderRadius: 9, background: c }))),
    h("div", { fontSize: 34, fontWeight: 800, color: C.text }, "odd", h("span", { fontStyle: "italic", fontWeight: 800 }, "bot"))),
  h("div", { fontSize: 26, color: C.muted }, season));

function teamCard(c) {
  const comp = [["Auto", c.epa.auto, C.auto], ["Teleop", c.epa.teleop, C.teleop], ["Endgame", c.epa.endgame, C.endgame]];
  const top = Math.max(1, ...comp.map(([, v]) => v ?? 0));
  return h("div", { flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "48px 60px", background: C.bg, color: C.text },
    logo(c.season),
    h("div", { flexDirection: "column", gap: 6 },
      h("div", { alignItems: "baseline", gap: 26 },
        h("div", { fontSize: 104, fontWeight: 800, color: C.accent, lineHeight: 1 }, c.num),
        h("div", { fontSize: 60, fontWeight: 700, lineHeight: 1.05 }, clip(c.name, 22))),
      h("div", { fontSize: 28, color: C.muted }, clip(c.loc, 60))),
    h("div", { alignItems: "flex-end", gap: 56 },
      h("div", { flexDirection: "column", padding: "18px 30px", borderRadius: 18, background: C.panel, border: `2px solid ${C.line}` },
        h("div", { fontSize: 24, color: C.muted, letterSpacing: 2 }, "EPA"),
        h("div", { fontSize: 96, fontWeight: 800, lineHeight: 1 }, fmt(c.epa.np))),
      h("div", { flexDirection: "column", gap: 12, width: 660 },
        ...comp.map(([label, v, col]) => h("div", { alignItems: "center", gap: 16 },
          h("div", { width: 120, flexShrink: 0, fontSize: 24, color: C.muted }, label),
          h("div", { width: 410, flexShrink: 0, height: 18, borderRadius: 9, background: C.line },
            h("div", { width: Math.max(8, ((v ?? 0) / top) * 410), height: 18, borderRadius: 9, background: col })),
          h("div", { width: 90, justifyContent: "flex-end", fontSize: 28, fontWeight: 700 }, fmt(v)))),
        h("div", { gap: 22, fontSize: 26, color: C.muted, marginTop: 6 },
          ...c.ranks.map((r) => h("div", { gap: 8 }, h("span", { color: r.rank === 1 ? C.gold : C.text, fontWeight: 700 }, `#${r.rank.toLocaleString()}`), r.label)),
          h("div", {}, `· ${c.record}`)))));
}

function eventCard(c) {
  const chip = (k, v) => h("div", { flexDirection: "column", padding: "14px 24px", borderRadius: 16, background: C.panel, border: `2px solid ${C.line}` },
    h("div", { fontSize: 22, color: C.muted }, k), h("div", { fontSize: 44, fontWeight: 800 }, v));
  return h("div", { flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "48px 60px", background: C.bg, color: C.text },
    logo(c.season),
    h("div", { flexDirection: "column", gap: 12 },
      h("div", { fontSize: 68, fontWeight: 800, lineHeight: 1.05 }, clip(c.name, 40)),
      h("div", { fontSize: 30, color: C.muted }, `${c.when} · ${clip(c.loc, 50)}`)),
    h("div", { alignItems: "flex-end", justifyContent: "space-between" },
      h("div", { gap: 18 }, chip("Teams", String(c.teams)), c.matches ? chip("Matches", c.played < c.matches ? `${c.played}/${c.matches}` : String(c.matches)) : null,
        c.accuracy != null ? chip("Winners called", pct(c.accuracy)) : null),
      c.top.length ? h("div", { flexDirection: "column", alignItems: "flex-end", gap: 4 },
        h("div", { fontSize: 22, color: C.muted }, "Top teams by EPA"),
        ...c.top.map((t) => h("div", { fontSize: 28 }, h("span", { color: C.accent, fontWeight: 800, marginRight: 10 }, String(t.num)), clip(t.name, 24)))) : null));
}

function matchCard(c) {
  const played = c.redScore != null;
  const side = (list, col, align) => h("div", { flexDirection: "column", gap: 10, width: 320, flexShrink: 0, alignItems: align },
    ...list.map((t) => h("div", { flexDirection: "column", alignItems: align },
      h("div", { fontSize: 56, fontWeight: 800, color: col, lineHeight: 1 }, String(t.num)),
      h("div", { fontSize: 24, color: C.muted }, clip(t.name, 22)))));
  const r = c.pRed == null ? 50 : Math.round(c.pRed * 100);
  const fav = c.pRed == null ? null : c.pRed >= 0.5 ? "red" : "blue";
  const mid = played
    ? h("div", { flexDirection: "column", alignItems: "center", gap: 8 },
        h("div", { fontSize: 100, fontWeight: 800, lineHeight: 1 },
          h("span", { color: c.redScore > c.blueScore ? C.red : C.text }, String(c.redScore)), h("span", { color: C.muted, margin: "0 18px" }, "–"),
          h("span", { color: c.blueScore > c.redScore ? C.blue : C.text }, String(c.blueScore))),
        fav ? h("div", { fontSize: 26, color: C.muted }, `${fav === "red" ? "Red" : "Blue"} was favoured ${pct(Math.max(c.pRed, 1 - c.pRed))}`) : null)
    : h("div", { flexDirection: "column", alignItems: "center", gap: 6 },
        h("div", { fontSize: 24, color: C.muted, letterSpacing: 2 }, "TO WIN"),
        h("div", { fontSize: 100, fontWeight: 800, lineHeight: 1, color: fav === "red" ? C.red : C.blue }, fav ? pct(Math.max(c.pRed, 1 - c.pRed)) : "–"),
        c.predRed != null ? h("div", { fontSize: 26, color: C.muted }, `Predicted ${Math.round(c.predRed)}–${Math.round(c.predBlue)}`) : null);
  return h("div", { flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "48px 60px", background: C.bg, color: C.text },
    logo(c.season),
    h("div", { fontSize: 34, color: C.muted }, `${clip(c.event, 44)} · ${c.d}`),
    h("div", { justifyContent: "space-between", alignItems: "center" }, side(c.red, C.red, "flex-start"), mid, side(c.blue, C.blue, "flex-end")),
    h("div", { height: 16, borderRadius: 8, background: C.blue, width: "100%" }, h("div", { width: `${r}%`, height: 16, borderRadius: 8, background: C.red })));
}

// the card for a bare link: the Megamind "no …?" meme with our robot in his place.
// Face fills the frame and runs off the bottom, head tilted, huge white Impact-style
// caption across the top, and the look: worried brows, big wet eyes, a small pout.
// ?v= picks the caption; 1 is what the site link uses.
const SITE_VARIANTS = { 1: "no EPA?", 2: "no match videos?", 3: "no ranking forecasts?", 4: "no predictions?" };
const el = (type, props, ...children) => ({ type, props: { ...props, children: children.flat().filter((c) => c != null && c !== false) } });
function siteCard(v = 1) {
  const text = SITE_VARIANTS[v] ?? SITE_VARIANTS[1];
  const fontSize = Math.min(210, Math.floor(1140 / (0.52 * text.length)));
  const outline = [-6, 6].flatMap((x) => [-6, 6].map((y) => `${x}px ${y}px 0 #000`)).concat(["0 8px 0 #000", "0 -8px 0 #000", "8px 0 0 #000", "-8px 0 0 #000"]).join(", ");
  const B = 760; // the body: a rounded square wider than the eye can take in, cropped by the bottom edge
  const wheel = (left, top) => h("div", { position: "absolute", left, top, width: 110, height: 210, borderRadius: 26, background: "#3a3a3a", alignItems: "center", justifyContent: "center" },
    h("div", { width: 34, height: 160, borderRadius: 17, background: "#555" }));
  // big wet eyes: white, a dark iris, the pupil, and a highlight; both look a little to the right, at you
  const eye = (left) => h("div", { position: "absolute", left, top: 190, width: 200, height: 200, borderRadius: 100, background: "#fff" },
    h("div", { position: "absolute", left: 58, top: 56, width: 118, height: 118, borderRadius: 59, background: "#1d2a3a" }),
    h("div", { position: "absolute", left: 80, top: 78, width: 74, height: 74, borderRadius: 37, background: "#0a0a0a" }),
    h("div", { position: "absolute", left: 86, top: 80, width: 30, height: 30, borderRadius: 15, background: "#fff" }));
  // worried brows (inner ends up) and a small pout, as strokes
  const strokes = el("svg", { width: B, height: B, viewBox: `0 0 ${B} ${B}`, style: { position: "absolute", left: 0, top: 0 } },
    // one brow sits higher than the other: more judgement, less pity
    el("path", { d: "M 92 148 Q 200 62 330 96", stroke: "#111", strokeWidth: 36, strokeLinecap: "round", fill: "none" }),
    el("path", { d: "M 430 152 Q 560 120 668 204", stroke: "#111", strokeWidth: 36, strokeLinecap: "round", fill: "none" }),
    el("path", { d: "M 340 486 Q 405 444 470 480", stroke: "#111", strokeWidth: 28, strokeLinecap: "round", fill: "none" }));
  const body = h("div", { position: "absolute", left: 0, top: 0, width: B, height: B, borderRadius: 110, background: C.accent }, eye(130), eye(430), strokes);
  // the whole robot, tilted like a head cocked at you
  const robot = h("div", { position: "absolute", left: (1200 - B) / 2, top: 104, width: B, height: B, transform: "rotate(-6deg)" },
    wheel(-72, 150), wheel(-72, 430), wheel(B - 38, 150), wheel(B - 38, 430), body);
  const caption = h("div", { position: "absolute", left: 0, width: 1200, top: 12, justifyContent: "center",
    fontFamily: "Anton", fontSize, lineHeight: 1, letterSpacing: 4, textTransform: "uppercase", color: "#fff", textShadow: outline }, text);
  return h("div", { position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "#0f0f10" }, robot, caption);
}

export default async function handler(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  try {
    if (q.get("kind") === "site") {
      const img = new ImageResponse(h("div", { width: "100%", height: "100%", fontFamily: "Roboto" }, siteCard(+(q.get("v") ?? 1))), { width: 1200, height: 630, fonts: await loadFonts().catch(() => undefined) });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800");
      return res.status(200).end(Buffer.from(await img.arrayBuffer()));
    }
    const info = await describe(`${/^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host ?? "") ? "http" : "https"}://${req.headers.host}`, q.get("kind"), q.get("season") ?? "", q.get("id") ?? "", q.get("d"));
    const c = info.card;
    const tree = c.kind === "team" ? teamCard(c) : c.kind === "event" ? eventCard(c) : matchCard(c);
    const img = new ImageResponse(h("div", { width: "100%", height: "100%", fontFamily: "Roboto" }, tree), { width: 1200, height: 630, fonts: await loadFonts().catch(() => undefined) });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).end(Buffer.from(await img.arrayBuffer()));
  } catch (e) {
    return res.status(e.status ?? 500).end(String(e.message ?? "error"));
  }
}
