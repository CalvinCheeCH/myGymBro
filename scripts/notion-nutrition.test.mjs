import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nutritionBlocks,
  nutritionCaption,
  renderNutritionSvg,
  summarizeNutrition,
  uploadNutritionImage,
} from "./notion-nutrition.mjs";

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
  const svg = renderNutritionSvg(result);
  assert.match(svg, /610 kcal remaining/);
  assert.match(svg, /28 g remaining/);
  assert.match(svg, /1,840/);
  assert.match(svg, /stroke-dasharray="135.72 169.65"/);
  assert.match(nutritionCaption(result), /2026-10-14/);
  const unknown = summarizeNutrition("2026-10-14", [{ kcal: Number.NaN, protein: 25 }]);
  assert.equal(unknown.calorieTarget, null);
  assert.equal(unknown.incomplete, true);
  assert.match(renderNutritionSvg(unknown), /target not set/);
  assert.doesNotMatch(renderNutritionSvg(unknown), /NaN|Infinity/);
});

test("zero and above-target rings stay honest and bounded", () => {
  const empty = summarizeNutrition("2026-10-14", []);
  assert.match(JSON.stringify(nutritionBlocks(empty, "sample")), /no recorded intake/);
  const above = summarizeNutrition("2026-10-14", [{ kcal: 2500, protein: 160 }], {
    calories: 2000,
    protein: 140,
  });
  assert.match(renderNutritionSvg(above), /500 kcal above/);
  assert.match(renderNutritionSvg(above), /stroke-dasharray="169.65 169.65"/);
  assert.throws(() => summarizeNutrition("<bad>", []), /YYYY-MM-DD/);
});

test("nutrition PNG is rendered locally and uploaded only through Notion API paths", async () => {
  const calls = [];
  const id = "11111111-1111-4111-8111-111111111111";
  const api = async (url, method, body, options) => {
    calls.push({ url, method, body, options });
    if (url === "/file_uploads") return { id };
    assert.ok(body instanceof FormData);
    const file = body.get("file");
    const bytes = new Uint8Array(await file.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    return { status: "uploaded" };
  };
  const summary = summarizeNutrition("2026-10-14", [{ kcal: 1840, protein: 112 }]);
  assert.equal(await uploadNutritionImage(api, summary), id);
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/file_uploads", `/file_uploads/${id}/send`],
  );
  assert.ok(calls.every((c) => c.options.version === "2026-03-11"));
  const brief = nutritionBlocks(summary, id);
  const detail = nutritionBlocks(summary, id, { detailed: true, dailyPageId: id });
  assert.equal(brief[0].image.caption[0].text.content, detail[0].image.caption[0].text.content);
  assert.match(JSON.stringify(detail), /One daily record/);
});
