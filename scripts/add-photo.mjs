// Runs in GitHub Actions when the repo owner labels a photo issue "approved".
// Reads the issue from the event payload (untrusted text: parsed, never run),
// downloads the attached image from GitHub's upload server, checks it really
// is an image, saves it under site/photos/<team>/, and records it in
// site/photos/index.json. Prints the team number for the workflow.

import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_HOSTS = ["github.com", "user-images.githubusercontent.com", "private-user-images.githubusercontent.com"];

const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
const issue = event.issue;
const body = issue.body ?? "";

// Issue forms render as "### Label\n\nvalue" sections
const section = (label) => {
  const m = body.match(new RegExp(`### ${label}\\s*\\n+([\\s\\S]*?)(?=\\n### |$)`));
  return m ? m[1].trim() : "";
};
const team = section("Team number").replace(/\D/g, "");
if (!/^\d{1,6}$/.test(team)) throw new Error(`No valid team number in the issue (${JSON.stringify(section("Team number"))})`);
let caption = section("Caption \\(optional\\)");
if (caption === "_No response_") caption = "";
caption = caption.replace(/[<>]/g, "").slice(0, 140);

const photoText = section("Photo");
const url = (photoText.match(/https:\/\/[^\s)"'<>]+/g) ?? []).find((u) => {
  try {
    const h = new URL(u).hostname;
    return ALLOWED_HOSTS.includes(h) && (h !== "github.com" || new URL(u).pathname.startsWith("/user-attachments/"));
  } catch { return false; }
});
if (!url) throw new Error("No image uploaded to GitHub found in the Photo field");

const res = await fetch(url, { redirect: "follow" });
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length > MAX_BYTES) throw new Error(`Image too large (${buf.length} bytes)`);

// trust the file's bytes, not its name
const ext = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg"
  : buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "png"
  : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP" ? "webp"
  : null;
if (!ext) throw new Error("Attachment isn't a JPG, PNG or WebP image");

const dir = path.join("site", "photos", team);
await fs.mkdir(dir, { recursive: true });
const file = `${issue.number}.${ext}`;
await fs.writeFile(path.join(dir, file), buf);

const indexFile = path.join("site", "photos", "index.json");
const index = JSON.parse(await fs.readFile(indexFile, "utf8").catch(() => "{}"));
index[team] = (index[team] ?? []).filter((p) => p.issue !== issue.number);
index[team].push({ file: `photos/${team}/${file}`, caption, credit: issue.user.login, issue: issue.number, added: new Date().toISOString().slice(0, 10) });
await fs.writeFile(indexFile, JSON.stringify(index, null, 1) + "\n");

console.log(team);
