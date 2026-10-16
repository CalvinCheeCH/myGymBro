# Notion workspace architecture

The coaching workspace lives under one root Notion page (the **Hub**, set via
`NOTION_PARENT_PAGE_ID`). Its five main pages are **Dashboard, Workout Log,
Meal Log, Weekly Plan, and Food & Knowledge**. The Workout Log and Meal Log pages
show linked tables of their original database records. Food & Knowledge contains
the saved-food table, reference links, and a nested **Workspace Resources** page
holding the six source databases. Knowledge Base sits under Food & Knowledge;
Training Calendar sits under Workout Log. The workspace is built deterministically
by `scripts/setup-workspace.mjs`, with layout helpers in `scripts/notion-layout.mjs`,
and maintained through `scripts/notion.mjs`.

Instance-specific ids (Hub, each database, the Dashboard page, and its column
ids) are **not hardcoded** anywhere in the repo. They are discovered at build
time and cached in `data/notion-ids.json` (gitignored). Resolve ids from that
cache or by name lookup, never from a literal in code.

## Build order (strict)

Relations force the order: a database referenced by a relation must exist first.

1. Discover the existing Hub subtree, create/reuse the five page shells, and
   create/reuse Workspace Resources beneath Food & Knowledge.
2. **Programs**, **Goals**, **Body Stats**, **Workout Log** (which relates to
   Programs), **Meal Log**, and **Food Library**, reusing the original source ids.
3. An initial Programs row, only if Programs is empty.
4. **Knowledge Base**, its **Exercise Library**, and **Training Calendar**.
5. Empty, data-neutral overview bodies and the visual Dashboard container.
6. Linked Workout Log, Meal Log, and Food Library tables using the original data
   sources. No meal, workout, measurement, or goal examples are seeded.

Run it with: `node scripts/setup-workspace.mjs` (idempotent: existing
databases/pages are detected by title and reused, never duplicated). Add
`--rebuild-dashboard` to explicitly regenerate the Dashboard display body.
For an existing workspace, `--compact-layout` verifies the linked tables first,
then moves the same source databases into Workspace Resources and the known
supporting pages into their corresponding main pages. Original ids, relations,
rows, and page bodies remain intact. Unrelated legacy pages are not automatically
moved or archived. Back up custom Dashboard prose before an explicit rebuild.

The cache keeps the original database keys (`Programs`, `Goals`, `Body Stats`,
`Workout Log`, `Meal Log`, `Food Library`) as **database ids**. Main page ids live
under `__workspacePages` (`dashboard`, `workouts`, `meals`, `weeklyPlan`,
`foodKnowledge`, `resources`). `__weeklyPlan`, `__foodKnowledge`, `__resources`,
and `__mealLogPage` are convenience aliases. `__workspaceViews` stores each linked
container, view id when available, original source database, and data-source id;
linked container ids must never overwrite the source-database keys.

## API patterns

- Use the Notion REST API directly (`https://api.notion.com/v1`) for everything;
  it is the only Notion code path. Headers on every request:
  `Authorization: Bearer $NOTION_TOKEN`, `Notion-Version: 2022-06-28`,
  `Content-Type: application/json`. Both helper scripts retry with backoff on
  HTTP 429 (rate limit, approx 3 req/s per integration) and transient 5xx.
- Layout-only requests use `Notion-Version: 2026-03-11`: `POST /views` creates
  linked table containers, `PATCH /databases/{id}` changes the parent without
  copying records, and `POST /pages/{id}/move` nests supporting pages. A linked
  table is verified to reference the same data source before an original source
  database is moved. Writes are not replayed after ambiguous 5xx responses.
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

A page with five-page navigation and one managed `Your daily overview` callout.
It contains a locally rendered PNG and a plain-text summary: training, calorie
and protein rings, latest bodyweight and trend, weekly duration bars, a 12-week
training heatmap, meals, goals, and the active program. Empty or unreadable data
is labelled explicitly; no sample intake, training target, or bodyweight is seeded.

`sync-dashboard` reads the original sources and renders the overview using Sharp.
It uploads directly to Notion, using no AI tokens or external chart service for
the graphics. The Meal Log summary uses the same day's calculated nutrition.
`publish-heatmap.mjs` still maintains the full Training Calendar but skips its
old Dashboard mirror when this overview exists.

During coaching, display commands are queued until after the Telegram reply.
Source writes and verified daily totals complete before save confirmation.
One background writer coalesces refresh requests and rereads current data;
reset pauses and drains that writer before archiving records. A failed optional
refresh is logged and retried on a later request or startup; it does not undo a
saved meal. The previous dated image can remain visible until refresh succeeds.

### Housekeeping

`scripts/cleanup-workspace.mjs` audits the Hub (dry run by default, `--apply`
to act): empty unprotected pages are archived (Dashboard, Knowledge Base, and
Training Calendar are protected even when empty; databases are listed, never
archived), duplicate same-day rows are reported for `migrate-consolidate.mjs`,
and the three workspace pages get their canonical icons.

The overview cache is `__dashboard: { pageId, layout: "overview",
overviewBlockId, columns: {} }`. Its membership is verified against the pinned
Hub before writing. Older column dashboards remain supported until an explicit
rebuild; `refresh-tile` only accepts their verified columns.

### Refreshing the overview

```bash
node scripts/notion.mjs sync-dashboard
```

## Nutrition tile and daily targets

The **Meal Log overview page** also reserves a visible `Daily nutrition` callout
above its `Recorded meals` heading and linked table. The managed summary container
is cached as `__nutritionSummary: { pageId, blockId }`. Its child blocks can be
refreshed independently of navigation and source records; never clear the whole
overview to refresh a nutrition display. The initial body is an explicit empty
state, with no assumed target or fabricated intake.

The nutrition summary is data-derived: `sync-dashboard`
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

Request `sync-dashboard` after a goal, check-in, session, meal, or program
changes. Ordinary record updates do not require a Dashboard rebuild.
