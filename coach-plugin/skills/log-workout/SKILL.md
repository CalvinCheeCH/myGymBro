---
name: log-workout
description: Record a workout the user did into the Notion Workout Log. Use whenever the user tells you what they trained, e.g. "did 5x5 squats at 80kg", "logged a 5k run", "finished push day", or "log my session".
---

# Log a workout

Turn the user's workout into one Notion Workout Log row per calendar day. Each
row holds that day's independent sessions, sets, volume, and duration.

## Capture the session

- Read `LOGGING_STYLE.md` first when it exists. Its notation and user-taught
  aliases are authoritative. Use `scripts/exercise-aliases.mjs` for bundled
  aliases, and ask the user when an exercise is still ambiguous. Use canonical
  names for future entries and plans so progression stays on the same movement.
- A rapid-fire sets ledger on `done` is authoritative. Use those sets instead
  of re-reading earlier messages that may contain corrected values.
- If the exact `Weekly Plan - <Sunday YYYY-MM-DD>` page exists, read it. Add a
  plan-versus-actual note only for the same exercise variation with numeric
  sets, reps, and load. Never infer that an unmentioned exercise was skipped.
- Record only real sessions. Use the local date in the Telegram message
  context when the user says they trained today; use the date they specify for
  earlier sessions. Derive the weekday from the calendar date. Do not generate
  the weekday separately or trust a weekday that conflicts with the date.
- Do not invent duration, RPE, notes, loads, or dates. A measured
  `[Session context: ... Duration (min)=N]` overrides any estimate. If it is
  missing, ask once for the duration when it is needed; logging must not wait
  if the user does not know it.
- If the user corrects a set before `done`, replace the prior value in place.
  If they send a forgotten set after `done`, ask whether it belongs to the
  session already logged or a new session before writing.

## Save one daily row

The canonical database is the top-level **Workout Log**. Find its row by the
session's exact local date:

```bash
node scripts/notion.mjs find-row --db "Workout Log" --date YYYY-MM-DD
```

The row title should match the Meal Log format: `DD/MM/YY (Weekday)`, for
example `08/10/26 (Thursday)`. Set `Date` to that single `YYYY-MM-DD` value,
`Day` to the matching weekday, and `Session` to a short session name. The
`Week` tag is the ISO week containing the Monday of its Sunday–Saturday report
week (`Week 41` for 4–10 October 2026), not the training program week. The Notion helper derives it from `Date` and adds a
missing `Week NN` select option when needed. Never use a Sunday-to-Saturday
date range for a workout row.

Structure each session in the page body as a date heading, an optional measured
duration, and one heading per exercise:

```markdown
## Thu 8/10 - Upper Body
**Duration: 55 min**
### DB Bench Press
- 10kg x 12, 12kg x 12
### Lat Pull Down
- 23kg x 12, 32kg x 12
```

For a new date, use `log` with one `--set` for each known property and the full
session body in the same command. Set `Date=<YYYY-MM-DD>`, `Day=<weekday>`,
`Status=Completed` (or `Partial`/`Skipped` as stated), `Focus=<this day's
muscles>`, `Top Set=<heaviest load>`, `Volume (kg)=<sum of known sets>`,
`Duration (min)=<measured minutes>` when known, and `Sessions=1`. Link the
active `Program` when known. Leave other unknown values blank.

For another workout on the same date, update that day's existing row. Append a
new dated session section, add its volume, raise Top Set only when the new set
is heavier, add measured minutes to that date's Duration, increment Sessions,
and union today's Focus with the existing Focus. Do not create a second row
for the same date.

For a forgotten set from the same session, append a `**Top-up <Day> <d>/<m>**`
marker and the corrected exercise details to the same daily row. Update
Volume/Top Set, but do not add duration or increment Sessions again.

Use the bundled Notion helper. Pass body content with `--body` in the same
`log` or `update` command; do not shell-capture an ID or use a second append
step for a normal workout write. Read the row body first when updating it so
existing session details stay intact.

After saving, run `sum-day --db "Workout Log" --date YYYY-MM-DD` and
`sync-dashboard --now <YYYY-MM-DD from Telegram context>`. The helper writes the
matching ISO `Week NN` tag when the workout is saved; do not touch Notion for
individual set messages. Confirm the date, session, and duration only when it
was actually recorded. Keep the reply brief.

## Report and history rules

- Workout Log dates are daily. The weekly report groups rows by their exact
  dates; duration is read from each date's `Duration (min)` value or its
  session duration line. Never spread an old weekly aggregate across days.
- Keep the Knowledge Base's one Exercise Library note current. `Cable Lateral
  Raise` belongs to Shoulders. List confirmed aliases under their canonical
  movement and place compound lifts under each group they meaningfully train.
  Preserve genuinely distinct variations. Run
  `node scripts/notion.mjs exercise-inventory` to reconcile the full history.
- If an exercise is a poor fit for the user's goal, equipment, or stated pain,
  say so plainly and suggest a suitable alternative. Ask when identity or
  classification is genuinely unclear.

If the Workout Log database does not exist, run the setup-notion skill first.
