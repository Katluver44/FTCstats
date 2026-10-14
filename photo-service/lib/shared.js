// Shared helpers for the FTCstats photo service (Vercel Functions + Vercel Blob).
// Uploads go straight to approved/ and the index the site reads; the owner can
// remove any photo on /admin.html.

import { put, list, del, copy } from "@vercel/blob";

export const ALLOWED_ORIGINS = ["https://ftcstats-photos.vercel.app", "https://katluver44.github.io", "http://localhost:5173"];
export const MAX_BYTES = 4 * 1024 * 1024; // the site shrinks photos before upload
export const MAX_PER_TEAM = 20; // a cap per team, so one bad actor can't flood a page

export function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Team, X-Caption, X-Website");
}

// Recognise the image from its bytes, not its name or claimed type.
export function imageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export const cleanCaption = (s) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 140);

// Approved photos, keyed by team number: { "16379": [{ id, url, caption, added }] }
export async function readIndex() {
  const { blobs } = await list({ prefix: "approved/index.json", limit: 1 });
  if (!blobs.length) return {};
  const res = await fetch(`${blobs[0].url}?t=${Date.now()}`, { cache: "no-store" });
  return res.ok ? res.json() : {};
}

export async function writeIndex(index) {
  await put("approved/index.json", JSON.stringify(index), {
    access: "public", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60,
  });
}

export function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(token) && token.length >= 12 && got === token;
}

export { put, list, del, copy };
