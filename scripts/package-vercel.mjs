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
  headers: [
    { source: "/admin.html", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
    // Browsers reuse files for 5 minutes, and serve a stale copy instantly while
    // fetching a fresh one in the background, instead of checking every file on
    // every visit. Data changes hourly; code at most every deploy.
    { source: "/data/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=600, stale-while-revalidate=86400" }] },
    { source: "/(js|css)/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" }] },
  ],
}, null, 2));
console.log("dist/ ready");
