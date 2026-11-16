# Taking over oddbot

What a new maintainer needs that the code does not tell you. Written 2026-11-15.
README.md explains the model and commands, CLAUDE.md the working rules, STYLE.md
the look. Read those three first.

## What it is
FTC team ratings (EPA), match predictions, ranking forecasts and match videos for
every season since 2019, at https://oddbot.org. Plain ES modules in `site/`, Node
scripts in `scripts/`, no framework and no build step for the site. Most of the
code was written with AI assistance; the README's accuracy numbers are checked
on held-out seasons.

## State on 2026-11-15
- **Hosting is on the fallback.** The site normally runs from a home PC
  (`npm start` behind a Cloudflare Tunnel) that pulls `main` and runs
  `npm run update` hourly. That PC went offline on 2026-11-14. oddbot.org is now a
  static copy on Vercel, rebuilt hourly by `.github/workflows/vercel-fallback.yml`.
  If you host it somewhere permanent, remove that workflow's `schedule:` and follow
  "Hosting" in the README to point DNS back.
- **Pushing to `main` is a deploy.** The next hourly run publishes whatever is there.
- **Accuracy:** 74.8% winner correct / Brier 0.164 on held-out 2025 (OPR 72.2%);
  74.2% / 0.166 on 2026 so far, which no tuning has seen (OPR 70.2%).
- **Videos:** about 49% of all played matches have video; the 2026 season is at 30%
  (1,952 of 6,404) and climbing as the stream finder works through its backlog.

## Accounts and secrets (ask the previous owner; none are in git)
| Thing | Where | Used for |
|---|---|---|
| Domain `oddbot.org` | Porkbun (registrar) | renewal |
| DNS and tunnel | Cloudflare | records for `oddbot.org` / `www`, the `ftcstats` tunnel |
| Vercel project `ftcstats-photos` | Vercel | fallback hosting, photo upload functions, Blob storage |
| `FTC_API_USER`, `FTC_API_KEY` | FIRST FTC Events API (free, per person: register your own) | stream links, official alliances |
| `YOUTUBE_API_KEY` | Google Cloud project `ftcstats` (`scripts/setup-youtube-key.sh` makes one) | stream timings, stream finder |
| `TOA_API_KEY` | The Orange Alliance account page | TOA's stream list |
| `VERCEL_TOKEN` | Vercel | the fallback deploy |
| `BLOB_READ_WRITE_TOKEN`, `ADMIN_TOKEN` | server environment | team photo uploads and `/admin.html` |

The first five keys are GitHub Actions secrets on this repo and also go in a local
`.env` (git-ignored) for running scripts on your machine. A collaborator cannot read
secret values back from GitHub, so get your own or have them sent privately.

## The hourly pipeline (`npm run update`)
fetch (FTCScout API) -> build (replay every season through `site/js/model.js`) ->
streams (`find-streams.mjs`, looks for 2026 livestream recordings) -> videos
(`videos.mjs`, writes `site/data/<season>/videos.json`) -> alliances. Then
`npm run check` must pass. `.cache/` and `site/data/` are generated and not in git;
a first run from nothing takes about 50 minutes, later runs about 5.

## Known problems, most useful first
1. **No permanent host.** Decide between bringing a server back and staying on
   Vercel; the hourly fallback works but was meant to be temporary.
2. **2026 video backlog.** About 220 events have no video yet. The stream finder is
   capped at 200 quota units per CI run, and streams it finds in CI are not committed
   to `site/videos/discovered.json`; run `npm run streams` locally and commit the
   file now and then. Check every new pairing by title: same-day leagues in
   different cities pass the time test for the wrong event (see the `REJECT` list).
3. **Twitch-only regions** (Hawaii, Missouri/Kansas, parts of Florida) and
   Michigan's `fimav.us` links are not handled.
4. **README accuracy table** is slightly stale for 2019, 2021 and 2024 (the site's
   About page has the current figures).
5. **Model research** lives on branches that exist only on the previous owner's
   machine (`iter*/…`, `algo-iter*`, `split-ratings`, `epa-research`). The README's
   "Tried and rejected" list is the summary; ask if you want a branch pushed.

## Rules worth keeping
- Never tune on the season you report accuracy for. `npm run experiments` tunes on
  2022-24 and scores 2025.
- Use the official YouTube Data API only. Scraping youtube.com from one IP got that
  IP bot-checked once; do not repeat it.
- A wrong video is worse than no video.
- Keep the FIRST / FTCScout data credit in the footer; FIRST's API terms require
  non-commercial use and a link back.
