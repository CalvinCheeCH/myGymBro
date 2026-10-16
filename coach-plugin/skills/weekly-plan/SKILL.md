---
name: weekly-plan
description: Build or refresh the user's training plan for the week and save it to Notion. Use when the user asks for a weekly plan, to plan their week, to set up their training split, or on the scheduled Sunday planning run.
---

# Build the week's training plan

Produce a realistic plan for the coming week that moves the user toward their goals and fits their life.

## 1. Gather context

- Read `PERSONAL.md`: goals (in priority order), days and times available, session length, equipment, injuries, coaching style.
- Pull recent Notion Workout Log rows with `node scripts/notion.mjs query-recent --db "Workout Log"` to gauge recent volume, what was trained, and recovery state. Read current Goals.
- Pull the week's nutrition adherence: run `node scripts/notion.mjs sum-day --db "Meal Log" --date <YYYY-MM-DD>` for each of the last 7 dates and compare daily calories and protein against the PERSONAL.md targets. Name the pattern honestly (e.g. "protein hit target twice all week" when that is true).
- Pull the latest bodyweight with `node scripts/notion.mjs query-recent --db "Body Stats" --limit 1` and compare the trend with the user's actual goal, whether muscle gain, fat loss, maintenance, or performance. Do not assume a target weight or treat one weigh-in as a trend.
- Pull this week's per-exercise bests for the overload table: run `node scripts/report-card.mjs --period week --week-offset -1` (completed week) or `--week-offset 0` (mid-week) and use its TOP lines, which already parse every session body into best load x reps per lift.
- Read the user's consolidated Exercise Library note and active program before choosing movements. Treat the catalog and the user's logged history as the default exercise menu; do not replace established lifts just to add variety.
- If the Exercise Library has no `Coverage: Complete through ...` marker, run `node scripts/notion.mjs exercise-inventory` to scan every logged Workout Log entry. Compare every canonical movement with the note, classify it under all meaningfully trained groups (Chest, Biceps, Triceps, Back, Legs, Shoulders), preserve distinct variations, and update the note with `node scripts/notion.mjs exercise-library --action replace --md "..."`. Confirmed aliases are defined in `scripts/exercise-aliases.mjs`; ask only if identity remains unclear. Mark coverage complete only after every inventory item is represented.
- If the inventory is empty, do not mark it complete or invent a routine; ask the user for the movements they want captured and categorize those.
- If Google Calendar is configured (calendar-sync skill), list the target week's events with `node scripts/calendar.mjs list --from <monday> --to <sunday>` and treat them as hard constraints when picking session days and times.
- When you read an existing program or week page, disambiguate by context, not just by name. Pages often share a name like "Week 1". Check the parent page title to confirm you have the right program (gym versus calisthenics, for example). If still ambiguous, ask which one in a single short question rather than guessing.

## 2. Design the plan

- Match the number of sessions to the days the user can actually train. Do not over-program.
- Choose a split that suits their goal and frequency (e.g. full body 3x, upper/lower 4x, push/pull/legs 6x, or goal-specific conditioning).
- Apply progressive overload from where their logs show they are now. Build in at least one easier or rest day; respect recovery.
- Once a movement is established in the catalog, keep its exact variation across successive weekly plans and prescribe progression on that same lift. Do not rotate it because a new week or block started. Change it only when the user asks, equipment/access changes, recovery or injury requires it, the active program requires it, or the lift no longer fits the goal or remains stalled despite appropriate adjustments; state the reason and preserve a progression path for the replacement.
- Give each planned lift an explicit numeric prescription for sets, reps, and load when the history and program support it (for example, `3 sets of 8 at 40kg`). Keep the same variation and progression target visible in the day table and forward-load summary. Use the progression tool's recommended load, but do not invent a target if the log lacks enough data; label the load as unprescribed and exclude it from planned-vs-actual comparisons.
- Do not prescribe an entry under `Needs identification` as if its variation were known. Resolve bundled aliases with `scripts/exercise-aliases.mjs` and use the canonical exercise history.
- Evaluate exercise choices honestly. If a logged or planned movement is unsafe, a poor fit for the user's goal/equipment/injury, or has a clear programming drawback, explain the specific concern and recommend a better option. Do not agree just to be agreeable; still record what the user actually performed accurately.
- Include a forward loads table for the key lifts: each lift's current best (from the TOP lines) against next week's target from `node scripts/progression.mjs suggest --exercise "<name>"` (quote the engine's number and reason; if it flags a deload after 2-3 flat weeks, programme it and say why, per the regression doctrine in progress-report).
- Set the week's nutrition expectation in one line, using their calorie and protein targets and actual goal rather than assuming they are bulking.
- Work around injuries. Keep it achievable: consistency beats an ambitious plan they will abandon.
- Use `find-exercises` to verify an unfamiliar movement, investigate a concern, or choose a necessary replacement. Do not use it to swap out established catalog lifts without a reason.

## 3. Save and present

- Write one dated plan page directly under the Notion Knowledge Base so it persists and the recommend-workout skill can reference it. Use the exact title `Weekly Plan - YYYY-MM-DD`, where the date is that training week's Sunday. Follow the notion-formatting skill so the page is clean and structured (a callout for the week's priority, a table of the days). If the workspace does not exist, run setup-notion first. Keep the Exercise Library as its own page; never put the plan inside or replace that note.
- If Google Calendar is configured, create one calendar event per planned session in the same turn (calendar-sync skill): focus in the title, key lifts in the description, default 30-minute popup reminder, and `--source weekly-plan` so reset can identify that event later. This is what puts the plan on the user's phone without Telegram.
- Present a concise summary in chat: day by day, the focus and the key lifts or sessions. Keep it scannable on a phone, and add one line of motivation tied to the user's main goal.
- If bodyweight tracking supports the user's stated goal, end with the weigh-in ask in one line ("Weigh in tomorrow morning fasted and reply with the number"): when the number arrives, log it with `node scripts/notion.mjs log --db "Body Stats" --set "Check-in=<DD/MM/YY>" --set "Date=<YYYY-MM-DD>" --set "Bodyweight (kg)=<number>" --set "Conditions=Morning fasted"`.
