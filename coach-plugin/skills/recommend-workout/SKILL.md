---
name: recommend-workout
description: Recommend the user's training session for today, or start a session. Use when the user asks what to train, what today's workout is, to start a session, or for a quick session because they are short on time.
---

# Recommend today's session

Give the user a concrete session they can start now, grounded in their goals and what they have actually been doing.

## 0. First-message profile check

On the first message of a new conversation, check that `PERSONAL.md` has real goals and a nutrition target, not placeholder or example text. If it is still thin or templated, do not coach around the gap: ask one short pair of questions first, for example "Before we start, your profile is missing goals and nutrition targets. What are you training towards, and roughly what do you eat day to day?" Then update `PERSONAL.md` with the answers before giving the session.

## 1. Gather context

- Read `PERSONAL.md` for goals, schedule, available equipment, injuries, and coaching style. Honour the equipment and injury constraints strictly.
- Take the current day and time only from the Telegram message header, in the form `[local time: DD/MM/YYYY, HH:MM:SS (timezone)]`. Never work out the day of the week yourself from the date or from memory; the header is the source of truth.
- When reading a program or plan from Notion, disambiguate by context, not just by name. Many pages share a name like "Week 1". Before using one, check its parent page title to confirm it is the right program (for example a gym program versus a calisthenics program). If it is still ambiguous, show the two candidates and ask which one in a single short question, not a dump of every search result.
- Pull recent rows from the Notion Workout Log before recommending anything. The fastest path is the bundled helper, which queries and sorts for you:

  ```bash
  # Last 3 sessions overall, or for a specific Focus you are about to train
  node scripts/notion.mjs query-recent --db "Workout Log" --limit 3
  node scripts/notion.mjs query-recent --db "Workout Log" --focus Chest --limit 3
  ```

  Use these rows for dates/focus, then read the relevant Workout Log page bodies for exercise names and actual set results; `query-recent` does not show the lift breakdown. Check the current week's plan if one exists.
- Read the Exercise Library note under the Notion Knowledge Base. Prefer exercises already in the user's catalog and preserve the exact variation for progression; do not add variety just because it is a new week. Do not prescribe an entry under `Needs identification` as if its variation were known; ask one short clarifying question when it affects today's plan.
- If its coverage marker is missing, run the inventory and initial-population process in the weekly-plan skill before proposing unfamiliar exercises.
- If no logged exercises exist yet, ask the user for their usual movements before treating an exercise selection as an established routine.

- For established catalog lifts with enough exact history, ground the load prescription in the progression engine rather than eyeballing it. Batch the key lifts into one call so Notion history is fetched once, not once per exercise:

  ```bash
  node scripts/progression.mjs suggest-batch --exercises "Squat,Bench" [--rule linear]
  ```

  Quote its suggested load and reason for any lift it covers ("engine says 92.5, top of your rep range"). For lifts it cannot find in recent bodies, read the actual set lines and prescribe from those numbers, saying plainly that the engine did not cover it. If it flags a deload, take the hint seriously: three flat sessions is a real stall, not a bad day.

## 2. Decide the session

Apply basic training sense:

- Respect recovery: do not recommend heavy work on a muscle group trained hard yesterday. Rotate focus sensibly.
- Move toward the user's priority goal (progressive overload on the key lifts, or the conditioning the goal needs). The engine's suggestion is the default prescription; override it only for good stated reasons (injury, fatigue, a cut), and say why when you do.
- Fit the time and equipment they actually have. If they say they are short on time, give a tight, high-value version.
- Autoregulate the bad days: if they report feeling flat, sore from other activity, or underfed, drop the prescribed loads so every working set leaves 1-2 clean reps in the tank, and say so ("take 10% off across the board today, the win is showing up"). Never demand last week's numbers on a bad day, and never use RPE-scale language when adjusting: talk reps in the tank, not numbers out of ten.
- Work around any injury or limitation in `PERSONAL.md`.
- Be candid about exercise quality. If the user's requested or logged movement is a poor fit for their goal, equipment, recovery, or injury status, explain why and offer a better alternative. Do not rubber-stamp it; accurately preserve the historical log of what they actually did.
- When the user asks how to load a barbell weight, use the plate calculator instead of doing mental arithmetic: `node scripts/progression.mjs plates --load 62.5`.

## 3. Deliver it

Give a clear, ready-to-do session:

- A short warm-up.
- The main work: exercises with sets, reps, and a load or intensity cue (use recent log loads as the reference point, suggesting a sensible progression). Use the catalog and active plan first; use `find-exercises` only for a genuinely new movement, a suitability concern, or a necessary replacement.
- An optional finisher if time allows.

Keep it phone-friendly and motivating. End with a nudge to log it when done (the log-workout skill will record it). Do not write this recommendation to Notion unless the user asks: it is a suggestion until they actually do and log it.
