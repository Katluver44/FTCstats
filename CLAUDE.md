# FTCstats

FTC team ratings (EPA), match predictions and ranking forecasts for every season
since 2019. Live at https://oddbot.org (GitHub Pages at
katluver44.github.io/FTCstats only redirects there). README.md has the full model
write-up and accuracy table; read it before changing the model.

## Layout
- `scripts/fetch.mjs <season>` — downloads events/matches/rankings from the
  FTCScout API into `.cache/` (finished events are never refetched).
- `scripts/build.mjs [seasons…]` — replays seasons in time order through the
  model and writes `site/data/`. Build seasons in order: each seeds the next.
- `site/js/model.js` — THE model (`Model` class, `DEFAULT_PARAMS`). The browser
  runs the same file on live events, so a change here changes both.
- `site/js/app.js`, `ui.js`, `live.js` — the framework-free static site.
  `config.js` holds editable settings (analytics ID, photo API URL).
- `photo-service/` — Vercel functions for team photo uploads (Vercel Blob,
  live on upload; removed at `/admin.html`).
- `scripts/package-vercel.mjs` — assembles `site/` + `photo-service/` into `dist/`.
- `scripts/rank-backtest.mjs`, `check-rs.mjs`, `compare.mjs`, `experiments.mjs`,
  `tune.mjs` — evaluation. `research/` exists on research branches only.
- Generated, not in git: `site/data/`, `.cache/`, `dist/`.

## Commands
    npm run update        # fetch + build every season (slow first time)
    npm run build         # rebuild from cache only
    npm run serve         # http://localhost:5173  (or the "site" launch config)
    npm run check         # our ranking scores vs FIRST's official ones — must pass
    npm run experiments   # model variants: tuned on 2022-24, scored on held-out 2025
    npm run compare       # EPA vs OPR baseline on 2025

## Deploy
The live site (https://oddbot.org) is self-hosted: `npm start` (scripts/server.mjs)
on a home PC behind a Cloudflare Tunnel; a scheduled task there pulls `main` and
runs update + check hourly, so pushing to `main` goes live within the hour.
`.github/workflows/deploy.yml` only refreshes the GitHub Pages redirect.
Don't deploy by hand unless asked.

## Rules
- Model changes: run `npm run experiments` (or `compare`) before and after and
  report winner-accuracy / Brier on held-out data. Don't tune on the test season.
- Run `npm run check` after anything touching rankings.
- Branches: `main` is live. Experiments go on a branch in a worktree
  (see `../CLAUDE.md`); `split-ratings` and `epa-research` are open ones.
- No new frameworks or build step for `site/`; it is plain ES modules.
- Data credit footer (FIRST / FTCScout) must stay.
