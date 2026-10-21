# Capabilities

What the coach can do, in depth. Behaviour lives in the persona (`CLAUDE.md`) and
the skills under `coach-plugin/skills/`; supporting compute lives in `scripts/`.

## Coaching skills

Skills are invoked automatically when a message matches; you rarely call them by
name.

English is the main coaching language. Goals, equipment, food preferences, dietary
restrictions, and schedule come from your profile rather than assumptions about where
you live. Choose your own IANA timezone in `TIMEZONE`; fresh installations default to
`Etc/UTC`. Food estimates depend on the information you supply and are not guaranteed
accurate across every dish or cuisine.

| Skill | What it does |
|---|---|
| `setup-notion` | Builds the full Notion workspace (Programs, Goals, Body Stats, Workout Log, Meal Log, Dashboard, Knowledge Base, Training Calendar) idempotently. |
| `log-workout` | Records a session to the Workout Log. Logs only what you actually said; never invents RPE, notes, or dates; asks "real or testing?" when a session's reality is unclear. |
| `log-meal` | Records what you ate (typed, enabled voice note, or meal/label photo) to the Meal Log with calorie and protein estimates or supplied label values, then reports the day's total against your targets. One row per day (titled `DD/MM/YY (Weekday)`) with the meals filed under Breakfast, Lunch, Tea, Dinner, and Supper sections inside the row. |
| `recommend-workout` | Suggests today's session, grounded in your goals and the last sessions pulled from Notion. Checks `PERSONAL.md` on the first message and asks for missing goals/nutrition before coaching on assumptions. |
| `weekly-plan` | Builds the week's plan from goals and recent volume, written to Notion. |
| `nutrition-advice` | Food, macros, and meal guidance tied to your goals. |
| `progress-report` | Consistency, volume trends, and personal records, optionally saved as a formatted Notion page. |
| `find-exercises` | Looks up real exercises (see below). |
| `notion-formatting` | How to write clean, structured Notion pages and keep the Dashboard in sync. |
| `import-knowledge` | Imports dumped training programs into the Notion Knowledge Base (see below). |

Cross-cutting coaching rules (disambiguate Notion pages by parent context, read
the day from the Telegram header, never use em dashes, etc.) are baked into these
skills and `CLAUDE.md`.

## Tap-to-answer coaching

`/today` and simple questions such as "What should I train today?" first read the
current week's saved Notion plan. A clear session gets **Start this session** and
**Change workout** buttons; a saved rest day stays a recovery day. If there is no
clear session, choose Upper body, Lower body, Strength & conditioning, or Something
else. Starting the saved session or changing the menu needs no AI call. A new
personalized recommendation still uses your profile, recovery, and training history.

When useful, a coach follow-up question includes two to four short answers. This
works across Claude, Gemini, and OpenAI without a separate AI call to create the
buttons. **Something else** lets you type an answer, and normal typed replies
continue to work. A tap is acknowledged before the next coaching request starts;
it does not make the AI provider or Notion respond instantly.

Only the latest question's buttons are active. They expire after 30 minutes, a
new message or command, or a bot restart; type your answer or ask again if a menu
expires. A Start button prepares the conversation; workouts are recorded from
the sets and completion messages you actually send.

## Vision: photos and PDFs

Send a meal, a food label, a gym machine, or a progress picture. Images and PDFs
are turned into model content blocks (`src/media/attachments.ts`) so the coach can
read a label, estimate a meal, identify a movement, or comment on a setup, then
tie it back to your goals.

## Voice notes

Telegram voice notes are transcribed and treated as if you had typed them. The
provider is configurable via `TRANSCRIBE_PROVIDER`:

- `local` (default): Whisper runs in-process (OGG/Opus decoded with bundled
  `ffmpeg-static`, transcribed via Transformers.js). Free, private, no key, no
  audio leaves the machine, but it needs a lot of RAM, so it suits self-hosting.
- `api`: the audio is transcoded and sent to an OpenAI-compatible transcription
  endpoint (OpenAI `gpt-4o-transcribe` by default). Tiny memory, needs a key, the
  right choice for scale-to-zero deployments where running Whisper would force a
  large instance.
- `off`: voice notes are declined with a "type it out" reply.

## Meal logging and daily intake

Tell the coach what you ate by typing ("chicken, rice, and vegetables"), by an enabled voice note,
or by snapping the plate or the food label. The `log-meal` skill estimates
calories and protein (carbs and fat when grounded), keeps one row per calendar
day in the **Meal Log** database, and replies with your running total for
the day against the `Daily calorie target` / `Daily protein target` lines in
`PERSONAL.md`. The Dashboard Nutrition tile is re-derived from those same rows
by `sync-dashboard`, so what you see in chat and on Notion always comes from the
log itself. Estimates are approximations: portions, recipes, and cooking methods vary.
For plate photos the coach first tells you what it sees and asks once for a
quick description (portions, what was left, anything hidden in the sauces)
before finalising; say "just estimate" or move on and it logs its best ranged
guess anyway. Saved Food Library entries and readable label values take precedence
over fresh estimates and are scaled to the servings you report. Unclear food names or
portions may need clarification; no worldwide food coverage or accuracy is promised.

Bare `/foodlib` reads up to 50 saved foods A–Z directly from Notion, without
calling an AI provider. Each entry shows its stored serving, category, calories
and protein; missing values stay unknown. Food questions with extra instructions
still use the coach.

## Exercise database

The `find-exercises` skill pulls real movements from the free, keyless
[free-exercise-db](https://github.com/yuhonas/free-exercise-db) dataset (~870
exercises with muscles, equipment, level, instructions, and start/end demo
images), released under The Unlicense (public domain). `scripts/exercise-db.mjs` downloads and caches the dataset, then filters:

```bash
node scripts/exercise-db.mjs --muscle chest --equipment dumbbell --limit 6
node scripts/exercise-db.mjs --name "romanian deadlift" --json
```

It honours your equipment and injuries from `PERSONAL.md` and can share both the
start and end demo image for a movement.

## Written progress reviews

Bare `/progress` reads recorded training once and asks your selected coach for a
short review of the latest 28 calendar days against the preceding 28. The review
keeps your coaching voice and known profile. It uses recorded training days,
recognizable set counts, and sourced best sets; it does not render a report card
or make the model request the same history through multiple tools. A healthy
review needs one model generation. Existing provider retry and fallback rules
still apply when a request fails.

Pending workout saves and buffered photos finish before this read. Planned and
skipped rows are excluded. Up to 60 matching rows are read, and limited coverage
is explicit. Free-form activity without recognizable sets or a recorded duration
may be absent from these totals. Read failures are reported as failures, not zero
training. If coaching cannot finish, the bot shows the recorded facts instead.

`/progress <question>` and attached photos retain the normal coaching tools for
deeper analysis, other periods, or saving a requested review.

## Training math

Deterministic arithmetic lives in `scripts/progression.mjs` so prescriptions never
depend on model vibes. The coach runs it via bash:

- `suggest --exercise "Squat"` parses recent Workout Log bodies, applies a
  progression rule (double by default, linear optional), detects stalls (same load
  three straight sessions) and prescribes the next weight with its reasoning,
  including an automatic 10% deload when stuck.
- `onerm --exercise "Bench"` gives the best estimated 1RM (Epley, capped at 12
  reps) with the set it came from.
- `plates --load 62.5` prints the per-side plate breakdown for a barbell.
- `streaks --weeks 8` renders GitHub-style consistency squares from logged dates.

All of these are pure functions at heart and covered by unit tests; the CLI is a
thin Notion-backed wrapper.

## Notion tooling

The agent talks to Notion entirely through its REST API via `scripts/notion.mjs`
(there is no MCP server): logging rows, querying recent sessions, summing a
day's rows (`sum-day`, used for meal totals), writing rich
blocks (headings, callouts, dividers, tables, columns, with inline bold/italic/
code/links), creating pages, and refreshing Dashboard tiles. The helper retries
automatically on Notion's rate limit and self-heals its local id cache if a
database is deleted and recreated. The full workspace schema, build order, API
patterns, and Dashboard layout are in
[notion-architecture.md](./notion-architecture.md).

## Knowledge base

Notion doubles as the agent's knowledge base. Drop training programs and reference
material (PDF, Markdown, text, images, CSV) into the repo's `knowledge/` folder and
ask the coach to import them. The `import-knowledge` skill reads each file,
structures it (using vision for PDFs and images), and files it as an organised
subpage under a **Knowledge Base** page in Notion via
`scripts/notion.mjs create-page`. The raw dump stays local and gitignored; the
durable, organised copy lives in Notion, and the coach draws on it when planning.

## Personas

Persona overlays change the coach's voice without touching its knowledge or safety
rules. The owner gets Arnold; other chats get a stable random famous character.
See [customization.md](./customization.md) to configure or extend them.

## Reminders

A scheduler can message you proactively (a morning nudge and the Sunday plan).
Management is live in polling mode; in webhook mode an external scheduler runs
the jobs. Additional or custom reminder jobs are defined in your scheduler
configuration, which the coach cannot edit itself; it can only run whatever jobs
you configure. See [deployment.md](./deployment.md) and
[configuration.md](./configuration.md).
