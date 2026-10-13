# FTCstats

FTC team ratings, match predictions you can check, and live ranking forecasts.
A faster, prediction-first alternative to FTCScout.

## How it works
- `scripts/fetch.mjs <season>` downloads every event (matches, rosters, official
  rankings) from the [FTCScout API](https://ftcscout.org/api), which mirrors the
  [FIRST FTC Events API](https://ftc-events.firstinspires.org/api). Raw
  responses are cached in `.cache/`; finished events are never refetched.
- `scripts/build.mjs [seasons…]` replays each season in time order through the
  EPA model (`site/js/model.js`) and writes static JSON to `site/data/`. Each
  season seeds team ratings from the previous one, so build seasons in order.
- `site/` is a framework-free static site. Event pages for in-progress events
  pull fresh results from FTCScout in the browser every 60 s and replay them
  with the same model. The rankings forecast is a 3,000-run Monte Carlo.

## Commands
    npm run update   # fetch + build 2024–2026
    npm run serve    # http://localhost:5173
    npm run check    # our ranking scores vs FIRST's official ones
    npm run compare  # EPA vs an OPR baseline on 2025
    npm run tune     # grid-search model params (tunes on 70%, reports held-out 30%)

## Accuracy (every prediction made before the match was played)
| Season | EPA winner correct | EPA Brier | OPR winner correct | OPR Brier |
|---|---|---|---|---|
| 2024 INTO THE DEEP | 74.9% | 0.164 | 73.9% | 0.168 |
| 2025 DECODE | 73.6% | 0.171 | 72.1% | 0.177 |

The OPR baseline re-solves OPR before every match from the event's matches so
far, blended with each team's OPR from earlier events. Ranking scores reproduce
FIRST's official ones for ~96% of teams; the misses are mostly league meets,
which rank differently.

Tried and rejected (no gain or worse): per-team foul ratings, faster rating
changes at the start of each event, blending EPA with OPR, an opponent-margin
term, per-match win-probability scaling.

## Deploying
`.github/workflows/deploy.yml` runs hourly on GitHub Actions: fetch → build →
ranking check (fails the run if our math drifts from FIRST's) → deploy to
GitHub Pages. To turn it on: push to a GitHub repo, then Settings → Pages →
Source: GitHub Actions. The first run downloads all seasons (~10 min); later
runs reuse the cache and take about a minute.

Data credit: match data from the FIRST FTC Events API via FTCScout. Not
affiliated with FIRST. The FIRST API terms ask for non-commercial use and a
link back, which the site footer provides.
