// Production server for self-hosting (e.g. a home PC behind a Cloudflare Tunnel):
// the static site, the photo service's functions (/api/*) and the short share
// links (/t, /e, /m), with what a home connection needs to hold up under load:
//   - Brotli / gzip, compressed once per file version and kept in memory
//   - Cache-Control like the Vercel deploy, plus ETag / 304 revalidation, so
//     browsers and Cloudflare keep files instead of asking the PC again
//   - rendered preview cards and share pages cached for an hour
//   node scripts/server.mjs [port]          (needs: cd photo-service && npm install)
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const port = +(process.argv[2] ?? process.env.PORT ?? 8080);
const ROOT = path.resolve(process.env.SITE_DIR ?? "site");
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2" };
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".txt"]);
const REWRITES = [
  [/^\/t\/(\d{4})\/([^/]+)$/, (m) => `/api/share?kind=team&season=${m[1]}&id=${m[2]}`],
  [/^\/e\/(\d{4})\/([^/]+)$/, (m) => `/api/share?kind=event&season=${m[1]}&id=${m[2]}`],
  [/^\/m\/(\d{4})\/([^/]+)\/([^/]+)$/, (m) => `/api/share?kind=match&season=${m[1]}&id=${m[2]}&d=${m[3]}`],
];
// past seasons' data only changes when the model does: let browsers and Cloudflare keep it longer
const CURRENT = (() => {
  try { return Math.max(...JSON.parse(readFileSync(path.join(ROOT, "data", "seasons.json"), "utf8"))); } catch { return 0; } // unknown: treat every season as current
})();
const pastSeason = (p) => { const m = p.match(/^\/data\/(\d{4})\//); return m && +m[1] < CURRENT; };
const cacheControl = (p) =>
  pastSeason(p) ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
  : p.startsWith("/data/") ? "public, max-age=300, s-maxage=600, stale-while-revalidate=86400"
  // js/css revalidate every load (cheap 304s via ETag): index.html is never cached, so a
  // cached old app.js could otherwise run against new markup and die at boot ("Loading…" forever)
  : /^\/(js|css)\//.test(p) ? "public, max-age=0, must-revalidate"
  : p.endsWith(".html") || p === "/" ? "public, max-age=0, must-revalidate"
  // fonts never change in place (a new font gets a new file name)
  : p.startsWith("/fonts/") ? "public, max-age=31536000, immutable"
  : "public, max-age=3600";

// small LRU by total bytes
class Lru {
  constructor(maxBytes) { this.max = maxBytes; this.size = 0; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v, bytes) {
    if (this.map.has(k)) { this.size -= this.map.get(k).bytes; this.map.delete(k); }
    this.map.set(k, { ...v, bytes }); this.size += bytes;
    for (const [key, old] of this.map) { if (this.size <= this.max) break; this.map.delete(key); this.size -= old.bytes; }
  }
}
const files = new Lru(400 * 1024 * 1024); // file bodies + their compressed copies
const fnCache = new Lru(150 * 1024 * 1024); // rendered /api/card and share pages

const loading = new Map(); // in-flight loads, so a burst of requests compresses a file once
function loadFile(file, st) {
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  const f = files.get(key);
  if (f) return f;
  if (!loading.has(key)) loading.set(key, readAndCompress(file, st, key).finally(() => loading.delete(key)));
  return loading.get(key);
}
async function readAndCompress(file, st, key) {
  let f;
  {
    const raw = await fs.readFile(file);
    // ETag from the content, so an hourly rebuild that writes the same bytes keeps it (mtime is only the cache key)
    f = { raw, etag: `"${crypto.createHash("sha1").update(raw).digest("base64url").slice(0, 16)}"` };
    if (COMPRESSIBLE.has(path.extname(file)) && raw.length > 1024) {
      [f.br, f.gz] = await Promise.all([brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), gzip(raw, { level: 9 })]);
    }
    files.set(key, f, raw.length + (f.br?.length ?? 0) + (f.gz?.length ?? 0));
  }
  return f;
}

function sendBody(req, res, { raw, br, gz, etag }, type, cache) {
  const ae = String(req.headers["accept-encoding"] ?? "");
  const headers = { "Content-Type": type, "Cache-Control": cache, ETag: etag, Vary: "Accept-Encoding", "X-Content-Type-Options": "nosniff" };
  // Cloudflare turns ETags weak (W/"…") when it compresses, so compare without the W/
  const inm = String(req.headers["if-none-match"] ?? "").split(",").map((s) => s.trim().replace(/^W\//, ""));
  if (inm.includes(etag)) { res.writeHead(304, headers); return res.end(); }
  let body = raw;
  if (br && /\bbr\b/.test(ae)) { body = br; headers["Content-Encoding"] = "br"; }
  else if (gz && /\bgzip\b/.test(ae)) { body = gz; headers["Content-Encoding"] = "gzip"; }
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

// Vercel-style helpers on a plain response, recording what a handler sends so it can be cached
function vres(res, onDone) {
  const sent = { status: 200, headers: {}, chunks: [] };
  return Object.assign(res, {
    status(c) { sent.status = c; res.statusCode = c; return res; },
    setHeader: ((orig) => (k, v) => { sent.headers[k] = v; return orig.call(res, k, v); })(res.setHeader),
    json(o) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); },
    end: ((orig) => (body, ...rest) => { if (body != null) sent.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body))); onDone?.(sent); return orig.call(res, body, ...rest); })(res.end),
  });
}

const handlers = new Map();
async function handler(name) {
  if (!handlers.has(name)) {
    const file = path.resolve("photo-service/api", `${name}.js`);
    await fs.access(file);
    handlers.set(name, (await import(pathToFileURL(file).href)).default);
  }
  return handlers.get(name);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    let url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    for (const [re, to] of REWRITES) { const m = url.pathname.match(re); if (m) { url = new URL(to(m), url); break; } }

    if (url.pathname.startsWith("/api/")) {
      const name = path.basename(url.pathname);
      // card images and share pages are the same for everyone: render once an hour
      const cacheable = req.method === "GET" && (name === "card" || name === "share");
      const key = url.pathname + url.search;
      const hit = cacheable && fnCache.get(key);
      if (hit && Date.now() - hit.at < 3600e3) {
        res.writeHead(hit.status, { ...hit.headers, "X-Cache": "HIT" });
        return res.end(req.method === "HEAD" ? undefined : hit.body);
      }
      const fn = await handler(name).catch(() => null);
      if (!fn) { res.writeHead(404); return res.end("Not found"); }
      req.url = key;
      return await fn(req, vres(res, cacheable ? (s) => {
        const body = Buffer.concat(s.chunks);
        if (s.status === 200) fnCache.set(key, { at: Date.now(), status: 200, headers: s.headers, body }, body.length);
      } : null));
    }

    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
    let rel = decodeURIComponent(url.pathname);
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    let st = await fs.stat(file).catch(() => null);
    if (st?.isDirectory()) { file = path.join(file, "index.html"); rel = path.posix.join(rel, "index.html"); st = await fs.stat(file).catch(() => null); }
    if (!st) {
      // the site probes for data files that may not exist (e.g. videos/<event>.json): let the edge cache the miss
      res.writeHead(404, { "Content-Type": "text/plain", ...(rel.startsWith("/data/") && { "Cache-Control": "public, max-age=300, s-maxage=3600" }) });
      return res.end("Not found");
    }
    sendBody(req, res, await loadFile(file, st), TYPES[path.extname(file)] ?? "application/octet-stream", cacheControl(url.pathname === "/" ? "/" : rel));
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500);
    res.end("Server error");
  } finally {
    if (process.env.LOG) console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms`);
  }
});
server.keepAliveTimeout = 65e3; // longer than Cloudflare's idle timeout
server.headersTimeout = 70e3;
server.requestTimeout = 30e3;
server.listen(port, () => console.log(`FTCstats on http://localhost:${port} (site: ${ROOT})`));
