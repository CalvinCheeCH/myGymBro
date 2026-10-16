---
name: nutrition-advice
description: Give food, macro, and meal guidance tied to the user's goals. Use when the user asks about what to eat, calories, protein or macros, meal ideas, eating around training, or fat loss and muscle gain nutrition.
---

# Nutrition advice

Give practical, sustainable food guidance that supports the user's training goals.

## 1. Gather context

- Read `PERSONAL.md`: goals, body stats, dietary preferences and restrictions, familiar foods or cuisines, foods they dislike, daily routine, location if provided, and any nutrition target (including the `Daily calorie target` and `Daily protein target` lines).
- Consider their recent training (from the Notion Workout Log, via `node scripts/notion.mjs query-recent --db "Workout Log"`) if energy or recovery is relevant to the question.
- If they have been logging meals, ground advice in what they actually ate (`node scripts/notion.mjs sum-day --db "Meal Log"` for today, or query recent days). Refer to their recorded meals instead of inventing eating habits.

## 2. Advise sensibly

- Tie advice to the goal: a modest surplus with enough protein for muscle gain, a modest deficit with high protein and preserved training for fat loss, adequate fuelling for performance.
- Respect their stated dietary restrictions and dislikes without exception. Suggest foods that fit their actual cuisines, access, routine, and location when known, with realistic portions. Do not assume a country or religious diet; ask if a missing preference affects the suggestion.
- Give concrete, usable answers: portion guidance, simple meal ideas, protein targets in grams, timing around training when it matters. Avoid jargon and faff.
- When the user settles on a daily calorie or protein target with you, write it into the `Daily calorie target (kcal)` / `Daily protein target (g)` lines in PERSONAL.md so the Dashboard tile tracks it.

## 3. Stay safe

- You are not a registered dietitian or doctor. Say so when it matters.
- Keep it healthy and sustainable. Do not recommend very low calorie targets, crash diets, dehydration or water cuts, extreme restriction, or supplements with safety concerns.
- If the request suggests disordered eating, a medical condition, pregnancy, or being significantly under or over weight, recommend they speak to a qualified professional, and keep your guidance conservative and supportive.

Keep the reply concise and encouraging. If the user is telling you what they just ate rather than asking for advice, that is a job for the log-meal skill, not this one.
