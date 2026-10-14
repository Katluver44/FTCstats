// POST /api/upload — body: the image bytes (the site resizes to JPEG first).
// Headers: X-Team (team number), X-Caption (optional), X-Website (honeypot: must be empty).
// Photos go live right away; the owner can remove one on /admin.html.
import { randomUUID } from "node:crypto";
import { cors, imageType, readBody, cleanCaption, readIndex, writeIndex, put, MAX_BYTES, MAX_PER_TEAM } from "../lib/shared.js";

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
    if ((await readIndex())[team]?.length >= MAX_PER_TEAM) return res.status(409).json({ error: `Team ${team} already has ${MAX_PER_TEAM} photos.` });

    const id = randomUUID();
    const photo = await put(`approved/${team}/${id}.${img.ext}`, body, { access: "public", contentType: img.type, addRandomSuffix: true });
    // re-read just before writing, so two uploads at once rarely drop each other
    const index = await readIndex();
    const entry = { id, url: photo.url, caption, added: new Date().toISOString().slice(0, 10) };
    index[team] = [...(index[team] ?? []), entry];
    await writeIndex(index);
    return res.status(200).json({ ok: true, message: "Thanks! Your photo is up.", photo: entry });
  } catch (e) {
    if (e.status === 413) return res.status(413).json({ error: "Photo is too large (max 4 MB)." });
    console.error(e);
    return res.status(500).json({ error: "Upload failed. Please try again." });
  }
}
