---
name: setup-notion
description: First-time setup of the Notion training workspace. Use when the user asks to set up Notion, get started, create their training log, or when other skills find the workspace databases do not exist yet.
---

# Set up the Notion training workspace

Build five main pages under the user's Hub: **Dashboard, Workout Log, Meal Log,
Weekly Plan, and Food & Knowledge**. Workout Log and Meal Log show linked tables
of the original source records. Food & Knowledge contains the Food Library table,
Knowledge Base, Exercise Library links, and a grouped Workspace Resources page.
Programs, Goals, Body Stats, and the other source databases stay available there
without becoming extra main-navigation choices. The Training Calendar sits under
Workout Log. The bundled builder handles this deterministically and idempotently.

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

The builder creates or reuses the five page shells and nested resources, then
builds the source databases in relation order (Programs before Workout Log).
It discovers existing objects throughout the Hub's child pages and preserves
their ids and records. Fresh source databases go in Workspace Resources. Original
database ids remain under their existing cache keys, while page ids are stored
in `__workspacePages`; they must not be interchanged.

For an existing workspace, use the explicit layout upgrade after confirming the
intended Hub and preserving a workspace backup:

```bash
node scripts/setup-workspace.mjs --compact-layout
```

It verifies linked Workout Log, Meal Log, and Food Library views against the
original data sources before moving any source databases. It then groups the
same databases under Workspace Resources, moves the known supporting pages,
and updates generated navigation to the five main pages. It does not copy,
archive, reset, or rewrite the source records, and leaves unrelated legacy pages
alone. Page and view ids are cached in `data/notion-ids.json` after creation so a
retry reuses them. To explicitly regenerate the Dashboard layout, add
`--rebuild-dashboard`; this replaces its display blocks, so preserve custom
dashboard prose before choosing that separate option.

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

## Views and nutrition summary

The builder uses Notion's `2026-03-11` layout endpoints to create linked table
views and relocate database containers while keeping the original data sources.
Record/schema operations keep their existing API version. Do not replace live
databases just to change their location or appearance. The integration needs
read, insert, and update content access to the Hub and supporting records.

Meal Log reserves a visible `Daily nutrition` callout above the record table.
Its child content is managed separately from the meal rows and navigation, with
its page/block ids cached in `__nutritionSummary`. The empty template makes no
claims about intake, targets, body measurements, or completed sessions.
