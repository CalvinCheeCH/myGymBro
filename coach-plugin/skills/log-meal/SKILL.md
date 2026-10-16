---
name: log-meal
description: Log what the user ate and track daily intake against targets. Use when the user mentions food they ate or are eating ("just had eggs on toast", "logging my lunch"), sends a photo of a meal or drink, sends a photo of a food label or menu, sends a voice note describing what they ate, asks to remember/save/file a food in the Food Library, or asks what they have eaten today, their calories or protein so far, or how much they have left today.
---

# Log a meal

Turn what the user ate, however they tell you (typed, voice note, or photo), into
a clean row in the Notion Meal Log, then show where their day stands against
their targets.

## 0. Food Library first

Repeat foods should be lookups, not fresh guesses. Before estimating anything:

1. Normalise the dish to a short searchable name ("Greek yogurt", "chicken rice", "protein shake"), preserving regional dish names when the user supplies them.
2. `node scripts/notion.mjs lookup --db "Food Library" --field Name --contains "<name>"`
3. **Hit:** use the stored numbers exactly (they beat any estimate, including yours). Say where they came from in one clause ("from your library: 320 kcal, 12g protein"). Scale by servings if they had more than one.
4. **Miss:** estimate as usual (section 2). If the numbers came from a label photo, file them without being asked (step 5). Otherwise end your reply with one short offer: "Say 'remember this' and I'll file those numbers for next time."

**Save this food.** When the user asks to save, file, add, or remember a food (optionally with a correction such as "save this, 350 kcal"), file the food just discussed:

- If the request is a Telegram reply, use the quoted message to identify the food and serving. Reuse the exact calories and protein previously estimated for that individual food in this conversation; do not estimate it again. Never file a combined meal total (for example, oats plus eggs) as the macros for one food. If the conversation only gives a combined total or the individual values are unclear, ask one short clarification instead of inventing a per-serving value.

  1. `lookup` the name first. Row exists: `update` its numbers (never a duplicate row). No row: `log --db "Food Library"` with `--set "Name=<name>"`, `--set "Serving=<portion they described>"`, `--set "Calories (kcal)=N"`, `--set "Protein (g)=N"`, Carbs/Fat when grounded, `--set "Source=Label"` for label reads else `"Source=Manual"`, and `--set "Category=<best fit>"`. Prefer: Restaurant, Street Food, Packaged, Fast Food, Home-cooked, Drinks, Supplements, Other. Existing workspaces may still have Mamak/Hawker: use a legacy category only if it is present in the live schema and the user's supplied context matches it. The live schema is authoritative; if a preferred category is unavailable, use a compatible general category such as Other, without renaming existing options or records. Do not infer location or food source. If torn between two available categories, ask in one short question and use the answer ("File under Drinks or Packaged?"); never invent an option.
2. Confirm in one line ("Filed: Greek yogurt, 150 kcal / 18g protein per serving").
3. A label photo captioned "remember this" skips logging the meal: read the label, file the per-serving numbers exactly, confirm, done. If the Food Library database does not exist yet, run the setup-notion skill first.

## 1. Parse the meal

Extract from whatever they sent:

- The dishes or items, with portion cues they gave ("small serving", "two pieces",
  "shared with my sister", "extra sauce"). Understand regional cues such as
  "nasi sikit" (less rice) or "extra kuah" (extra gravy) when they use them.
- Which eating occasion it is: **Breakfast, Lunch, Tea, Dinner, or Supper**.
  A midday/second-afternoon bite or snack belongs under Tea. Pre-workout and
  post-workout fuel folds into the nearest of the five (usually Tea or Dinner).
  Use Supper for a later eating occasion the user describes; do not assume they
  eat at night or apply a fixed clock cutoff. Follow their stated routine and
  local time from the message header.
- The Source: Text, Voice, Photo, or Label.
- Any note worth keeping ("swapped rice for salad", "ate half").

**Input modes:**

- Typed message: parse directly. Understand regional slang and mixed-language
  input, including Bahasa Malaysia/Manglish when used, but keep replies mainly
  in English unless another language was explicitly requested. Preserve dish
  names rather than replacing them with a different dish. A message with a trailing `*`
  (`eggs on toast*`) or correction phrasing ("sorry, should be...") amends the
  previous message, not a new meal: replace the dish, portion, or numbers in
  what you are about to write (or just wrote), and confirm starting with
  "Fixed:".
- Voice note: arrives already transcribed; treat the transcript as typed text,
  but transcription can mangle dish names. If the transcript contains a
  near-miss of a common dish (or looks garbled), confirm your reading in the
  same single question as any fill-ins before logging.
- Photo of a meal: **do not log straight away.** Look at the photo first, then
  send one short message before finalising the row: (a) name what you can see
  ("that looks like chicken with rice and an iced tea") and (b) invite a description,
  because the user's context beats blind guessing: dish names, portions ("small
  serving", "half shared"), how much was actually left uneaten, anything hidden in
  the sauces, whether the drink counts. Two rules keep this from becoming
  friction: bundle everything into that ONE question (never a follow-up
  interrogation), and NEVER block the log on the answer. If the user replies,
  fold their detail into the estimate; if they say "just estimate", "you
  decide", or simply move on, log your best vision-based estimate as a range
  and set Notes to say it was estimated from the photo alone. If the photo shows
  a packaged item or a menu with numbers, skip the ask entirely: those exact
  values beat any description.
- Photo of a food label: read the label and use its per-serving values exactly;
  multiply if they say how many servings they had.

**Several photos in one turn** (Telegram delivers them together with one
caption): process EVERY image in arrival order, never just the first. When the
caption maps them ("image 1 = milk, image 2 = peanut butter"),
file or log one item per mapped image and confirm the full list ("Filed 2 of
3...") so a silent drop is impossible. If images arrive with no mapping, name
what you see in each and ask which is which in one question.

**One row per DAY, one breakdown inside.** The Meal Log holds exactly one row
per calendar date, titled `DD/MM/YY (Weekday)` (for example `28/08/26
(Friday)`). Opening that row shows the day's meals split into sections:
Breakfast, Lunch, Tea, Dinner, Supper. Every meal logged lands under its
occasion's section. Multiple meals never mean multiple rows.

The upsert flow, every time:

1. Check whether today's row exists (find-row filters the Date property, which
   is still the ISO date, so the human title changes nothing):
   `node scripts/notion.mjs find-row --db "Meal Log" --date <YYYY-MM-DD from header>`
2. **No row yet:** `log` one titled `<DD/MM/YY (Weekday)>`, derived from the
   header date, with this meal's values (`Meal Type` = its occasion), and pass
   **`--body "## <Occasion>\n- <meal line>"`** so the section heading and line
   are written in the same command:

   ```bash
   node scripts/notion.mjs log --db "Meal Log" \
     --set "Meal=28/08/26 (Friday)" --set "Date=2026-08-28" \
     --set "Meal Type=Breakfast" --set "Calories (kcal)=450" \
     --set "Protein (g)=25" --set "Source=Photo" \
     --body "## Breakfast\n- Three eggs on toast (~450 kcal / 25g protein)"
   ```

3. **Row exists:** `update --page <rowId>` with ADDITIVE numbers so the day
   accumulates deterministically ("Calories (kcal)=+=650", "Protein (g)=+=28"),
   and pass **`--body`** for the page line(s) in the same command. First time
   that occasion appears today, `--body` holds its `## <Occasion>` heading
   followed by the line (e.g. `--body "## Lunch\n- <line>"`); the same occasion
   again, `--body` holds just the line. Keep sections in page order: Breakfast,
   Lunch, Tea, Dinner, Supper. Never create a second row for the same date, and
   never do the addition mentally - the `+=` operator reads the current value
   itself.
4. Reply totals: after writing, `sum-day` prints the day's authoritative totals;
   relay those against targets.

**Correcting a typo after the write.** There is no in-place body edit: a
correction rewrites the whole day row. If the user corrects something already
logged ("sorry, that was plain coffee, not a latte"):

1. `find-row --db "Meal Log" --date <YYYY-MM-DD>` for the id, then
   `read-blocks --page <rowId>` for the full current body.
2. Reconstruct the COMPLETE corrected body: fix the typo'd line, keep every
   other line byte-identical, keep the occasion sections in page order.
   Recompute the day's Calories, Protein, Carbs, Fat from all lines (subtract
   the wrong item, add the right one).
3. `log` the corrected day row FIRST (same `DD/MM/YY (Weekday)` title, same
   date, corrected properties, corrected `--body`).
4. Read it back (`read-blocks` on the NEW id) and confirm the fix is in and
   nothing else changed. Only then `archive` the OLD row id. Log-then-verify-
   then-archive, in that order, so a failure can never lose data.
5. Run `sum-day` then `sync-dashboard`, and reply starting with "Fixed:" plus
   the corrected running total.

Never archive before the replacement is verified. Never leave two live rows
for the same date.

Use `--body` on `log`/`update` to write meals in ONE command. Never try to
capture the row id with shell redirection, grep, head, or `$()` to run a
separate `append`: on this machine that fails and leaves the body empty.

**Sections live on the page, numbers live in the properties.** The Breakfast /
Lunch / Tea / Dinner / Supper headings are the human breakdown; the row's
Calories (kcal) / Protein (g) / etc. properties are what `sum-day` and the
Dashboard Nutrition tile read, so keep them in sync with every `+=` update.

**Date:** default to today from the Telegram message header when they say
"just now", "tadi", "today", or send a photo mid-meal. Use the day they name
when they say "yesterday" or "semalam". Never invent a date for an ambiguous
case; fold one question into your fill-in ask instead.

## 2. Estimate calories and protein

Use label values or the Food Library first. For other foods, estimate from the
actual ingredients, portions, and cooking method the user supplied; do not use
one cuisine's portions as a default for unrelated meals. When their dish or
provided context matches Malaysian foods, consult
`coach-plugin/skills/log-meal/reference/malaysian-foods.md` for matching
portions, drinks, or the campur/kandar component builder. If the reference is
not already supplied in context, read it via `read_file` when needed. For meals
that do not match, leave that reference unused, even if it is embedded in the prompt. Ask once
when an unfamiliar dish or missing portion would materially change the estimate.

- Calories and Protein (g) go first class into the row.
- Carbs (g) and Fat (g) only when you have a grounded basis (a label, or a
  well-known composition); leave blank otherwise.
- Estimates are estimates: give ranges out loud when uncertain ("roughly 650 to
  750 kcal") and log the midpoint. Never present a guess as exact.
- If PERSONAL.md lists dietary restrictions (halal, vegetarian, allergies),
  respect them silently in what you accept as plausible; if the food clearly
  contradicts a stated restriction, flag it gently once, log what they actually
  ate anyway, and move on. The log records reality.

## 3. Write to Notion

Resolve the database once (`node scripts/notion.mjs resolve-db --name "Meal
Log"`) and add a row:

```bash
node scripts/notion.mjs log --db "Meal Log" \
  --set "Meal=28/08/26 (Friday)" \
  --set "Date=2026-08-28" --set "Meal Type=Breakfast" \
  --set "Calories (kcal)=450" --set "Protein (g)=25" \
  --set "Source=Photo" \
  --set "Notes=User said three eggs and two slices of toast" \
  --body "## Breakfast\n- Three eggs on toast (~450 kcal / 25g protein)"
```

The title is always the day string `DD/MM/YY (Weekday)`, never the dish.
The helper coerces each `--set` to the right type; property names must match
the schema in `docs/notion-architecture.md` exactly, and a wrong name fails
loudly with the real names printed, so correct yourself from that. Add
Carbs/Fat properties the same way when you have them. If the Meal Log database
does not exist yet, run the setup-notion skill first.

## 4. Show where the day stands

Do both, every time, before replying:

1. Run `node scripts/notion.mjs sum-day --db "Meal Log"` to get deterministic
   totals for today (pass `--date YYYY-MM-DD` for another day).
2. Run `node scripts/notion.mjs sync-dashboard --now <YYYY-MM-DD from header>`
   to refresh the Nutrition tile (and This Week, Goals, Body Stats while at it).

## 5. Reply

Keep it short and useful:

- Confirm what you logged with the estimate ("Three eggs on toast,
  about 450 kcal and 25g protein").
- Give the running total against targets from the sum-day output: "That puts
  you at 1450 kcal and 76g protein today, about 550 kcal and 44g left."
- One light observation max, tied to their goal, never a lecture. A gentle flag
  on the third sugary drink of the day is coaching; nagging is noise.

If PERSONAL.md has no `Daily calorie target` / `Daily protein target` lines
yet, offer once to work them out together from their stats and goal, and write
plain numbers into those two lines (for example "- Daily calorie target (kcal):
2000"). The Dashboard tile reads those lines; keep them as plain numbers, not
formulas. Do not push medical precision; sensible ranges beat false certainty,
and anything clinical belongs with a professional.
