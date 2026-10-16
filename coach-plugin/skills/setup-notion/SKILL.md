---
name: setup-notion
description: First-time setup of the Notion training workspace. Use when the user asks to set up Notion, get started, create their training log, or when other skills find the workspace databases do not exist yet.
---

# Set up the Notion training workspace

Build the full coaching workspace under the user's Hub page: the Programs, Goals,
Body Stats, Workout Log, Meal Log, and Food Library databases, an initial program row, the
Knowledge Base page with its Exercise Library note, the Training Calendar page,
and the Dashboard page. This is
deterministic and idempotent, handled by a bundled script.

## 1. Check configuration

Notion is reached with the integration token in `NOTION_TOKEN`, and the Hub page
is `NOTION_PARENT_PAGE_ID`. If `NOTION_TOKEN` is missing, tell the user plainly:
they need to set it and share a page with the integration, then try again. Do not
pretend it worked. If `NOTION_PARENT_PAGE_ID` is missing, ask the user to share a
page with the integration and tell you its name, find it, and pass it as `--hub`.

## 2. Build the workspace

Run the builder via Bash:

```bash
node scripts/setup-workspace.mjs
# or, if the Hub id is not in the environment:
node scripts/setup-workspace.mjs --hub <pageId>
```

It builds in the strict order the relations require (Programs, Goals, Body Stats,
Workout Log, Meal Log, initial program row, Knowledge Base, Exercise Library,
Training Calendar, Dashboard), detects anything that already exists by title and reuses it (never
duplicates), and writes all resolved ids (databases, Dashboard page and its
column ids, page ids) to `data/notion-ids.json`. To regenerate the Dashboard
layout, add `--rebuild-dashboard`.

The Exercise Library starts with the six muscle-group headings. Initial exercise
entries come from the complete Workout Log history: run
`node scripts/notion.mjs exercise-inventory`, categorize every distinct logged
movement under all muscle groups it meaningfully trains, then replace the page
with `node scripts/notion.mjs exercise-library --action replace --md "..."`.
Do not claim coverage complete if no workout history exists; ask the user for
their usual exercise list first. The full schema and API patterns are documented
in `docs/notion-architecture.md`; read it if you need to extend the workspace.

## 3. Seed goals and confirm

If `PERSONAL.md` lists real goals, offer to add them to the Goals database (ask
before writing), and refresh the Dashboard Goals tile afterwards (see the
notion-formatting skill). Then confirm what now exists and tell the user they can
log workouts in plain language and ask for plans, recommendations, and progress.

## Note on views

Notion's public API cannot create or configure database views (grouping, default
filters). After setup, tell the user to set any default view by hand once in
Notion; it cannot be done programmatically.
