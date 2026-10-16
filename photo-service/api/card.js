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
    h("div", { fontSize: 34, fontWeight: 800, color: C.text }, "odd", h("span", { fontStyle: "italic", fontWeight: 800 }, "robot"))),
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

// the card for a bare link: our robot, head-on, doing the Megamind meme.
// ?v= picks a variant (caption, where it sits, the face); 1 is what the site uses.
const SITE_VARIANTS = {
  1: { text: "no EPA?", at: "top", face: "sideeye" },
  2: { text: "no EPA?", at: "bottom", face: "sideeye" },
  3: { text: "no match videos?", at: "top", face: "sideeye" },
  4: { text: "no EPA?", at: "top", face: "squint" },
  5: { text: "no ranking forecasts?", at: "bottom", face: "squint" },
};
const FACES = {
  // lids = how much of each eye the lid covers; pupilX = where the pupil looks
  sideeye: { lids: [40, 70], pupilX: 74, brows: [[86, 135, 14], [316, 107, -6]], mouth: { left: 230, top: 400, width: 180, rot: -8 } },
  squint: { lids: [76, 76], pupilX: 40, brows: [[86, 128, 16], [316, 128, -16]], mouth: { left: 180, top: 420, width: 180, rot: 0 } },
};
function siteCard(v = 1) {
  const { text, at, face } = SITE_VARIANTS[v] ?? SITE_VARIANTS[1];
  const f = FACES[face];
  const fontSize = Math.min(170, Math.floor(1120 / (0.52 * text.length)));
  const outline = [-5, 5].flatMap((x) => [-5, 5].map((y) => `${x}px ${y}px 0 #000`)).concat(["0 7px 0 #000", "0 -7px 0 #000", "7px 0 0 #000", "-7px 0 0 #000"]).join(", ");
  const B = 540, bx = (1200 - B) / 2, by = 60; // body: a 540px square, head-on
  // wheels poke out past the body: a dark tyre with a lighter tread stripe, so they read on the dark card
  const wheel = (left, top) => h("div", { position: "absolute", left, top, width: 84, height: 150, borderRadius: 20, background: "#3a3a3a", alignItems: "center", justifyContent: "center" },
    h("div", { width: 26, height: 110, borderRadius: 13, background: "#555" }));
  // eye: white circle, pupil, then a bigger accent circle shifted up as the lid (curved, and
  // accent-on-accent outside the eye, so nothing clips)
  const eye = (left, lid) => h("div", { position: "absolute", left, top: 185, width: 140, height: 140 },
    h("div", { position: "absolute", left: 0, top: 0, width: 140, height: 140, borderRadius: 70, background: "#fff" }),
    h("div", { position: "absolute", left: f.pupilX, top: 56, width: 60, height: 60, borderRadius: 30, background: "#111" }),
    h("div", { position: "absolute", left: -18, top: lid - 178, width: 178, height: 178, borderRadius: 89, background: C.accent }));
  const brow = ([left, top, angle]) => h("div", { position: "absolute", left, top, width: 160, height: 24, borderRadius: 12, background: "#111", transform: `rotate(${angle}deg)` });
  const body = h("div", { position: "absolute", left: bx, top: by, width: B, height: B, borderRadius: 72, background: C.accent },
    eye(92, f.lids[0]), eye(308, f.lids[1]),
    ...f.brows.map(brow), // after the eyes, so the lids don't paint over them
    h("div", { position: "absolute", left: f.mouth.left, top: f.mouth.top, width: f.mouth.width, height: 22, borderRadius: 11, background: "#111", transform: `rotate(${f.mouth.rot}deg)` }));
  const caption = h("div", { position: "absolute", left: 0, width: 1200, top: at === "top" ? 14 : 630 - fontSize - 24, justifyContent: "center",
    fontFamily: "Anton", fontSize, lineHeight: 1, letterSpacing: 2, textTransform: "uppercase", color: "#fff", textShadow: outline }, text);
  return h("div", { position: "relative", width: "100%", height: "100%", background: C.bg },
    wheel(bx - 66, by + 80), wheel(bx - 66, by + 300), wheel(bx + B - 18, by + 80), wheel(bx + B - 18, by + 300),
    body, caption);
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
