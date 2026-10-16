import assert from "node:assert/strict";
import { test } from "node:test";
import { renderNutritionBlocks } from "./notion-dashboard-blocks.mjs";
import { nutritionCaption, summarizeNutrition } from "./notion-nutrition.mjs";

test("nutrition totals share one date and targets, without inventing missing data", () => {
  const result = summarizeNutrition(
    "2026-10-14",
    [
      { kcal: 1000, protein: 60 },
      { kcal: 840, protein: 52 },
    ],
    { calories: 2450, protein: 140 },
  );
  assert.equal(result.calories, 1840);
  assert.equal(result.protein, 112);
  const native = JSON.stringify(renderNutritionBlocks({ date: result.date, nutrition: result }));
  assert.match(native, /610 kcal remaining/);
  assert.match(native, /28 g remaining/);
  assert.match(native, /1,840/);
  assert.match(nutritionCaption(result), /2026-10-14/);
  const unknown = summarizeNutrition("2026-10-14", [{ kcal: Number.NaN, protein: 25 }]);
  assert.equal(unknown.calorieTarget, null);
  assert.equal(unknown.incomplete, true);
  const missing = JSON.stringify(renderNutritionBlocks({ date: unknown.date, nutrition: unknown }));
  assert.match(missing, /target not set/);
  assert.doesNotMatch(missing, /NaN|Infinity/);
});

test("zero and above-target rings stay honest and bounded", () => {
  const empty = summarizeNutrition("2026-10-14", []);
  assert.match(
    JSON.stringify(renderNutritionBlocks({ date: empty.date, nutrition: empty })),
    /No recorded intake|Zero recorded intake/,
  );
  const above = summarizeNutrition("2026-10-14", [{ kcal: 2500, protein: 160 }], {
    calories: 2000,
    protein: 140,
  });
  assert.match(
    JSON.stringify(renderNutritionBlocks({ date: above.date, nutrition: above })),
    /500 kcal above/,
  );
  assert.throws(() => summarizeNutrition("<bad>", []), /YYYY-MM-DD/);
});
