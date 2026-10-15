// Assembles one Vercel deployment: the static site (site/) at the root plus the
// photo service's functions (photo-service/api) and its review page.
//   node scripts/package-vercel.mjs   ->  dist/
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const out = "dist";
await fs.rm(out, { recursive: true, force: true });
await fs.cp("site", out, { recursive: true });
for (const p of ["api", "lib", "package.json"]) await fs.cp(path.join("photo-service", p), path.join(out, p), { recursive: true });
await fs.cp(path.join("photo-service", "public", "admin.html"), path.join(out, "admin.html"));
// Stamp every script and stylesheet URL with this deploy's version, so a browser
// holding cached files from the last deploy never mixes old and new modules.
const code = (await fs.readdir(path.join(out, "js"))).filter((f) => f.endsWith(".js"));
const hash = crypto.createHash("sha256");
for (const f of [...code.map((f) => path.join("js", f)), path.join("css", "style.css")]) hash.update(await fs.readFile(path.join(out, f)));
const v = hash.digest("hex").slice(0, 10);
const stamp = (text) => text.replace(/((?:from|import)\s*["']\.\/[\w-]+\.js)(["'])/g, `$1?v=${v}$2`);
for (const f of code) {
  const file = path.join(out, "js", f);
  await fs.writeFile(file, stamp(await fs.readFile(file, "utf8")));
}
const index = path.join(out, "index.html");
await fs.writeFile(index, (await fs.readFile(index, "utf8")).replace(/((?:href|src)="(?:js\/[\w-]+\.js|css\/style\.css))"/g, `$1?v=${v}"`));

await fs.writeFile(path.join(out, "vercel.json"), JSON.stringify({
  // one canonical host: www.oddbot.org sends every path to oddbot.org. 308 keeps the method,
  // and the browser carries the #/... route across the redirect on its own.
  redirects: [
    { source: "/:path*", has: [{ type: "host", value: "www.oddbot.org" }], destination: "https://oddbot.org/:path*", permanent: true },
  ],
  // short share links with their own preview card (photo-service/api/share.js)
  rewrites: [
    { source: "/t/:season/:id", destination: "/api/share?kind=team&season=:season&id=:id" },
    { source: "/e/:season/:id", destination: "/api/share?kind=event&season=:season&id=:id" },
    { source: "/m/:season/:id/:d", destination: "/api/share?kind=match&season=:season&id=:id&d=:d" },
  ],
  headers: [
    { source: "/admin.html", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
    // Vercel's CDN keeps each deployment's own cache and starts fresh on every deploy,
    // so the edge can hold files until the next deploy (s-maxage of a year); browsers
    // reuse data for 5 minutes and serve a stale copy instantly while refetching.
    { source: "/data/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=31536000, stale-while-revalidate=86400" }] },
    // code: the page asks for every script and stylesheet with this deploy's ?v= stamp,
    // so a stamped URL never changes and browsers can keep it for good
    { source: "/(js|css)/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=31536000, stale-while-revalidate=86400" }] },
    { source: "/(js|css)/(.*)", has: [{ type: "query", key: "v" }], headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    // team photos and match-video lists change rarely
    { source: "/(photos|videos)/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=3600, s-maxage=31536000, stale-while-revalidate=604800" }] },
  ],
}, null, 2));
console.log("dist/ ready");
