// Assembles one Vercel deployment: the static site (site/) at the root plus the
// photo service's functions (photo-service/api) and its review page.
//   node scripts/package-vercel.mjs   ->  dist/
import fs from "node:fs/promises";
import path from "node:path";

const out = "dist";
await fs.rm(out, { recursive: true, force: true });
await fs.cp("site", out, { recursive: true });
for (const p of ["api", "lib", "package.json"]) await fs.cp(path.join("photo-service", p), path.join(out, p), { recursive: true });
await fs.cp(path.join("photo-service", "public", "admin.html"), path.join(out, "admin.html"));
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
