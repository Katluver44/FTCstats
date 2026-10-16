# oddrobot style guide

The site should feel designed by one person with a point of view, not assembled
by many sessions. Every rule here exists to remove a decision someone would
otherwise make on the spot. If a rule blocks something genuinely better, change
the rule here first, then the code.

`npm run style` (scripts/style-lint.mjs) checks the mechanical rules. The
judgement rules are in the review checklist at the end.

---

## 1. Principles

1. **Data first.** Numbers are the product. They get the size, weight and contrast;
   labels, chrome and decoration step back.
2. **Every element earns its place.** If removing it loses nothing, remove it.
   No borders, pills, tints, icons or lines "for polish".
3. **Say it once.** A fact appears in one place per page (e.g. the win chance is
   on the bar, not also in a sentence and a header badge).
4. **One way to do each thing.** One button style, one toggle style, one table
   style, one chart style. A new variant needs a reason written here.
5. **Quiet by default.** Colour, gold, animation and bold are rare, so they mean
   something when they appear.

---

## 2. Layout

- **One left edge.** Page content starts at `var(--gutter)` (16px on phones,
  48 to 120px on desktop). Header logo, page titles, tables, charts and cards all
  start there. Nothing is indented further unless it is nested content.
- **One pane per page section.** A page is a sequence of sections on the page
  background, separated by space and a single hairline. Don't wrap every
  section in its own full-width card with gaps showing page colour between them.
- **Side-by-side panels have equal heights** and share a top edge (grid with
  `align-items: stretch`). Paired red/blue panels are always identical in size and
  treatment; the winner is marked by one thing, not by a different border.
- **Controls stay their natural width.** Search boxes max out at 320px on
  desktop; selects size to their content. No control stretches across the page.
- **No dead space.** A chart or table is as tall as its content needs. A short
  page ends with the footer, not with an empty band.

### Spacing scale (px)
`4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Nothing else for margin, padding or gap.
Within a component use 4/8/12; between components 16/24; between sections 32/48.

---

## 3. Type

| Token | Size / weight | Use |
|---|---|---|
| display | 56 / 800 | the one hero number on a page (team EPA, match score) |
| h1 | 32 / 800 | page title |
| h2 | 20 / 700 | section title |
| big-num | 24 / 800 | stat-card values |
| body | 15 / 400 | text, table cells |
| small | 13 / 400–600 | secondary text, table headers, buttons |
| tiny | 12 / 600 | axis labels, captions — never smaller |

- Only these sizes (plus 18 for phone h1/display steps). No 11.5, 12.5, 13.5, 14.5…
- Weights: 400, 600, 800. No 650/700/750/850 mixtures.
- Every number uses `font-variant-numeric: tabular-nums`.
- Numbers are bigger or bolder than their label, never the other way round.
- Sentence case everywhere. Uppercase only for table column headers (12px, 600,
  letter-spacing .04em). No uppercase "eyebrow" labels above every heading.

---

## 4. Colour has meaning — never decoration

| Colour | Means | Never use for |
|---|---|---|
| red / blue (`--red`, `--blue`) | red alliance / blue alliance | regression lines, errors, accents |
| accent blue (`--accent`) | interactive: links, active tab, focused control | static data |
| gold | the very best: #1 rank, top 1%, event win | "highlighted" points, decoration |
| green / red text (`--good`, `--bad`) | up / down change (▲ ▼) | status pills |
| greys (`--text`, `--muted`, `--faint`, `--line`) | everything else | — |

- No other hues. No gradients except the gold shine on gold badges.
- Reference lines (median, trend, average) are neutral grey, 1px, and **labelled
  where they are drawn** ("median", "trend"). An unlabelled dashed line is a bug.
- White text only on `--accent-strong` (readable in both themes), never on the
  light dark-mode accent.
- Body text contrast at least 4.5:1, large text at least 3:1, in both themes.

---

## 5. Components (one of each)

- **Button:** `.btn` (outline) and `.btn-solid` (primary, max one per view).
  36px tall on phones, 32 on desktop.
- **Toggle between views:** one segmented control style (`.seg`). At most one
  segmented control per row; a second level of choice becomes a select.
- **Select:** plain select, label inside as the first option ("All countries").
  No "X"/"Y" letter prefixes; write "Auto EPA vs Teleop EPA".
- **Pill:** static tags only (a count, a status). Pills are never buttons.
- **Table:** hairline rows, subtle zebra (`--zebra`), headers 12px uppercase,
  numbers right-aligned or centred consistently per column, no cell borders,
  no boxes around values except the EPA heat badge.
- **Team number:** bold tabular number, no chip/box/background.
- **Card:** only to group things that belong together *inside* a section
  (a stat tile, a match card). Radius 12, 1px `--line` border, no shadow.
- **Tap targets:** 36px minimum height on phones.

---

## 6. Charts

- One chart style: hairline grid, 12px grey axis labels, horizontal axis titles
  (no rotated text), no chart border.
- Highlight at most 5 points; their labels must not overlap (offset or drop).
- Every line, band or marker is either labelled on the chart or in a one-line
  legend directly above it.
- Colours follow section 4: alliance colours only for alliances.
- The chart is the content: no empty band around it, height follows the data.

---

## 7. Copy

- **Nothing explains a heading.** A page title or section heading names the thing;
  the content under it shows it. No muted sentence under an `h1` or `h2` saying
  what the section is, how to read it or what the numbers mean ("By match number
  so seasons line up", "How many times each team has won each award… hover a
  row for where", "Pick any teams and see how a qualification tournament…"). If
  a unit or basis has to be said, it goes in the axis label, the column header or
  a tooltip on the number, never in a paragraph. Cut in Oct 2026; don't add them
  back.

- One sentence max under any heading. Detail lives on the Methodology page or
  in a hover tip.
- Plain, specific, short: "Share of its last 10 quals it left the start zone",
  not "These are the only things FTC's score sheet credits to one robot…".
- No hedging, no "simply", no exclamation marks, no emoji in the UI.
- Labels are nouns ("Win chance"), buttons are verbs ("Compare").
- Don't explain the obvious. If a label needs a paragraph, the design is wrong.

---

## 8. Motion and loading

- Page switches: old page dims, new page fades in (160ms). No full-screen
  "Loading…" unless a load takes over 0.6s.
- Hover/active transitions 120–160ms. Nothing animates on its own except the
  gold shine, live indicators, the loading wheel and the robot (below). Respect
  `prefers-reduced-motion`.

### The loading wheel

Loading states (a page taking over 0.6 s, a SIM run) show one mecanum wheel seen
side on: `wheel(size)` from `ui.js`, a hub and eight rollers set at 45°, all
`--accent`, spinning in place (one turn per 1.1 s, linear), 48px, with the word
under it ("Loading…", "Simulating…"). Never a generic spinner, a progress bar or
the robot. It stops under `prefers-reduced-motion`.

### The robot

The site is **oddrobot** (all lower case; the wordmark is `odd<i>robot</i>`). Its
mascot is a top-down mecanum robot: blue body, four wheels, rollers in an X.

- **One drawing.** Always `robot(cls, size)` / `ROBOT_PARTS` from `ui.js`. Never
  redraw it, recolour it or add a face. Body is `--accent`, wheels `--text`.
- **Where it appears:** the desktop logo (34px), empty pages such as
  page-not-found and a bad team number (56px, still), empty tables and search
  results (24–28px, still, inline with the message), the no-matches field on a
  team page (drives the curve), and the match page's play button (96px, the play
  triangle on its body). Also the favicon.
- **Where it doesn't:** next to data, in tables with rows, in charts, as a bullet
  or decoration. It marks "nothing here yet" or "this is oddrobot", nothing else.
- **Motion:** the logo drives in from off the left edge on load (strafing), spins
  once on the spot, and strafes on hover (so does the play button); everything
  else is still. Mecanum moves only: strafe without turning, spin on the spot. All
  of it stops under `prefers-reduced-motion`.
- **Phones:** no logo in the header (the nav links need the room). The robot still
  appears in empty states, and the wheel while loading.

---

## 9. "AI tells" — review checklist

Run this on every screenshot before shipping. Any "yes" is a fix.

- [ ] Something is wrapped in a border, chip or pill that would read fine as plain text
- [ ] The same fact appears twice on the page
- [ ] A paragraph explains something a label should
- [ ] Two controls that do similar things look different
- [ ] A line, colour or icon has no stated meaning
- [ ] Alliance red/blue used for something that isn't an alliance
- [ ] Gold used for something that isn't "the best"
- [ ] Edges don't line up (left edges, right edges, paired panel heights)
- [ ] An element stretches to fill space it doesn't need
- [ ] Empty band, dead space, or a lone item on its own line
- [ ] Text smaller than 12px, or a size not in the type scale
- [ ] Labels overlap, or text is cut mid-word
- [ ] A muted sentence under a heading explaining the section
- [ ] Blank or "Loading…" flash when clicking between pages
- [ ] Looks wrong at 375px or at 2000px

---

## 10. Workflow for design changes

Design drift came from several sessions editing the same CSS at once. From now on:

1. **One owner.** Only one session works on look and layout at a time. Feature
   sessions may add markup but must use existing classes and tokens; if they need
   a new component, they stop and ask.
2. **Audit before editing.** Screenshot the page at 375, 1280 and 2000px in both
   themes, run the checklist above and `npm run style`, and list the findings.
3. **Arjun approves the list** (a short slideshow of before / proposed is the
   preferred format) before anything is built.
4. **Build with tokens only.** Spacing, type sizes, colours and radii come from
   the variables in `site/css/style.css`; no new hard-coded values.
5. **QA pass.** A separate agent re-runs the checklist and the measurements
   (no horizontal scroll, edges aligned, contrast) on every touched page at all
   widths, and reports; fixes go in before pushing.
6. **Ship small.** Commit and push one page at a time, with before/after
   screenshots described in the commit message.

Order for the first pass: tokens and components (type scale, spacing, buttons,
toggles, tables) → home → teams list (table + chart view) → team page → event
page → match page → compete → methodology.
