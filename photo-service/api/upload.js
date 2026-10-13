// POST /api/upload — body: the image bytes (the site resizes to JPEG first).
// Headers: X-Team (team number), X-Caption (optional), X-Website (honeypot: must be empty).
import { randomUUID } from "node:crypto";
import { cors, imageType, readBody, cleanCaption, pendingList, put, MAX_BYTES, MAX_PENDING } from "../lib/shared.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    // bots fill in hidden fields; people never see this one
    if (req.headers["x-website"]) return res.status(200).json({ ok: true });
    const team = String(req.headers["x-team"] ?? "");
    if (!/^\d{1,6}$/.test(team)) return res.status(400).json({ error: "Enter a valid team number." });
    const caption = cleanCaption(decodeURIComponent(String(req.headers["x-caption"] ?? "")));

    const body = await readBody(req, MAX_BYTES);
    const img = imageType(body);
    if (!img) return res.status(415).json({ error: "That file isn't a JPG, PNG or WebP image." });
    if ((await pendingList()).length >= MAX_PENDING) return res.status(503).json({ error: "Too many photos waiting for review. Try again later." });

    const id = randomUUID();
    const photo = await put(`pending/img/${id}.${img.ext}`, body, { access: "public", contentType: img.type, addRandomSuffix: true });
    await put(`pending/meta/${id}.json`, JSON.stringify({ id, team, caption, url: photo.url, uploaded: new Date().toISOString() }), {
      access: "public", contentType: "application/json", addRandomSuffix: true,
    });
    return res.status(200).json({ ok: true, message: "Thanks! Your photo will appear after review." });
  } catch (e) {
    if (e.status === 413) return res.status(413).json({ error: "Photo is too large (max 4 MB)." });
    console.error(e);
    return res.status(500).json({ error: "Upload failed. Please try again." });
  }
}
