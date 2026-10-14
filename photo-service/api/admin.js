// Owner-only photo list. Requires "Authorization: Bearer <ADMIN_TOKEN>"
// (ADMIN_TOKEN is set by the owner in Vercel's environment variables).
//   GET  /api/admin                       -> every live photo
//   POST /api/admin {team, id, action: "remove"}
import { cors, isAdmin, readIndex, writeIndex, readBody, del } from "../lib/shared.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!isAdmin(req)) return res.status(401).json({ error: "Not authorized" });

  const index = await readIndex();
  if (req.method === "GET") {
    const photos = Object.entries(index).flatMap(([team, list]) => list.map((p) => ({ ...p, team })))
      .sort((a, b) => (b.added ?? "").localeCompare(a.added ?? ""));
    return res.status(200).json({ photos });
  }
  if (req.method !== "POST") return res.status(405).end();

  const { team, id, action } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
  if (action !== "remove") return res.status(400).json({ error: "action must be remove" });
  const item = index[team]?.find((p) => p.id === id);
  if (!item) return res.status(404).json({ error: "No such photo" });
  index[team] = index[team].filter((p) => p.id !== id);
  if (!index[team].length) delete index[team];
  await writeIndex(index);
  await del(item.url).catch(() => {});
  return res.status(200).json({ ok: true });
}
