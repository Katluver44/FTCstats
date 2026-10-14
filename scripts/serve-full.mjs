// Local copy of the whole Vercel deployment: the static site plus the photo
// service's functions (/api/*) and the short share links (/t, /e, /m), so share
// pages and preview cards can be tried before deploying.
//   node scripts/serve-full.mjs [port]     (needs: cd photo-service && npm install)
// Upload/photo endpoints need the Blob token and won't work locally.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const port = +(process.argv[2] ?? process.env.PORT ?? 3000);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
const REWRITES = [
  [/^\/t\/(\d{4})\/([^/]+)$/, (m) => `/api/share?kind=team&season=${m[1]}&id=${m[2]}`],
  [/^\/e\/(\d{4})\/([^/]+)$/, (m) => `/api/share?kind=event&season=${m[1]}&id=${m[2]}`],
  [/^\/m\/(\d{4})\/([^/]+)\/([^/]+)$/, (m) => `/api/share?kind=match&season=${m[1]}&id=${m[2]}&d=${m[3]}`],
];

// Vercel-style res helpers on a plain Node response
const vres = (res) => Object.assign(res, { status(c) { res.statusCode = c; return res; }, json(o) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); } });

http.createServer(async (req, res) => {
  try {
    let url = new URL(req.url, `http://${req.headers.host}`);
    for (const [re, to] of REWRITES) { const m = url.pathname.match(re); if (m) { url = new URL(to(m), url); break; } }
    if (url.pathname.startsWith("/api/")) {
      const file = path.resolve("photo-service/api", `${path.basename(url.pathname)}.js`);
      const { default: handler } = await import(`${pathToFileURL(file).href}?t=${(await fs.stat(file)).mtimeMs}`);
      req.url = url.pathname + url.search;
      return await handler(req, vres(res));
    }
    let file = path.join("site", decodeURIComponent(url.pathname));
    if (!path.resolve(file).startsWith(path.resolve("site"))) return res.writeHead(403).end();
    if ((await fs.stat(file).catch(() => null))?.isDirectory()) file = path.join(file, "index.html");
    const body = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(body);
  } catch (e) {
    if (e.code === "ENOENT") return res.writeHead(404).end("Not found");
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message));
  }
}).listen(port, () => console.log(`FTCstats (site + functions) on http://localhost:${port}`));
