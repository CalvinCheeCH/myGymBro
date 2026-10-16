import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { dashboardCaption, renderDashboardPng, renderDashboardSvg } from "./notion-dashboard.mjs";

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
  meals: [
    { occasion: "Breakfast", name: "Oats and yogurt", kcal: 410, protein: 24 },
    { occasion: "Lunch", name: "Chicken rice bowl", kcal: 650, protein: 42 },
  ],
  program: { name: "Strength & consistency" },
  goals: [{ title: "Bench target", current: 60, target: 70, unit: "kg" }],
});

test("overview uses recorded values, excluding future and skipped workouts", () => {
  const model = recorded();
  const svg = renderDashboardSvg(model);
  assert.match(svg, />3 \/ 4<\/text>/);
  assert.match(svg, />1,840 kcal<\/text>/);
  assert.match(svg, />112 g<\/text>/);
  assert.match(svg, />78\.5 kg<\/text>/);
  assert.match(svg, /168 recorded minutes this week/);
  assert.equal((svg.match(/data-chart="weekly-bar"/g) ?? []).length, 3);
  assert.equal((svg.match(/data-chart="weight"/g) ?? []).length, 1);
  assert.match(dashboardCaption(model), /3 sessions recorded this week, 168 recorded minutes/);
});

test("heatmap contains twelve actual calendar weeks and leaves future dates blank", () => {
  const svg = renderDashboardSvg(recorded());
  assert.equal((svg.match(/data-chart="heatmap-cell"/g) ?? []).length, 84);
  assert.match(svg, /data-date="2026-07-27" data-count="0"/);
  assert.match(svg, /data-date="2026-10-14" data-count="1"/);
  assert.match(svg, /data-date="2026-10-15" data-count="0"/);
  assert.match(svg, /data-date="2026-10-17" data-count=""/);
  assert.match(svg, /4 days with training recorded/);
});

test("known empty records stay distinct from unavailable history and assumed targets", () => {
  const unavailable = renderDashboardSvg({ date: "2026-10-16" });
  assert.match(unavailable, /Workout history could not be read/);
  assert.match(unavailable, /Nutrition records could not be read/);
  assert.match(unavailable, /Program unavailable/);
  const empty = renderDashboardSvg({
    date: "2026-10-16",
    workouts: [],
    bodyStats: [],
    meals: [],
    goals: [],
    program: null,
    nutrition: { date: "2026-10-16", records: 0, calories: 0, protein: 0 },
  });
  assert.match(empty, /No workouts recorded for this week/);
  assert.match(empty, /No meals recorded for this date/);
  assert.match(empty, /No active program recorded/);
  assert.match(empty, /No check-ins/);
  assert.doesNotMatch(empty, /NaN|Infinity|Strength &amp; consistency|0 \/ 4/);
  assert.equal((empty.match(/data-chart="weekly-bar"/g) ?? []).length, 0);
  assert.equal((empty.match(/data-chart="weight"/g) ?? []).length, 0);
});

test("duplicate training days combine measured duration without overflowing chart bounds", () => {
  const model = recorded();
  model.workouts.push({ date: "2026-10-14", duration: 90, sessions: 2 });
  model.workouts.push({ date: "2026-10-16", duration: null });
  const svg = renderDashboardSvg(model);
  assert.match(svg, /data-date="2026-10-14" data-count="3"/);
  assert.match(svg, /some durations missing/);
  for (const match of svg.matchAll(/data-chart="weekly-bar"[^>]*height="([\d.]+)"/g))
    assert.ok(Number(match[1]) <= 128);
  assert.match(svg, /258 recorded minutes/);
});

test("nutrition without targets does not invent percentages, and over-target values stay visible", () => {
  const model = recorded();
  model.nutrition.calorieTarget = null;
  model.nutrition.protein = 160;
  const svg = renderDashboardSvg(model);
  assert.match(svg, /Daily target not set/);
  assert.match(svg, /20 g above target/);
  assert.match(svg, /stroke-dasharray="169\.65 169\.65"/);
  assert.doesNotMatch(svg, /NaN|Infinity|pathLength/);
});

test("untrusted record names are escaped and selected dates cannot silently drift", () => {
  const model = recorded();
  model.program.name = '<script>alert("x")</script>';
  model.meals[0].name = "Rice & beans <large>";
  const svg = renderDashboardSvg(model);
  assert.doesNotMatch(svg, /<script>|<large>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /Rice &amp; beans &lt;large&gt;/);
  assert.throws(() => renderDashboardSvg({ date: "2026-02-30" }), /valid YYYY-MM-DD/);
  model.nutrition.date = "2026-10-15";
  assert.throws(() => renderDashboardSvg(model), /match the selected date/);
});

test("the single dashboard image renders locally as a valid 1200 by 980 PNG", async () => {
  const png = await renderDashboardPng(recorded());
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 980);
  assert.ok(png.length > 1000);
});
