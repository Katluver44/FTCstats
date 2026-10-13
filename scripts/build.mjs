// Replays a season's matches in time order through the EPA model and writes
// static JSON for the site into site/data/<season>/.
//
//   node scripts/build.mjs 2025

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEASONS } from "../site/js/seasons.js";
import { Model, COMPONENTS, onField, isElim } from "../site/js/model.js";
import { oprPredictions } from "./opr.mjs";

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

export async function loadSeason(season) {
  const dir = path.join(".cache", String(season));
  const files = await fs.readdir(dir).catch(() => []);
  const events = [];
  for (const f of files) {
    const ev = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
    if (!ev.remote) events.push(ev);
  }
  return events;
}

function matchTime(ev, m) {
  const t = m.actualStartTime ?? m.scheduledStartTime;
  if (t) return Date.parse(t);
  // no timestamps: order by event start, then match id
  return Date.parse(`${ev.start}T12:00:00Z`) + m.id * 1000;
}

// Flattened, time-sorted list of played matches with usable scores.
export function playedMatches(season, events) {
  const read = SEASONS[season].read;
  const out = [];
  for (const ev of events) {
    for (const m of ev.matches) {
      if (!m.hasBeenPlayed || !m.scores?.red) continue;
      const red = onField(m, "Red"), blue = onField(m, "Blue");
      if (!red.length || !blue.length) continue;
      out.push({
        ev, m, red, blue, elim: isElim(m), time: matchTime(ev, m),
        actual: { red: read(m.scores.red), blue: read(m.scores.blue) },
      });
    }
  }
  return out.sort((a, b) => a.time - b.time || a.m.id - b.m.id);
}

export function baselineOf(matches) {
  const first = matches.slice(0, 400);
  const b = { auto: 0, teleop: 0, endgame: 0, foul: 0, rp: [0, 0, 0] };
  let n = 0;
  for (const { actual, elim } of first) {
    for (const a of [actual.red, actual.blue]) {
      for (const c of COMPONENTS) b[c] += a[c];
      b.foul += a.total - a.np;
      if (!elim) a.rp.forEach((x, i) => (b.rp[i] += x ? 1 : 0));
      n++;
    }
  }
  for (const c of [...COMPONENTS, "foul"]) b[c] /= n || 1;
  b.rp = b.rp.map((x) => x / (n || 1));
  return b;
}

// Last season's final EPAs as z-scores, to seed this season.
export async function loadPriors(season) {
  const file = path.join("site", "data", String(season - 1), "teams.json");
  const prev = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
  if (!prev) return { priors: new Map(), cv: 0.5 };
  const rows = prev.rows.filter((r) => r[prev.cols.indexOf("matches")] >= 5);
  const npI = prev.cols.indexOf("np");
  const vals = rows.map((r) => r[npI]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const priors = new Map(rows.map((r) => [r[0], Math.max(-2.5, Math.min(2.5, (r[npI] - mean) / sd))]));
  return { priors, cv: sd / mean };
}

// Runs the model and scores its pre-match predictions.
export function simulate(matches, { params, baseline, priors, cv }, onMatch) {
  const model = new Model({ params, baseline, priors, cv });
  const acc = newAcc();
  for (const x of matches) {
    const before = onMatch ? new Map([...x.red, ...x.blue].map((t) => [t, model.epa(t)])) : null;
    const pre = model.update(x.red, x.blue, x.actual, x.elim, x.ev.code);
    score(acc, x, pre);
    onMatch?.(x, pre, model, before);
  }
  return { model, acc };
}

function newAcc() {
  const g = () => ({ n: 0, correct: 0, brier: 0, mae: 0, rpN: 0, rpBrier: 0 });
  return { all: g(), quals: g(), elims: g(), champs: g(), calib: Array.from({ length: 10 }, () => [0, 0]) };
}

function score(acc, x, pre) {
  const { red, blue } = x.actual;
  const outcome = red.total === blue.total ? 0.5 : red.total > blue.total ? 1 : 0;
  // calibration, from the favourite's point of view
  const fav = pre.pRed >= 0.5 ? pre.pRed : 1 - pre.pRed;
  const favWon = pre.pRed >= 0.5 ? outcome : 1 - outcome;
  const bin = acc.calib[Math.min(9, Math.floor(fav * 10))];
  bin[0]++; bin[1] += favWon;
  const groups = [acc.all, x.elim ? acc.elims : acc.quals];
  if (/Championship/.test(x.ev.type)) groups.push(acc.champs);
  for (const g of groups) {
    g.n++;
    if (outcome !== 0.5 && (pre.pRed > 0.5) === (outcome === 1)) g.correct++;
    g.brier += (pre.pRed - outcome) ** 2;
    g.mae += (Math.abs(pre.red.np - red.np) + Math.abs(pre.blue.np - blue.np)) / 2;
    if (!x.elim) {
      for (const side of ["red", "blue"]) {
        pre[side].rp.forEach((p, i) => {
          g.rpBrier += (p - (x.actual[side].rp[i] ? 1 : 0)) ** 2;
          g.rpN++;
        });
      }
    }
  }
}

export function summarize(acc) {
  const out = {};
  for (const [k, g] of Object.entries(acc)) {
    if (k === "calib") {
      out.calib = g.map(([n, w], i) => ({ bin: i / 10, n, winRate: n ? r3(w / n) : null })).filter((b) => b.n);
      continue;
    }
    if (!g.n) continue;
    out[k] = {
      matches: g.n,
      accuracy: r3(g.correct / g.n),
      brier: r3(g.brier / g.n),
      scoreMae: r1(g.mae / g.n),
      rpBrier: g.rpN ? r3(g.rpBrier / g.rpN) : null,
    };
  }
  return out;
}

const epaRow = (e) => ({
  np: r1(e.np), auto: r1(e.auto), teleop: r1(e.teleop), endgame: r1(e.endgame),
  rp: e.rp.map(r3),
});

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}

export async function build(season, params = {}) {
  const cfg = SEASONS[season];
  const hasRp = cfg.rpNames.length > 0;
  const events = await loadSeason(season);
  const matches = playedMatches(season, events);
  const baseline = baselineOf(matches);
  const { priors, cv } = await loadPriors(season);

  const history = new Map(); // team -> [entries]
  const eventStart = new Map(); // `${code}:${team}` -> epa before first match there
  const predByMatch = new Map(); // `${code}:${id}` -> pre-match prediction

  const { model, acc } = simulate(matches, { params, baseline, priors, cv }, (x, pre, model, before) => {
    predByMatch.set(`${x.ev.code}:${x.m.id}`, pre);
    for (const [side, mine, theirs] of [["red", x.red, x.blue], ["blue", x.blue, x.red]]) {
      const pWin = side === "red" ? pre.pRed : 1 - pre.pRed;
      for (const t of mine) {
        const key = `${x.ev.code}:${t}`;
        if (!eventStart.has(key)) eventStart.set(key, before.get(t));
        const e = model.epa(t);
        if (!history.has(t)) history.set(t, []);
        history.get(t).push({
          ev: x.ev.code, m: x.m.description, elim: x.elim, time: x.time,
          side, partners: mine.filter((n) => n !== t), opps: theirs,
          pWin: r3(pWin), score: x.actual[side].total, oppScore: x.actual[side === "red" ? "blue" : "red"].total,
          pred: [r1(pre[side].total), r1(pre[side === "red" ? "blue" : "red"].total)],
          // bonus RPs: [predicted chance >50%, earned] per RP, for the dot display
          rp: x.elim || !hasRp ? null : pre[side].rp.map((p, i) => (p > 0.5 ? 1 : 0) + (x.actual[side].rp[i] ? 2 : 0)),
          orp: x.elim || !hasRp ? null : pre[side === "red" ? "blue" : "red"].rp.map((p, i) => (p > 0.5 ? 1 : 0) + (x.actual[side === "red" ? "blue" : "red"].rp[i] ? 2 : 0)),
          epa: [r1(e.np), r1(e.auto), r1(e.teleop), r1(e.endgame)],
        });
      }
    }
  });

  // ---- head-to-head with OPR, and accuracy over the season ----
  const opr = oprPredictions(matches, { winScale: model.p.winScale, baselineTeam: (baseline.auto + baseline.teleop + baseline.endgame) / 2 });
  const outcome = (x) => (x.actual.red.total === x.actual.blue.total ? 0.5 : x.actual.red.total > x.actual.blue.total ? 1 : 0);
  const cmp = { epa: { c: 0, b: 0 }, opr: { c: 0, b: 0 }, n: 0 };
  const months = new Map();
  for (const x of matches) {
    const o = outcome(x), pe = predByMatch.get(`${x.ev.code}:${x.m.id}`).pRed, po = opr.get(x).pRed;
    cmp.n++;
    for (const [k, p] of [["epa", pe], ["opr", po]]) {
      cmp[k].b += (p - o) ** 2;
      if (o !== 0.5 && (p > 0.5) === (o === 1)) cmp[k].c++;
    }
    const key = new Date(x.time).toISOString().slice(0, 7);
    if (!months.has(key)) months.set(key, { n: 0, c: 0, o: 0 });
    const mo = months.get(key);
    mo.n++;
    if (o !== 0.5 && (pe > 0.5) === (o === 1)) mo.c++;
    if (o !== 0.5 && (po > 0.5) === (o === 1)) mo.o++;
  }
  const compare = {
    epa: { accuracy: r3(cmp.epa.c / cmp.n), brier: r3(cmp.epa.b / cmp.n) },
    opr: { accuracy: r3(cmp.opr.c / cmp.n), brier: r3(cmp.opr.b / cmp.n) },
    byMonth: [...months].filter(([, m]) => m.n >= 200).map(([month, m]) => ({ month, matches: m.n, epa: r3(m.c / m.n), opr: r3(m.o / m.n) })),
  };

  const out = path.join("site", "data", String(season));
  await fs.rm(out, { recursive: true, force: true });

  // ---- team info gathered from event rosters ----
  const info = new Map();
  const teamEvents = new Map();
  const byStart = [...events].sort((a, b) => a.start.localeCompare(b.start));
  for (const ev of byStart) {
    for (const tp of ev.teams) {
      const loc = tp.team?.location;
      info.set(tp.teamNumber, {
        name: tp.team?.name ?? "",
        loc: loc ? [loc.city, loc.state, loc.country].filter(Boolean).join(", ") : "",
        country: loc?.country ?? "",
        rookie: tp.team?.rookieYear ?? null,
      });
      if (!teamEvents.has(tp.teamNumber)) teamEvents.set(tp.teamNumber, []);
      teamEvents.get(tp.teamNumber).push({ ev, stats: tp.stats });
    }
  }

  // ---- teams.json: compact table of every team that played ----
  const ranked = [...history.keys()]
    .map((t) => ({ t, e: model.epa(t), h: history.get(t) }))
    .sort((a, b) => b.e.np - a.e.np);
  const cols = ["team", "name", "loc", "country", "np", "auto", "teleop", "endgame", "rp0", "rp1", "rp2",
    "matches", "wins", "losses", "ties", "events", "trend", "foul"];
  const rows = ranked.map(({ t, e, h }) => {
    let w = 0, l = 0, ti = 0;
    for (const x of h) x.score > x.oppScore ? w++ : x.score < x.oppScore ? l++ : ti++;
    const i = info.get(t) ?? {};
    const evs = new Set(h.map((x) => x.ev)).size;
    // EPA change over the last 10 matches
    const prev = h.length > 10 ? h[h.length - 11].epa[0] : h[0].epa[0];
    return [t, i.name ?? "", i.loc ?? "", i.country ?? "", r1(e.np), r1(e.auto), r1(e.teleop), r1(e.endgame),
      ...e.rp.map(r3), h.length, w, l, ti, evs, r1(e.np - prev), r1(e.foul)];
  });
  await writeJson(path.join(out, "teams.json"), { cols, rows });

  // ---- per-team files, bundled 100 teams to a file (team/<number / 100>.json) ----
  const rankOf = new Map(ranked.map((x, i) => [x.t, i + 1]));
  const buckets = new Map();
  for (const { t, e, h } of ranked) {
    const evs = (teamEvents.get(t) ?? []).map(({ ev, stats }) => {
      const mine = h.filter((x) => x.ev === ev.code);
      const startEpa = eventStart.get(`${ev.code}:${t}`);
      return {
        code: ev.code, name: ev.name, type: ev.type, start: ev.start,
        rank: stats?.rank ?? null, wins: stats?.wins ?? null, losses: stats?.losses ?? null, ties: stats?.ties ?? null,
        epaStart: startEpa ? r1(startEpa.np) : null,
        epaEnd: mine.length ? mine[mine.length - 1].epa[0] : null,
      };
    });
    const bucket = Math.floor(t / 100);
    if (!buckets.has(bucket)) buckets.set(bucket, {});
    buckets.get(bucket)[t] = {
      team: t, ...(info.get(t) ?? {}), rank: rankOf.get(t), of: ranked.length,
      epa: epaRow(e), matches: h, events: evs,
    };
  }
  for (const [bucket, teams] of buckets) await writeJson(path.join(out, "team", `${bucket}.json`), teams);

  // ---- events ----
  const evList = [];
  for (const ev of events) {
    const teams = ev.teams.map((tp) => {
      const e = history.has(tp.teamNumber) ? model.epa(tp.teamNumber) : null;
      const start = eventStart.get(`${ev.code}:${tp.teamNumber}`);
      const h = history.get(tp.teamNumber)?.filter((x) => x.ev === ev.code) ?? [];
      return {
        team: tp.teamNumber, name: tp.team?.name ?? "",
        rank: tp.stats?.rank ?? null, rp: tp.stats?.rp ?? null,
        wins: tp.stats?.wins ?? null, losses: tp.stats?.losses ?? null, ties: tp.stats?.ties ?? null,
        epaStart: start ? r1(start.np) : null,
        // full model state entering the event, so the site can replay it live
        state: start ? [r1(start.auto), r1(start.teleop), r1(start.endgame), r1(start.foul), start.n, ...start.rp.map(r3)] : null,
        epaEnd: h.length ? h[h.length - 1].epa[0] : null,
        epaNow: e ? epaRow(e) : null,
      };
    });
    const read = cfg.read;
    let correct = 0, decided = 0;
    const ms = ev.matches
      .slice()
      .sort((a, b) => matchTime(ev, a) - matchTime(ev, b) || a.id - b.id)
      .map((m) => {
        const red = m.teams.filter((t) => t.alliance === "Red").map((t) => t.teamNumber);
        const blue = m.teams.filter((t) => t.alliance === "Blue").map((t) => t.teamNumber);
        const played = m.hasBeenPlayed && !!m.scores?.red;
        let pre = predByMatch.get(`${ev.code}:${m.id}`);
        if (!pre && red.length && blue.length) pre = model.predict(onField(m, "Red"), onField(m, "Blue"));
        const res = played ? { red: read(m.scores.red), blue: read(m.scores.blue) } : null;
        if (res && pre && res.red.total !== res.blue.total) {
          decided++;
          if ((pre.pRed > 0.5) === (res.red.total > res.blue.total)) correct++;
        }
        const sc = (a) => ({ np: a.np, total: a.total, auto: a.auto, teleop: a.teleop, endgame: a.endgame, rp: hasRp ? a.rp : null });
        return {
          id: m.id, d: m.description, level: m.tournamentLevel, time: matchTime(ev, m),
          red, blue, played,
          // elim alliances have 3 teams but only 2 play each match
          ...(red.length > 2 || blue.length > 2 ? { redOn: onField(m, "Red"), blueOn: onField(m, "Blue") } : {}),
          redScore: res ? sc(res.red) : null,
          blueScore: res ? sc(res.blue) : null,
          pred: pre ? {
            pRed: r3(pre.pRed),
            red: { np: r1(pre.red.np), total: r1(pre.red.total), auto: r1(pre.red.auto), teleop: r1(pre.red.teleop), endgame: r1(pre.red.endgame), rp: hasRp ? pre.red.rp.map(r3) : null },
            blue: { np: r1(pre.blue.np), total: r1(pre.blue.total), auto: r1(pre.blue.auto), teleop: r1(pre.blue.teleop), endgame: r1(pre.blue.endgame), rp: hasRp ? pre.blue.rp.map(r3) : null },
          } : null,
        };
      });
    const top = teams.map((t) => t.epaNow?.np ?? 0).sort((a, b) => b - a);
    const strength = top.length ? r1(top.slice(0, 8).reduce((a, b) => a + b, 0) / Math.min(8, top.length)) : 0;
    const loc = ev.location ? [ev.location.city, ev.location.state, ev.location.country].filter(Boolean).join(", ") : "";
    const summary = {
      code: ev.code, name: ev.name, type: ev.type, start: ev.start, end: ev.end, loc,
      teams: teams.length, matches: ms.length, played: ms.filter((m) => m.played).length,
      finished: ev.finished, ongoing: ev.ongoing, strength,
      accuracy: decided ? r3(correct / decided) : null,
      topTeam: teams.reduce((b, t) => ((t.epaNow?.np ?? -1) > (b?.epaNow?.np ?? -1) ? t : b), null)?.team ?? null,
    };
    evList.push(summary);
    await writeJson(path.join(out, "event", `${ev.code}.json`), { ...summary, timezone: ev.timezone, teamList: teams, matchList: ms });
  }
  evList.sort((a, b) => b.start.localeCompare(a.start) || b.strength - a.strength);
  await writeJson(path.join(out, "events.json"), evList);
  // small file so the home page loads without the full team/event lists
  await writeJson(path.join(out, "summary.json"), {
    cols, top: rows.slice(0, 10),
    live: evList.filter((e) => e.ongoing),
    recent: evList.filter((e) => e.finished).slice(0, 8),
    strongest: [...evList].filter((e) => e.teams >= 10).sort((a, b) => b.strength - a.strength).slice(0, 8),
  });

  // ---- season meta ----
  const nps = rows.map((r) => r[4]);
  const pct = (p) => nps[Math.floor((1 - p) * (nps.length - 1))];
  const meta = {
    season, game: cfg.game, rpNames: cfg.rpNames, generated: new Date().toISOString(),
    teams: rows.length, events: events.length, matches: matches.length,
    accuracy: Object.fromEntries(Object.entries(summarize(acc)).map(([k, v]) => [k, hasRp || k === "calib" ? v : { ...v, rpBrier: null }])),
    compare,
    percentiles: { p99: pct(0.99), p90: pct(0.9), p75: pct(0.75), p50: pct(0.5), p25: pct(0.25) },
    avgAlliance: {
      auto: r1(model.avg.auto), teleop: r1(model.avg.teleop), endgame: r1(model.avg.endgame), foul: r1(model.avg.foul),
      np: r1(model.avgAllianceNp()), rp: model.avg.rp.map(r3),
    },
    model: { ...model.p, baseline: { ...baseline, rp: baseline.rp.map(r3) }, cv: r3(cv), priors: priors.size },
  };
  await writeJson(path.join(out, "meta.json"), meta);
  return meta;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seasons = process.argv.slice(2).map(Number);
  for (const s of seasons.length ? seasons : [2025, 2026]) {
    const meta = await build(s);
    console.log(s, `${meta.teams} teams, ${meta.events} events, ${meta.matches} matches`);
    console.log(JSON.stringify(meta.accuracy, null, 1));
  }
  const all = await fs.readdir(path.join("site", "data")).catch(() => []);
  await writeJson(path.join("site", "data", "seasons.json"),
    all.filter((d) => /^\d{4}$/.test(d)).map(Number).sort((a, b) => b - a));
}
