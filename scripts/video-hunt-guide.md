# Finding FTC event videos — guidelines for a search agent

You are given a list of FTC (FIRST Tech Challenge) events that our site has no or
partial video for. Find every YouTube video that recorded those events' matches.
You only **collect candidates**; a checker script verifies each one against the
official match times before anything is used, so report anything plausible —
but label your confidence honestly.

FTC = high-school robotics, 2-robot alliances. Seasons: **2024 = INTO THE DEEP**
(events Sep 2024 – Aug 2025), **2025 = DECODE** (Sep 2025 – Aug 2026). Older games:
CENTERSTAGE (2023), POWERPLAY (2022), FREIGHT FRENZY (2021). Not FTC: FRC (3-robot,
games REBUILT / REEFSCAPE / CRESCENDO), FLL / LEGO, VEX (V5RC, VIQRC, "Push Back").

## What counts
- **Full-event livestream recordings** (hours long). Multi-day events usually have a
  stream **per day and per field/division** — find all of them ("Day 1", "Day 2",
  "Saturday", "Field 2", "Part 2", "Division X"). An event listed with `haveVideo`
  already has some; look for the *other* days/divisions/parts.
- **Finals / awards streams** for championships ("Finals", "Marea Finală", "Einstein").
  These often don't repeat the event name — match by channel + date.
- **Long uploads** of an event (re-uploads of Twitch streams, edited recordings).
- **Per-match uploads** titled with the official match ("Qualification 12", "Q-12",
  "Playoff Match 3", "Upper Bracket Round 2 Match 4") — a whole channel of these is gold.
- **Uploads whose description lists match timestamps** ("01:02:03 Q12 …").

## What does NOT count
- Teasers, trailers, recaps, highlight reels, interviews, robot reveals (usually < 15 min).
- A team filming **its own** matches ("Team Stealth – Match 5") — "Match 5" is their
  5th match, not Q-5. Only report these if the title uses official numbering
  ("Qualification 23", "Q-23").
- The **same event name from another year** (most common trap): check the date.
  The event's `matchDays` (UTC) must match the stream date (± 1 day for time zones).
- Twitch / Facebook / Bilibili: we can't use them. Twitch deletes past broadcasts
  anyway. Note them in `notes` only.

## Where to look (do all of these)
1. **Web search** (WebSearch): `"<event name>" FTC`, `<event name> <city> FTC livestream`,
   `<event name> <year> robotics`, the venue name, local-language names
   ("Campionatul Național", "Torneio", "Championnat", "Regionalwettbewerb"…).
2. **YouTube search** without an API key:
   `node <hunt>/yt.mjs search "<query>"` → id | title | channel | channelId | when | length
3. **Organizer channels**: `node <hunt>/yt.mjs channel <UCid|@handle> streams` and `… videos`
   (the page lists ~30; check older ones with more specific searches). Regional
   organizers (FIRST in X, league channels, host schools/teams) stream most events in
   their region — one good channel covers dozens of events.
4. **Official event page**: `https://ftc-events.firstinspires.org/<season>/<CODE>` often
   links the livestream (fetch with curl/WebFetch).
5. Organizer / league websites, Discord-linked schedules, team sites, Reddit (r/FTC),
   Chief Delphi — they often link streams.

## How to decide it's the right event
- Date: stream date (or upload date ≤ ~2 weeks after) matches `matchDays`.
- Name: league / meet number / division / venue / city agree ("Meet #2" ≠ "Meet 3",
  "Group H" ≠ "Group V", "Northwest" ≠ "Northeast").
- Length: a full event is 3–12 h; a day of a multi-day event 4–10 h.
- When unsure, still report it with `confidence: "low"` and say why.

## Output (write early, update as you go, keep earlier entries)
```json
{
  "videos": [
    { "season": 2025, "code": "<event code from your list>", "videoId": "<11 chars>",
      "kind": "livestream|upload|per-match|timestamped", "title": "…",
      "confidence": "high|medium|low", "why": "short reason (date/name/channel)" }
  ],
  "channels": [ { "channelId": "UC…", "name": "…", "covers": "which events/area" } ],
  "notes": "Twitch-only organizers, events clearly not streamed, leads you couldn't finish"
}
```
For a per-match channel, list every match video you can (or give the channel and the
title pattern in `channels[].covers` — we can enumerate a channel ourselves).

Work top-down by `missingMatches`, but a channel that covers many events beats one
event. Don't edit any files except your results file. Don't use any YouTube API key.
