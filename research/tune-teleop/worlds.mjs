// 2025 Worlds: division-only component OPRs (largest FIRSTChampionship event per team), sorted by teleop,
// vs what epaTargets().worlds holds (last FIRSTChampionship event seen, which can be the finals).
import { ctxs, epaTargets } from "../lib.mjs";
const [c] = await ctxs([2025]);
const { events, worlds } = epaTargets(c);
const cmp = events.filter((e) => e.type === "FIRSTChampionship");
console.log(cmp.map((e) => `${e.code}:${e.pairs.length}`).join(" "));
const div = new Map();
for (const e of [...cmp].sort((a, b) => a.pairs.length - b.pairs.length)) for (const p of e.pairs) div.set(p.team, { ...p, ev: e.code });
const arr = [...div.values()].sort((a, b) => b.teleop - a.teleop);
arr.slice(0, 12).forEach((r, i) => console.log(i + 1, r.team, r.ev, r.teleop.toFixed(1), r.total.toFixed(1)));
for (const t of [11260, 14270, 19564]) console.log("division teleop rank", t, arr.findIndex((r) => r.team === t) + 1, "of", arr.length, "| div teleop", div.get(t).teleop.toFixed(1), "total", div.get(t).total.toFixed(1), "| epaTargets.worlds teleop", worlds.get(t).opr.teleop.toFixed(1), "total", worlds.get(t).opr.total.toFixed(1));
let differ = 0; for (const [t, x] of worlds) if (Math.abs(x.opr.total - div.get(t).total) > 1e-9) differ++;
console.log("teams whose worlds target != division OPR:", differ, "of", worlds.size);
