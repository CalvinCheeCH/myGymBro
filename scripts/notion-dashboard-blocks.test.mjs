import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboardBlocks, renderNutritionBlocks } from "./notion-dashboard-blocks.mjs";

const recorded = () => ({
  date: "2026-10-16",
  weekStart: "2026-10-11",
  workouts: [
    { date: "2026-10-12", duration: 52, focus: "Lower body" },
    { date: "2026-10-13", duration: 46, focus: "Upper body" },
    { date: "2026-10-14", duration: 70, focus: "Lower body" },
    { date: "2026-10-15", duration: 60, status: "Skipped" },
    { date: "2026-10-20", duration: 90 },
    { date: "2026-09-10", duration: 45 },
  ],
  trainingTarget: 4,
  nutrition: {
    date: "2026-10-16",
    records: 1,
    calories: 1840,
    protein: 112,
    calorieTarget: 2450,
    proteinTarget: 140,
    incomplete: false,
  },
  bodyStats: [
    { date: "2026-10-02", weight: 79.2 },
    { date: "2026-10-09", weight: 78.8 },
    { date: "2026-10-16", weight: 78.5 },
  ],
  meals: [{ occasion: "Breakfast", name: "Oats and yogurt", kcal: 410, protein: 24 }],
  program: { name: "Strength & consistency" },
  goals: [{ title: "Bench target", current: 60, target: 70, unit: "kg" }],
});

function flatten(blocks) {
  return blocks.flatMap((block) => [block, ...flatten(block[block.type]?.children ?? [])]);
}
function text(blocks) {
  return flatten(blocks)
    .map(
      (block) =>
        block[block.type]?.rich_text?.map((part) => part.text?.content ?? "").join("") ?? "",
    )
    .join("\n");
}

test("native dashboard uses editable blocks with recorded values, without uploaded media", () => {
  const blocks = renderDashboardBlocks(recorded());
  const all = flatten(blocks);
  const content = text(blocks);
  assert.equal(all.filter((block) => block.type === "column_list").length, 3);
  assert.equal(all.find((block) => block.type === "column_list").column_list.children.length, 4);
  assert.equal(all.filter((block) => block.type === "equation").length, 3);
  assert.ok(all.every((block) => !["image", "embed", "bookmark", "file"].includes(block.type)));
  assert.match(content, /3 \/ 4 sessions recorded/);
  assert.match(content, /1,840 \/ 2,450 kcal/);
  assert.match(content, /112 \/ 140 g/);
  assert.match(content, /78\.5 kg/);
  assert.match(content, /168 recorded minutes this week/);
  assert.match(content, /Oats and yogurt — 410 kcal; 24 g protein/);
  assert.match(content, /Bench target · 60 \/ 70 kg/);
  assert.doesNotMatch(content, /90 min|60 min|258 recorded/);
});

test("native rings have twelve segments and precise numbers outside their rounded visual", () => {
  const blocks = renderDashboardBlocks(recorded());
  const rings = flatten(blocks).filter((block) => block.type === "equation");
  for (const ring of rings) {
    assert.equal((ring.equation.expression.match(/\\bullet/g) ?? []).length, 12);
    assert.ok(ring.equation.expression.length < 1000);
    assert.match(ring.equation.expression, /\\begin\{array\}\{ccccc\}/);
  }
  assert.match(rings[0].equation.expression, /75\\%/);
  assert.match(text(blocks), /75\.1% of target/);
  assert.match(text(blocks), /80% of target/);
  assert.equal((rings[0].equation.expression.match(/#75A35A/g) ?? []).length, 9);
});

test("twelve calendar weeks show future days separately from missing and recorded sessions", () => {
  const blocks = renderDashboardBlocks(recorded());
  const lines = text(blocks).split("\n");
  const monday = lines.find((line) => line.startsWith("Mon  "));
  const thursday = lines.find((line) => line.startsWith("Thu  "));
  const saturday = lines.find((line) => line.startsWith("Sat  "));
  assert.match(text(blocks), /12 weeks · 27 Jul–18 Oct/);
  assert.equal(monday.match(/[□▪■▣·]/g).length, 12);
  assert.match(monday, /▪ $/);
  assert.match(thursday, /□ $/);
  assert.match(saturday, /· $/);
  assert.match(text(blocks), /4 days with training recorded/);
});

test("missing data stays unavailable and confirmed empty records do not invent intake or targets", () => {
  const missing = renderDashboardBlocks({ date: "2026-10-16" });
  const content = text(missing);
  assert.match(content, /Workout history could not be read/);
  assert.match(content, /Nutrition records could not be read/);
  assert.match(content, /Program unavailable/);
  assert.match(content, /Goals could not be read/);
  const rings = flatten(missing).filter((block) => block.type === "equation");
  assert.equal(rings.length, 3);
  assert.ok(rings.every((ring) => !ring.equation.expression.includes("\\%")));
  const empty = renderDashboardBlocks({
    date: "2026-10-16",
    workouts: [],
    bodyStats: [],
    meals: [],
    goals: [],
    program: null,
    nutrition: { date: "2026-10-16", records: 0, calories: 0, protein: 0 },
  });
  assert.match(text(empty), /No workouts recorded for this week/);
  assert.match(text(empty), /No meals recorded for this date/);
  assert.match(text(empty), /No active program recorded/);
  assert.match(text(empty), /No check-ins/);
  assert.match(text(empty), /Weekly target not set/);
  assert.doesNotMatch(text(empty), /NaN|Infinity|0 \/ 4|% of target/);
});

test("duplicate training days combine measured duration and preserve missing-duration labels", () => {
  const model = recorded();
  model.workouts.push({ date: "2026-10-14", duration: 90, sessions: 2 });
  model.workouts.push({ date: "2026-10-16", duration: null });
  const content = text(renderDashboardBlocks(model));
  assert.match(content, /6 \/ 4 sessions recorded/);
  assert.match(content, /160 min/);
  assert.match(content, /Logged · duration not recorded/);
  assert.match(content, /258 recorded minutes · some durations missing/);
  const wednesday = content.split("\n").find((line) => line.startsWith("Wed  "));
  assert.match(wednesday, /▣ $/);
});

test("nutrition without targets does not invent percentages and above-target numbers stay visible", () => {
  const model = recorded();
  model.nutrition.calorieTarget = null;
  model.nutrition.protein = 160;
  const blocks = renderDashboardBlocks(model);
  const content = text(blocks);
  assert.match(content, /Daily target not set/);
  assert.match(content, /20 g above target/);
  assert.match(content, /114\.3% of target/);
  const rings = flatten(blocks).filter((block) => block.type === "equation");
  assert.doesNotMatch(rings[1].equation.expression, /\\%/);
  assert.equal((rings[2].equation.expression.match(/#A18AC9/g) ?? []).length, 12);
});

test("meal summary shares Dashboard totals and supports only a safe daily page link", () => {
  const model = recorded();
  const blocks = renderNutritionBlocks(model, { dailyPageId: "123456781234123412341234567890ab" });
  const all = flatten(blocks);
  assert.match(text(blocks), /1,840 \/ 2,450 kcal/);
  assert.match(text(blocks), /112 \/ 140 g/);
  assert.match(text(blocks), /Dashboard and Meal Log use the same recorded totals/);
  assert.ok(all.every((block) => block.type !== "image"));
  const link = all
    .flatMap((block) => block[block.type]?.rich_text ?? [])
    .find((part) => part.text.link);
  assert.equal(link.text.link.url, "https://www.notion.so/123456781234123412341234567890ab");
  assert.throws(
    () => renderNutritionBlocks(model, { dailyPageId: "https://evil.invalid" }),
    /Notion page ID/,
  );
  model.nutrition.incomplete = true;
  assert.match(text(renderNutritionBlocks(model)), /missing nutrition values/);
});

test("record text remains plain data, invalid dates and mismatched nutrition are rejected", () => {
  const model = recorded();
  model.program.name = '<script>alert("x")</script>';
  model.meals[0].name = "Rice & beans <large>";
  const blocks = renderDashboardBlocks(model);
  assert.match(text(blocks), /<script>alert\("x"\)<\/script>/);
  assert.match(text(blocks), /Rice & beans <large>/);
  assert.ok(flatten(blocks).every((block) => block.object === "block"));
  assert.throws(() => renderDashboardBlocks({ date: "2026-02-30" }), /valid YYYY-MM-DD/);
  model.nutrition.date = "2026-10-15";
  assert.throws(() => renderDashboardBlocks(model), /match the selected date/);
});

test("long record text is split at Notion rich-text boundaries without losing content", () => {
  const model = recorded();
  model.meals[0].name = `${"x".repeat(1999)}🥣${"y".repeat(2500)}`;
  const blocks = renderDashboardBlocks(model);
  assert.ok(text(blocks).includes(model.meals[0].name));
  for (const item of flatten(blocks))
    for (const part of item[item.type]?.rich_text ?? []) {
      assert.ok(part.text.content.length <= 2000);
      assert.doesNotMatch(part.text.content, /[\uD800-\uDBFF]$/);
      assert.doesNotMatch(part.text.content, /^[\uDC00-\uDFFF]/);
    }
});
