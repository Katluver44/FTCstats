# FTCstats

FTC team ratings, match predictions you can check, and ranking forecasts,
for every season from 2019 (SKYSTONE) to now. A faster, prediction-first
alternative to FTCScout. Live at https://ftcstats-photos.vercel.app/ (the old GitHub Pages address redirects there).

## How it works
- `scripts/fetch.mjs <season>` downloads every event (matches with per-robot
  score fields, rosters, official rankings), plus upcoming events with team
  lists, from the [FTCScout API](https://ftcscout.org/api), which mirrors the
  [FIRST FTC Events API](https://ftc-events.firstinspires.org/api). Raw
  responses are cached in `.cache/`; finished events are never refetched.
- `scripts/build.mjs [seasons…]` replays each season in time order through the
  EPA model (`site/js/model.js`) and writes static JSON to `site/data/`.
  Seasons seed each other's starting ratings, so build them in order.
- `scripts/rank-backtest.mjs` scores the ranking predictor on every past event.
- `site/` is a framework-free static site. Ongoing events pull fresh results
  from FTCScout in the browser every 60 s and replay them with the same model.

## The model
- **EPA**: points each team adds to its alliance, split into auto / teleop /
  endgame, plus each team's share of bonus ranking points.
- **Per-robot scoring from the game manuals**: elements scored per robot
  (parking, ascent, drone, base, auto movement) go to that robot instead of
  being split. Point values are learned from the data (`npm run solo-values`)
  and match each game manual exactly.
- **Auto movement**: a robot that didn't move in auto gets little of the
  alliance's auto credit (alliances where neither robot moves score ~0 in auto).
- **Uncertainty-weighted updates**: teams we know little about absorb more of
  a match's surprise; uncertainty grows at each new event.
- **Priors**: starting ratings blend the last three seasons by rank; rookies
  start a little below average.
- Ranking rules per season are checked against FIRST's official ranking scores
  (`npm run check`): win = 2 RP before 2025, 3 from 2025; ULTIMATE GOAL and
  FREIGHT FRENZY ranked by total points scored.

## Commands
    npm run update       # fetch + build every season
    npm run serve        # http://localhost:5173
    npm run check        # our ranking scores vs FIRST's official ones
    npm run experiments  # model variants, tuned on 2022-24, scored on held-out 2025
    npm run compare      # EPA vs an OPR baseline on 2025

## Accuracy (every prediction made before the match was played)
| Season | EPA winner correct | OPR winner correct |
|---|---|---|
| 2019 SKYSTONE | 68.5% | 67.2% |
| 2021 FREIGHT FRENZY | 71.2% | 69.3% |
| 2022 POWERPLAY | 74.2% | 71.9% |
| 2023 CENTERSTAGE | 74.2% | 71.1% |
| 2024 INTO THE DEEP | 76.2% | 73.9% |
| 2025 DECODE | 74.1% | 72.1% |

(See the About page on the site for current numbers, Brier scores and
calibration.) The OPR baseline re-solves OPR before every match from the
event's matches so far, blended with each team's OPR from earlier events.

Tried and rejected: per-team foul ratings, faster rating changes at each new
event (superseded by the uncertainty model), blending EPA with OPR, an
opponent-margin term, per-match win-probability scaling, bonus-RP chances in
the pre-schedule ranking forecast.

## Deploying
`.github/workflows/deploy.yml` runs hourly on GitHub Actions: fetch → build →
ranking check (fails the run if our math drifts from FIRST's) → package the
site with the photo service (`scripts/package-vercel.mjs`) → deploy to Vercel
using the `VERCEL_TOKEN` secret. GitHub Pages only serves a redirect.
Photo uploads go to Vercel Blob and appear after review at `/admin.html`.

Data credit: match data from the FIRST FTC Events API via FTCScout. Not
affiliated with FIRST. The FIRST API terms ask for non-commercial use and a
link back, which the site footer provides.
