# FTCstats

FTC team ratings, match predictions you can check, and ranking forecasts,
for every season from 2019 (SKYSTONE) to now. A faster, prediction-first
alternative to FTCScout. Live at https://oddbot.org/ (the old GitHub Pages address redirects there).

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
Two rating tracks run side by side over the same matches (`site/js/model.js`):
- **EPA** (what team lists, team pages and "Top teams" show): meant to say how
  strong each robot is. One model per component (Auto, Teleop, Endgame;
  per-robot elements folded in; Total = sum), each with its own knobs in
  `DEFAULT_EPA_PARAMS = { shared, auto, teleop, endgame }`. Scored by
  `research/epa-eval.mjs`: does the EPA a team brings to an event predict its
  component OPR there (extra weight on Worlds/Premier/top-scoring events), and
  does the pre-Worlds list agree with Worlds division OPR and playoff results?
  Each component was tuned separately by leave-one-season-out CV (2019,
  2021-2025; `research/tune-*/`): new teams start nearer average, endgame
  barely carries over between games, steadier updates. Held-out total EPA
  error (nMAE) 0.524 -> 0.459, better in all six seasons.
- **Off-season**: the team list offers three tables. *Official season*
  (default) leaves off-season events out (scrimmages and post-Worlds Premier
  events count). *Through MTI* counts off-season events up to MTI (Maryland /
  Multinational Tech Invitational) at 40% each; *Full season* counts all of
  them at 40%. Both skip events with modified rules: listed ones (Chicago
  Robotics Invitational) and any whose scores fall outside 0.5-1.6x what the
  teams' EPAs predict. Next season's starting ratings use the Full table.
- **Prediction rating** (`DEFAULT_PARAMS`): tuned only for match-prediction
  Brier; drives win chances, predicted scores and ranking forecasts.

Tuning the EPA track (under 1 s per season per parameter set):

    node research/epa-eval.mjs --comp auto            # auto | teleop | endgame | total | all
    node research/epa-eval.mjs --comp all --params p.json    # p.json = {"teleop": {"mom": 0}}
    node research/epa-eval.mjs --comp teleop --grid g.json   # g.json = {"teleop.mom": [0, -0.1]}: LOSO tuning
    EPA_PARAMS=p.json node scripts/build.mjs 2025     # trial build with EPA overrides

`topB(EPA)` in its output is the bias on the top 5% of pairs by EPA (the
teams the list puts on top); `topB(tgt)` selects by outcome and is mostly
regression to the mean. Tried and left off for the EPA track: a
between-event growth term (`grow`: at a team's next event, add part of the
league-average rise since its last match). LOSO picked grow 0.5 in every fold
and lowered held-out total nMAE in all six seasons (0.462 -> 0.443), but the
top 5% by EPA came out more overrated in five of six (mean +0.7 -> +3.5
points), so the top of the list would read too high.

What the prediction rating does:
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
- **Level-aware noise**: scores are noisier in high-scoring matches, so the
  win-probability spread and the rating-update noise both grow with the
  match's predicted scoring level (before this, strong-vs-strong matches were
  overconfident and low-scoring ones underconfident).
- **Event-change reversion**: at a new event a team gives back 20% of its
  rating change from its previous event; part of every jump is noise.
- **Score recalibration**: ratings lag improving teams and over-predict strong
  alliances, so a small online regression on already-played matches corrects
  predicted scores (win probabilities use the raw ratings).
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
| 2019 SKYSTONE | 68.5% | 67.3% |
| 2021 FREIGHT FRENZY | 71.7% | 69.4% |
| 2022 POWERPLAY | 74.4% | 72.0% |
| 2023 CENTERSTAGE | 74.5% | 71.2% |
| 2024 INTO THE DEEP | 76.5% | 74.0% |
| 2025 DECODE | 74.8% | 72.2% |

(See the About page on the site for current numbers, Brier scores and
calibration.) The OPR baseline re-solves OPR before every match from the
event's matches so far, blended with each team's OPR from earlier events.

Model changes are checked with leave-one-season-out cross-validation
(`node research/loso.mjs`): tune on five seasons, score the sixth, with a
paired bootstrap over events. The 2026-10 round (level-aware noise,
event-change reversion, score recalibration) lowered Brier in all six seasons
(mean 0.1724 -> 0.1709) and score error 22.3 -> 21.3 points.

Tried and rejected: per-team foul ratings, faster rating changes at each new
event (superseded by the uncertainty model), blending EPA with OPR, an
opponent-margin term, per-match win-probability scaling, bonus-RP chances in
the pre-schedule ranking forecast; and from the 2026-10 round: positive
momentum (it hurts: event-to-event changes revert), a slow second rating
track, a win/loss Elo blend, a higher starting uncertainty for rookies,
uncertainty growing with days idle, per-team consistency in the win spread,
per-event score offsets, extra spread for a team's first match at an event.

## Deploying
`.github/workflows/deploy.yml` runs hourly on GitHub Actions: fetch → build →
ranking check (fails the run if our math drifts from FIRST's) → package the
site with the photo service (`scripts/package-vercel.mjs`) → deploy to Vercel
using the `VERCEL_TOKEN` secret. GitHub Pages only serves a redirect.
Photo uploads go to Vercel Blob and appear after review at `/admin.html`.

Data credit: match data from the FIRST FTC Events API via FTCScout. Not
affiliated with FIRST. The FIRST API terms ask for non-commercial use and a
link back, which the site footer provides.
