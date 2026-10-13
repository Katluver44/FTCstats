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
    // data changes hourly; code and styles on each deploy
    { source: "/data/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=600" }] },
    { source: "/(js|css)/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
  ],
}, null, 2));
console.log("dist/ ready");
