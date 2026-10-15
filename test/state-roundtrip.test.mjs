// Team state shipped to the browser (Model.epa() -> setTeam) must carry the
// partner-covariance map, so a live replay predicts exactly like the build.
import test from "node:test";
import assert from "node:assert/strict";
import { Model } from "../site/js/model.js";

const PARAMS = { covBlend: 0.4, covDecay: 0.15, covEvent: 0.2, covMax: 4, oprBlend: 0.2, oprVThr: 0.2, oprRidge: 1 };
const baseline = { auto: 20, teleop: 40, endgame: 10, foul: 5, rp: [0.3, 0.3, 0.3], solo: [] };
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const sc = (m) => { const auto = Math.max(0, m + 6 * (rnd() - 0.5)), teleop = Math.max(0, 2 * m + 12 * (rnd() - 0.5)), endgame = 5 * rnd(), np = auto + teleop + endgame; return { auto, teleop, endgame, np, total: np + 3, rp: [rnd() < 0.3, rnd() < 0.3, rnd() < 0.3] }; };
const teamsOf = (e) => Array.from({ length: 24 }, (_, i) => 100 + e * 10 + i);
function events() { // 4 events, teams overlap so partner links cross events
  const out = [];
  for (let e = 0; e < 4; e++) {
    const T = teamsOf(e).map((t) => (t % 7 === 0 ? t - 40 : t)), ms = [];
    for (let r = 0; r < 60; r++) { const s = T.slice().sort(() => rnd() - 0.5); ms.push([s.slice(0, 2), s.slice(2, 4), { red: sc(1), blue: sc(1) }]); }
    out.push({ code: "E" + e, ms });
  }
  return out;
}
const fresh = (src, params = PARAMS) => new Model({ params, baseline: { ...baseline, ...src.avg, rp: [...src.avg.rp], solo: [] } });
const ship = (m, nums, rounded) => { // what build.mjs writes, as JSON
  const o = JSON.parse(JSON.stringify(nums.map((n) => [n, m.epa(n)])));
  if (rounded) for (const [, s] of o) if (s.cov) s.cov = s.cov.map((x, i) => (i & 1 ? Math.round(x * 1000) / 1000 : x));
  return o;
};
function restore(src, shipped, params = PARAMS) {
  const f = fresh(src, params);
  f.cal = structuredClone(src.cal); f.errVar = { ...src.errVar };
  for (const [n, s] of shipped) f.setTeam(n, s);
  return f;
}
const play = (m, ev, from, to, out) => {
  for (const [r, b, actual] of ev.ms.slice(from, to)) {
    const pre = m.update(r, b, actual, false, ev.code);
    out?.push(pre.pRed);
  }
};

test("cov survives the event-start round trip (the shipped path), 1e-9", () => {
  const evs = events(), m = new Model({ params: PARAMS, baseline });
  evs.slice(0, 3).forEach((ev) => play(m, ev, 0, 60));
  const all = [...new Set(evs[3].ms.flat(2))];
  assert.ok(all.some((n) => m.epa(n).cov?.length), "covariances exist");
  assert.ok(all.every((n) => (m.epa(n).cov?.length ?? 0) <= 2 * PARAMS.covMax));
  const g = restore(m, ship(m, all)), a = [], b = [];
  play(m, evs[3], 0, 60, a); play(g, evs[3], 0, 60, b);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-9, `match ${i}: ${x} vs ${b[i]}`));
});

test("mid-event snapshot (cov on, OPR rows rebuilt not shipped) predicts next matches to 1e-9", () => {
  const evs = events(), p2 = { ...PARAMS, oprBlend: 0 }, m = new Model({ params: p2, baseline });
  evs.slice(0, 2).forEach((ev) => { play(m, ev, 0, 60); });
  play(m, evs[2], 0, 30);
  const all = [...new Set(evs[2].ms.flat(2))];
  const f = restore(m, ship(m, all), p2);
  const a = [], b = [];
  play(m, evs[2], 30, 60, a); play(f, evs[2], 30, 60, b);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-9, `match ${i}`));
});

test("3-decimal rounding of the shipped cov keeps predictions close", () => {
  const evs = events(), m = new Model({ params: PARAMS, baseline });
  evs.slice(0, 3).forEach((ev) => play(m, ev, 0, 60));
  const all = [...new Set(evs[3].ms.flat(2))], g = restore(m, ship(m, all, true)), a = [], b = [];
  play(m, evs[3], 0, 60, a); play(g, evs[3], 0, 60, b);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-4));
});

test("without the cov field the replay differs (guards the test itself)", () => {
  const evs = events(), m = new Model({ params: PARAMS, baseline });
  evs.slice(0, 3).forEach((ev) => play(m, ev, 0, 60));
  const all = [...new Set(evs[3].ms.flat(2))], sh = ship(m, all);
  for (const [, s] of sh) delete s.cov;
  const g = restore(m, sh), a = [], b = [];
  play(m, evs[3], 0, 60, a); play(g, evs[3], 0, 60, b);
  assert.ok(a.some((x, i) => Math.abs(x - b[i]) > 1e-6));
});
