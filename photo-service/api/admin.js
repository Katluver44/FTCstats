// Owner-only review queue. Requires "Authorization: Bearer <ADMIN_TOKEN>"
// (ADMIN_TOKEN is set by the owner in Vercel's environment variables).
//   GET  /api/admin                         -> pending photos
//   POST /api/admin {id, action: approve|reject}
import { cors, isAdmin, pendingList, readIndex, writeIndex, readBody, copy, del } from "../lib/shared.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!isAdmin(req)) return res.status(401).json({ error: "Not authorized" });

  const pending = await pendingList();
  if (req.method === "GET") return res.status(200).json({ pending });
  if (req.method !== "POST") return res.status(405).end();

  const { id, action } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
  const item = pending.find((p) => p.id === id);
  if (!item) return res.status(404).json({ error: "No such pending photo" });

  if (action === "approve") {
    const ext = item.url.split(".").pop().split("?")[0];
    const approved = await copy(item.url, `approved/${item.team}/${item.id}.${ext}`, { access: "public", addRandomSuffix: false });
    const index = await readIndex();
    index[item.team] = [...(index[item.team] ?? []), { id: item.id, url: approved.url, caption: item.caption, added: new Date().toISOString().slice(0, 10) }];
    await writeIndex(index);
  } else if (action !== "reject") {
    return res.status(400).json({ error: "action must be approve or reject" });
  }
  await del([item.url, item.metaUrl]);
  return res.status(200).json({ ok: true });
}
