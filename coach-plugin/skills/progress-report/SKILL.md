---
name: progress-report
description: Summarise the user's training progress and trends from their logged workouts. Use when the user asks how they are doing, for a progress report or report card (daily or weekly), weekly or monthly review, consistency check, or personal records.
---

# Progress report

Turn the Notion Workout Log into an honest, motivating read on how the user is doing.

For an explicit report-card request, take the fast path: run `report-card.mjs` for
the requested period and use its `REPORT`, `TOP`, and `CAPTION` output. Do not
repeat the same Notion reads with `query-recent`, `streaks`, or per-lift
`onerm`/`suggest` calls. Run extra analysis only when the user asks for trends or
coaching beyond the card.

When the application supplies `PRECOMPUTED_RECORD_DATA_JSON` for a bare
`/progress`, the data has already been read. Review those stated windows directly
with the known profile and coaching voice; do not fetch records again, render a
chart, or save anything. Respect coverage warnings and unknown values. The best
sets are records within those windows, not all-time personal records or proof of
a stall. Deeper questions still follow the analysis steps below.

## 1. Pull the data

- Decide the window from the request (this week, last month, or a sensible default like the last 4 weeks).
- Query the Notion Workout Log with `node scripts/notion.mjs query-recent --db "Workout Log"` for sessions in that window. Read current Goals and `PERSONAL.md` for what success looks like.

## 2. Analyse

- Consistency: sessions completed versus planned or versus their target frequency. For a visual, the engine renders GitHub-style streak squares from logged dates:
  ```bash
  node scripts/progression.mjs streaks --weeks 8
  ```
  Relay it in chat as-is (it is emoji squares and counts) or drop it into a Notion callout.
- Volume and load trends on the key lifts (are the numbers moving up?).
- Estimated 1RM per main lift, computed from real sets rather than guessed:
  ```bash
  node scripts/progression.mjs onerm --exercise "Squat"
  ```
  Report it as an estimate ("~116kg, up from ~110 last month") with its source set; never present it as a tested max.
- Personal records: any best loads, reps, distances, or times in the window.
- Balance and recovery: any neglected focus areas, or signs of doing too much.
- Progress toward each active goal.

Be truthful. If consistency slipped or a lift stalled, say so kindly and give a concrete fix. Do not invent numbers: if the log is thin, say what is missing and encourage logging.

## Regression: one down week is information, not failure

Loads will not rise every week (23kg this week, 20kg next). React like a coach:

- A single dip is noise, never a verdict. Do not scold it and do not reframe it as progression. Say plainly what happened ("down 3kg on rows this week"), then look for the cause before judging: the user's recorded training or sport load and reported recovery, food and protein coverage from the Meal Log, and any disruption the user mentioned. One question max, bundled into the report, not an interrogation.
- A pattern is programming: the same lift flat or falling for 2-3 weeks is a stall, and that is what the progression engine's deload flag is for. Prescribe the deload and say why.
- Never adjust the past to flatter the present. A blank or down week stays on the record; the fix goes in next week's plan.

## 3. Report

When the user explicitly asks for a **report card**, include the visual card:

- For a daily card, use only the requested day; if they say today, take the date
  from the Telegram message header. Run
  `node scripts/report-card.mjs --style card --period day --date YYYY-MM-DD`.
- For a weekly card, use the requested week. Default to the full current Sunday-to-Saturday
  week; future days remain visibly upcoming and have no duration points.
  Use `--week-offset -1` for the last completed week.
  Run `node scripts/report-card.mjs --style card --period week --week-offset N`.
- For a monthly card, use the latest completed calendar month and compare it with
  the previous month when both have workout records. The radar compares average
  weekly sets across Chest, Back, Legs, Shoulders, Biceps, and Triceps. Run
  `node scripts/report-card.mjs --style card --period month`.
- Send the one `CARD` image with the exact `CAPTION` output using
  `node scripts/send-photo.mjs --chat <current private chat id> --file <CARD path> --caption "<CAPTION>"`.
  Give one short coaching summary after it. Do not send the raw `REPORT` block
  unless they also ask for the full set-by-set log.
- The charts count logged sets for Chest, Back, Legs, Shoulders, Biceps, and Triceps.
  Compound sets can appear under multiple groups; unclear movement names stay
  unclassified instead of being guessed. A daily card never adds a previous-week
  comparison. Session duration appears only when it was saved with that session;
  older weekly totals are not split into invented daily durations.

Give a short, scannable summary: a headline on how the period went, two or three specifics (a PR, a trend, a gap), and one clear focus for the next stretch. End on genuine encouragement tied to their goal. Keep it phone-friendly.

If the user asks to save the report to Notion, follow the notion-formatting skill so the page is clean and structured: a callout for the headline, H2 sections for consistency, PRs, and what to change, and a column layout with callout tiles for any dashboard-style summary rather than a flat list. If the workspace has a Dashboard page, refresh its tiles afterwards (see notion-formatting).
