// GET /t/{season}/{team}, /e/{season}/{event}, /m/{season}/{event}/{match}
// (rewritten here by vercel.json). Link previews can't see past a "#", so a
// shared hash URL always looked the same; this page gives each link its own
// title, description and card image, then sends people on to the real page.
import { describe, cardQuery, esc } from "../lib/share.js";

export default async function handler(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const kind = q.get("kind"), season = q.get("season") ?? "", id = q.get("id") ?? "", d = q.get("d");
  const origin = `${/^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host ?? "") ? "http" : "https"}://${req.headers.host}`;
  let info;
  try {
    info = await describe(origin, kind, season, id, d);
  } catch {
    info = { title: "FTCstats", description: "FTC team ratings, match predictions and ranking forecasts.", hash: "#/", card: null };
  }
  const url = `${origin}/${info.hash}`;
  const img = info.card ? `${origin}/api/card?${cardQuery(kind, season, id, d)}` : null;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(info.title)} · FTCstats</title>
<meta name="description" content="${esc(info.description)}">
<meta property="og:site_name" content="FTCstats">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(info.title)}">
<meta property="og:description" content="${esc(info.description)}">
<meta property="og:url" content="${esc(url)}">
${img ? `<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(img)}">` : ""}
<meta name="twitter:title" content="${esc(info.title)}"><meta name="twitter:description" content="${esc(info.description)}">
<meta name="theme-color" content="#0066b3">
<meta http-equiv="refresh" content="0;url=${esc(url)}">
<script>location.replace(${JSON.stringify(url)})</script>
</head><body><a href="${esc(url)}">${esc(info.title)} on FTCstats</a></body></html>`);
}
