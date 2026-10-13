import { ctxs, evaluate } from "./lib.mjs";
const S = [2019, 2021, 2022, 2023, 2024, 2025]; const cs = await ctxs(S);
const F = { winHet: 0.7, winSelf: 0.34, winFoul: 0.2, cal: 1, mom: -0.2, obsHet: 0.75, vObs: 2, v0: 0.5 };
const drop = (keys, extra = {}) => { const p = { ...F, ...extra }; for (const k of keys) delete p[k]; return p; };
const V = [["current", {}], ["full", F], ["- het spread", drop(["winHet"])], ["- recalibration", drop(["cal"])], ["- neg momentum", drop(["mom"])], ["- level obs noise", drop(["obsHet"])], ["- retuned vObs/v0/winSelf/winFoul", drop(["vObs", "v0", "winSelf", "winFoul"])]];
for (const [n, p] of V) { const r = cs.map((c) => evaluate(p, [c])); const m = (f) => r.reduce((s, x) => s + x[f], 0) / r.length; console.log(n.padEnd(36), "mean Brier", m("brier").toFixed(5), "acc", (m("acc") * 100).toFixed(2), "MAE", m("mae").toFixed(2), "|", r.map((x) => x.brier.toFixed(4)).join(" ")); }
