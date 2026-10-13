// GET /api/photos — approved photos for every team, cached briefly at the edge.
import { cors, readIndex } from "../lib/shared.js";

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res.status(200).json(await readIndex());
}
