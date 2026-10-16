# Notion workspace architecture

The coaching workspace lives under one root Notion page (the **Hub**, set via
`NOTION_PARENT_PAGE_ID`). Six databases and three pages (a Dashboard, a
Knowledge Base, and a Training Calendar) hang directly off it. The whole thing
is built deterministically by `scripts/setup-workspace.mjs` and maintained
through `scripts/notion.mjs`.

Instance-specific ids (Hub, each database, the Dashboard page, and its column
ids) are **not hardcoded** anywhere in the repo. They are discovered at build
time and cached in `data/notion-ids.json` (gitignored). Resolve ids from that
cache or by name lookup, never from a literal in code.

## Build order (strict)

Relations force the order: a database referenced by a relation must exist first.

1. **Programs**
2. **Goals**
3. **Body Stats**
4. **Workout Log** (has a `Program` relation to Programs)
5. **Meal Log**
6. an initial Programs row (only if Programs is empty)
7. **Knowledge Base** page (where dumped training programs are filed as subpages)
8. **Training Calendar** page (the GitHub-style workout calendar; built before
   the Dashboard so the Dashboard can link to it)
9. **Dashboard** page

Run it with: `node scripts/setup-workspace.mjs` (idempotent: existing
databases/pages are detected by title and reused, never duplicated). Add
`--rebuild-dashboard` to regenerate the Dashboard body.

## API patterns

- Use the Notion REST API directly (`https://api.notion.com/v1`) for everything;
  it is the only Notion code path. Headers on every request:
  `Authorization: Bearer $NOTION_TOKEN`, `Notion-Version: 2022-06-28`,
  `Content-Type: application/json`. Both helper scripts retry with backoff on
  HTTP 429 (rate limit, approx 3 req/s per integration) and transient 5xx.
- **Columns:** children go *inside* the `column_list` object
  (`{ type:"column_list", column_list:{ children:[...] } }`), and every `column`
  needs at least one child block (an empty paragraph as placeholder). The
  `colList()` helper in `setup-workspace.mjs` and the `::: columns / ||| / :::`
  markdown in `notion.mjs` both enforce this.
- **Pages vs blocks:** `POST /v1/pages` does not nest column children reliably.
  Create the page flat, then `PATCH /v1/blocks/{id}/children` to add content.
  Batch at <=90 blocks per request.
- **Rows:** `POST /v1/pages` with `parent:{ database_id }`. Use
  `node scripts/notion.mjs log --db "Workout Log" --set "Name=value" ...`.
  Pass `--body "..."` to `log` (new row) or `update` (existing row) to write the
  page body in the same command, so no separate id-capturing `append` step is
  needed (that POSIX-style capture fails on Windows). Literal `\n` in the body
  becomes real newlines.
- **Child pages:** `POST /v1/pages` with `parent:{ page_id }`. Use
  `node scripts/notion.mjs create-page --parent <pageId> --title "..." --file x.md`.

## Database schemas

**Programs**: Program (title), Type (select: Powerbuilding, Strength,
Hypertrophy, Cardio, Deload), Status (select: Active, Completed, Planned,
Paused), Start Date (date), End Date (date), Weeks (number), Notes (rich_text).

**Goals**: Goal (title), Category (select: Strength, Body Composition, Cardio,
Habit), Metric (rich_text), Starting Value (number), Current Value (number),
Target Value (number), Target Date (date), Status (select: On track, At risk,
Achieved, Paused).

**Body Stats**: Check-in (title), Date (date), Bodyweight (kg) (number), Waist
(cm) (number), Chest (cm) (number), Arm (cm) (number), Conditions (select:
Morning fasted, Evening, After holiday, Post-training), Notes (rich_text).

**Workout Log**: Session (title), Date (one calendar date), Week (select:
`Week NN`, the ISO week containing the Monday of its Sunday–Saturday report
week), Day (select, matching Date), Focus
(multi_select: that day's groups - Legs, Chest, Back, Shoulders, Biceps,
Triceps, Cardio, Full Body, Mobility), Status (select: Completed, Partial,
Skipped), Top Set (number, daily max), Volume (kg) (number, daily sum),
Duration (min) (number, daily total), RPE (1-10) (number), Sessions (number,
workouts recorded on that date), Program (relation to Programs,
single_property). **One row per training date**, titled `DD/MM/YY (Weekday)`
like the Meal Log. The body keeps each session as a dated heading, an optional
measured `**Duration: <N> min**` line, and exercise headings with set bullets.
Multiple workouts on one date share the same row but keep separate sections;
their known durations add to that date's `Duration (min)`. Weekly cards group
daily rows by Date, and the history and heatmap use those same exact dates.
The `Week` tag is a calendar grouping convenience; `Date` remains the source of
truth for weekly and monthly reports.

**Meal Log**: Meal (title), Date (date), Meal Type (select: Breakfast, Lunch,
Tea, Dinner, Supper, Snack, Pre-workout, Post-workout), Calories (kcal)
(number), Protein (g) (number), Carbs (g) (number), Fat (g) (number), Source
(select: Text, Voice, Photo, Label), Notes (rich_text). **One row per calendar
day**, titled `DD/MM/YY (Weekday)` (e.g. `28/08/26 (Thursday)`). Opening the day
row shows the meals split into sections: Breakfast, Lunch, Tea, Dinner, Supper.
Every logged occasion appends its `## <Occasion>` heading (first time that
occasion appears that day) and a bullet line into the page body; its numbers
accumulate on the properties via additive `update` (`+=`) writes. The coach
fills calories and protein first class, carbs and fat when it is confident.
Numbers are estimates by nature; body lines carry the per-meal detail. The
title format is cosmetic: `find-row` keys off the Date property, which always
holds the ISO date regardless of how the title is displayed.

**Food Library**: Name (title), Serving (rich_text, e.g. `1 packet (45g)`),
Calories (kcal) (number), Protein (g) (number), Carbs (g) (number), Fat (g)
(number), Source (select: Label, Manual, Estimate), Notes (rich_text). One row
per repeat food, filed from label reads ("remember this") or corrected
estimates. The log-meal skill searches it with `lookup --db "Food Library"
--field Name --contains "<dish>"` before estimating: a hit is used exactly,
so repeat foods converge on label truth instead of fresh guesses.

## Dashboard

A page (not a database): a data-neutral hero, two compact linked navigation
rows, a two-column Next Session/progression row, compact weekly/nutrition/body
stat tiles, goals/program tiles, quick commands and message-coach guidance,
then a Training Calendar section. Keep the dashboard truthful before any logs
exist; never seed sample program dates, workout counts, or measurements as if
they were live data:

- Hero: blue callout with a short purpose statement and a note that tiles reflect
  saved Notion records
- Navigation: one link row for training pages and one for meal and reference
  pages, including the Exercise Library
- Row 1: 2 columns (Next Session, Progression). Notion requires at least two
  columns in a column list; the primary Next Session card comes first.
  `sync-dashboard` derives its
  context from the most recently logged actual sets and checks for the exact
  current-week `Weekly Plan - YYYY-MM-DD` page. If workout history cannot be
  read, it displays an explicit unavailable state instead of stale sets.
- Row 2: 3 columns (This Week, Nutrition, Body Stats)
- Row 3: 2 columns (Goals, Active Program + progression guidance)
- Row 4: 2 columns (Quick Commands, Message Your Coach)
- Training Calendar section: `## Training Calendar` heading plus a compact
  12-week heatmap grid, mirrored here by every `publish-heatmap.mjs` run so
  the homepage shows training without opening the full 26-week page. The
  section is deleted and re-appended on each publish; tile columns are never
  touched.

### Housekeeping

`scripts/cleanup-workspace.mjs` audits the Hub (dry run by default, `--apply`
to act): empty unprotected pages are archived (Dashboard, Knowledge Base, and
Training Calendar are protected even when empty; databases are listed, never
archived), duplicate same-day rows are reported for `migrate-consolidate.mjs`,
and the three workspace pages get their canonical icons.

The dashboard column ids are captured into `data/notion-ids.json` under
`__dashboard.columns` (`nextSession`, `progressionGuide`, `thisWeek`,
`nutrition`, `bodyStats`, `goals`, `activeProgram`, `quickCommands`,
`messageCoach`). Keep the row order in this document in sync with `TILE_ROWS`
in both `scripts/setup-workspace.mjs` and `scripts/notion.mjs`.

### Updating tiles

Never edit blocks in place (ids shift). Replace the whole tile:

```bash
node scripts/notion.mjs refresh-tile --tile goals --md "> [🎯] **Goals**\n- Squat 100kg by Sept"
node scripts/notion.mjs refresh-tile --tile thisWeek --file week.md
node scripts/notion.mjs refresh-tile --tile bodyStats --md "..."
```

## Nutrition tile and daily targets

The Nutrition tile is data-derived like the Dashboard's other summary tiles: `sync-dashboard`
re-derives it from today's Meal Log rows (sum of calories and protein) versus
the user's daily targets. Targets come from the gitignored `PERSONAL.md` at the
repo root, parsed for lines matching `Daily calorie target` (kcal) and
`Daily protein target` (g); missing targets simply leave them off the tile.
This keeps the tile fabrication-proof: every number on it comes from a query or
the user's own stated targets, never from the model.

## Training Calendar

A page (not a database) whose id is cached under `__trainingCalendar`, created by
`setup-workspace.mjs` just before the Dashboard (which links to it). Its body is
the GitHub-style workout calendar: a Monday-start grid with one column per week
(oldest left) and one row per weekday, where each cell is a coloured square
keyed to how many sessions were logged that day (⬜ rest, 🟩 1, 🟨 2, 🟧 3,
🟥 4+), plus a weekly totals row and a legend. Render via
`renderHeatmapGrid` in `scripts/progression.mjs` (pure, unit-tested) and write
with the standalone `scripts/publish-heatmap.mjs`:

```bash
node scripts/publish-heatmap.mjs           # last 26 weeks, page created if missing
node scripts/publish-heatmap.mjs --weeks 4 # last 4 weeks, handy for a quick look
```

Run it after a session is logged (the agent's workflow runs it alongside
`sync-dashboard`). The page body is replaced wholesale each time, mirroring the
tile-refresh pattern, so cells never go stale and the query window stays
bounded.

## Knowledge Base

A page (not a database) whose id is cached under `__knowledgeBase`. Training
programs the user dumps into the repo's `knowledge/` folder are filed here as
organised subpages (one per program) by the import-knowledge skill, using
`create-page`. It also contains one **Exercise Library** note listing actual
Workout Log movements under every muscle group meaningfully trained. Compound
movements appear under each trained group, and similar names remain separate
unless they are confirmed aliases. Conditioning benchmarks are recorded in a
separate section rather than presented as single-muscle lifts. The current
confirmed aliases are `DB Press` → `DB Bench Press`, `Hill Climbs` →
`Hill Run`, and `Cable Lat raise` → `Cable Lateral Raise`. The inventory is
consolidated under those canonical names; future logs and plans use the
canonical names while archived source rows retain the original wording.
`notion.mjs exercise-inventory` scans all logged exercise headings for initial
population; `notion.mjs exercise-library --action show` reads the canonical
note and `--action replace --md "..."` updates it. The coach draws on these when
planning and recommending.

Refresh **Goals** after a goal changes, **bodyStats** after a check-in,
**thisWeek** after a session is logged, and **nutrition** after a meal is
logged (or let `sync-dashboard` handle all four in one call). Rebuild the whole
Dashboard (`--rebuild-dashboard`) when the program changes, the week advances,
or more than three tiles need updating at once.
