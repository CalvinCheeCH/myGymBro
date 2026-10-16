---
name: notion-formatting
description: How to write clean, well-structured Notion pages (plans, reports, logs). Use whenever you create or update a Notion page so the result is scannable and well organised rather than a wall of text. Read this before writing prose content to Notion.
---

# Write well-formatted Notion pages

When you write to Notion (weekly plans, progress reports, session notes, goal pages), make it look like something a thoughtful coach maintained, not a text dump.

All Notion writes go through the bundled helper, which writes rich blocks straight to the REST API (there is no MCP server). Use it for everything (headings, callouts, dividers, tables, and plain prose alike):

```bash
# Append rich blocks to a page from inline markdown or a file
node scripts/notion.mjs append --page <pageId> --file plan.md
node scripts/notion.mjs append --page <pageId> --md "# Heading\n> [!note] Priority\n---\n| Day | Focus |\n| --- | --- |\n| Mon | Push |"
```

The helper's markdown understands: `#`/`##`/`###` headings, `> [!note] text` callouts (put an emoji in the brackets to set the icon), `---` dividers, `-` bullets, `1.` numbered lists, `| a | b |` tables (first row is the header), column layouts, and plain paragraphs. Inside any line it also renders inline `**bold**`, `_italic_`, `` `code` ``, and `[label](url)` links as Notion rich text (no literal asterisks left behind), so you can emphasise within a paragraph or table cell. Use it for every page.

**Column layouts** (for dashboards and summary tiles) use this syntax: start with a line `::: columns`, separate each column with a line `|||`, and end with a line `:::`. Each column can contain any of the blocks above. Example:

```
::: columns
> [🎯] **Goals**
- Squat 100kg by Sept
|||
> [📈] **This Week**
- 3 of 4 sessions done
:::
```

The workspace builder configures linked database tables with Notion's
`2026-03-11` layout API. Use `setup-workspace.mjs --compact-layout` for the five-page
navigation layout; keep ordinary record writes in the existing helper. Changing
the page layout must not create replacement source databases or break their ids.

## Principles (from Notion's own design guidance)

- **Hierarchy with headings, not size.** Use H1 for the page title-level idea, H2 for major sections, H3 for sub-sections. Don't go deeper than three levels. Headings, not bold lines, carry the structure.
- **Callouts for what matters.** Use a callout block (with an icon) as a "pseudo-header" to highlight the one or two things the user must not miss: this week's priority, a safety note, a new PR. One or two per page, no more, or they stop standing out.
- **Toggles hide optional detail.** Put dense or secondary content (full exercise instructions, historical breakdowns, rationale) inside toggle headings so the page stays clean and the user expands only what they need.
- **Dividers sparingly.** A divider separates genuinely distinct sections. If a heading already does that job, skip the divider. Don't sprinkle them.
- **Tables for structured, repeating data.** A weekly plan (Day | Focus | Key lifts | Notes) or a PR list belongs in a table or a simple two-column layout, not a bullet list.
- **Negative space.** Short paragraphs, blank lines between sections. Let the page breathe.
- **Lists for steps and sets.** Numbered lists for ordered steps (a session walkthrough), bullets for unordered items. Keep each item to a line or two.

## Recommended structures

**Weekly plan page**
- H1/title: the week (dated).
- Callout: the week's single priority, tied to the user's main goal.
- A table: one row per training day (Day, Focus, Key work, Time). 
- Toggle "Full session details" per day if the exercise breakdown is long.
- Short closing line of motivation.

**Progress report page**
- H1/title: the period.
- Callout: the headline (a new PR, a streak, or the one thing to fix).
- H2 sections: Consistency, Strength/PRs, Bodyweight/trend, What to change.
- Tables or sparklines for numbers; toggles for the detailed log behind each summary.

**Dashboard / overview page**
- Default to a column layout, not a flat list of paragraphs and bullets. A flat stack on an overview page is a redirect waiting to happen.
- Use coloured callout tiles (each with an emoji) inside columns: for example a Goals tile, a This Week tile, and a Body Stats tile side by side.
- Dividers between major sections, H2/H3 headings per area, and a quote block for a coaching note.
- Make it the central index: the compact navigation callout contains exactly **Dashboard, Workout Log, Meal Log, Weekly Plan, and Food & Knowledge**. Use their page ids from `data/notion-ids.json` under `__workspacePages`, not the similarly named source-database ids. Build links as rich text with a `link` (`{ type:"text", text:{ content:"Workout Log", link:{ url:"https://www.notion.so/<id-without-dashes>" } } }`). Programs, Goals, Body Stats, and the source databases belong in Food & Knowledge's Workspace Resources, while Training Calendar is reached inside Workout Log. Preserve this hierarchy when refreshing display blocks.

**Meal Log overview page**
- Keep the visible `Daily nutrition` callout above the `Recorded meals` heading and linked table. Its children are managed summary content, separate from the meal records and navigation. Use `__nutritionSummary.pageId` and `.blockId` from the cache to target that container.
- The empty template should say intake has not been synced. Derive live values from the actual Meal Log and the user's stated targets; never insert fictional intake or an assumed target.
- Refresh the managed summary children only. Do not clear the whole Meal Log overview or replace its linked table when nutrition changes.

**Food & Knowledge / resources**
- Keep the saved-food table, Knowledge Base, and Exercise Library easy to reach. Put Programs, Goals, Body Stats, and source-database links in the nested Workspace Resources page rather than adding more main-navigation tabs.
- Preserve every source id, row, relation, and imported reference when reorganizing. Linked tables display the same source data; they are not new storage or permission boundaries.

**Workout Log row**
- Keep the structured values (Date, Focus, Status, Top Set, Volume, RPE, Duration, Week, Day, Program) in the database properties, not the body. See `docs/notion-architecture.md` for the exact schema.
- Put the per-exercise breakdown in the page body via **`--body`** on the same `log` command (a clean list, one line per lift as "Exercise, sets x reps @ load"), since the schema has no free-text exercises property and this avoids a separate id-capturing append step. The line `## Squat\n- 80kg x 5 x 5` becomes an H2 heading plus bullets.

## Keep the Dashboard in sync

If the workspace has a Dashboard page (built by setup-notion), keep its tiles current after you change the underlying data, so the user never has to ask.

**Preferred for the three data tiles (This Week, Goals, Body Stats):** run one command.

```bash
node scripts/notion.mjs sync-dashboard --now 2026-06-30   # --now is the date from the Telegram header
```

`sync-dashboard` re-derives all three tiles directly from the databases (session counts, goal progress, latest body stats), so the numbers are always consistent with the data and never hand-typed. Run it after logging a session, changing a goal, or logging body stats.

For one-off or prose tiles, `refresh-tile` replaces a single tile from your own markdown (never edit blocks in place; their ids shift). Tile ids are cached in `data/notion-ids.json` and self-heal from the live page, so refer to tiles by name: `thisWeek`, `goals`, `bodyStats`, `nextSession`, `activeProgram`, `nutrition`, `quickCommands`.

```bash
node scripts/notion.mjs refresh-tile --tile goals --md "> [🎯] **Goals**\n- Squat 100kg by Sept"
```

Treat the prose tiles (Next Session, Active Program, Nutrition) as yours to keep current, proactively: after recommending or planning a session, refresh Next Session; after agreeing nutrition targets, refresh Nutrition; after a program or focus change, refresh Active Program. If you notice any tile is stale against what you already know, fix it in the same turn rather than leaving it for the user to spot.

Rebuild the whole Dashboard (`node scripts/setup-workspace.mjs --rebuild-dashboard`) when the program changes, the week advances, or more than three tiles need updating at once. If no Dashboard exists, do not invent one unprompted; offer to build it via setup-notion.

## Always

- Never use em dashes in anything you write to Notion (titles, prose, table cells, notes). Use commas, parentheses, or full stops instead. This applies to Notion content exactly as it does to chat replies, and unlike Telegram messages it is not stripped automatically, so it is on you to follow it.
- Match the database schemas in `docs/notion-architecture.md` (Programs, Goals, Body Stats, Workout Log). Put structured values in properties; use the page body for prose and detail.
- Keep it phone-friendly to read back, but Notion is the durable record, so it can be a bit richer than a Telegram message.
- After writing, give the user a short confirmation in chat, not the full Notion content.
