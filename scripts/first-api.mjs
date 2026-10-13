// Client for the official FIRST FTC Events API (https://ftc-events.firstinspires.org/api).
// Credentials come from the environment (GitHub Actions secrets) or a local
// .env file, never from code:  FTC_API_USER=yourusername  FTC_API_KEY=your-key
// The key is never printed.
//
//   node scripts/first-api.mjs check      # verifies the key works

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const BASE = "https://ftc-api.firstinspires.org/v2.0";

function credentials() {
  let { FTC_API_USER: user, FTC_API_KEY: key } = process.env;
  if ((!user || !key) && fs.existsSync(".env")) {
    for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*(FTC_API_USER|FTC_API_KEY)\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m && m[1] === "FTC_API_USER") user ??= m[2];
      if (m && m[1] === "FTC_API_KEY") key ??= m[2];
    }
  }
  if (!user || !key) return null;
  return "Basic " + Buffer.from(`${user}:${key}`).toString("base64");
}

export const hasFirstApi = () => credentials() != null;

// GET a path like "2025/matches/USPACMP"; retries politely on errors and rate limits.
export async function first(pathAndQuery) {
  const auth = credentials();
  if (!auth) throw new Error("FIRST API credentials missing: set FTC_API_USER and FTC_API_KEY");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${pathAndQuery}`, { headers: { Authorization: auth, Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 401) throw new Error("FIRST API rejected the credentials (401)");
    if (res.status === 404) return null;
    if (attempt >= 4) throw new Error(`FIRST API ${res.status} for ${pathAndQuery}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "check") {
  if (!hasFirstApi()) {
    console.log("No credentials found. Add FTC_API_USER and FTC_API_KEY to .env (local) or GitHub secrets (Actions).");
    process.exit(1);
  }
  const s = await first("2025");
  console.log(`FIRST API OK: 2025 season has ${s?.eventCount ?? "?"} events, ${s?.teamCount ?? "?"} teams`);
}
