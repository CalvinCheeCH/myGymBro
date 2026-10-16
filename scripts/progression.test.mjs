import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestEpley,
  calculatePlates,
  deloadLoad,
  detectStall,
  distinctNames,
  estimate1RM,
  heatCell,
  matchesExercise,
  nextDouble,
  nextLinear,
  parseLifts,
  parseSetPairs,
  renderHeatmapGrid,
  renderStreaks,
  round05,
  round25,
  sessionsForExercise,
} from "./progression.mjs";

// ─── parsing ─────────────────────────────────────────────────────────────────

test("parseSetPairs: lb/lbs convert to kg without changing metric or unitless loads", () => {
  for (const [weight, expected] of [
    ["100lb", 45.4],
    ["100lbs", 45.4],
    ["100 LBS", 45.4],
    ["22.5lbs", 10.2],
    ["100kg", 100],
    ["100 KG", 100],
    ["100", 100],
  ]) {
    assert.deepEqual(parseSetPairs(`${weight} x 10 x 3`), [{ w: expected, r: 10, n: 3 }], weight);
  }
});

test("parseLifts: inline and heading loads agree for imperial, metric and unitless inputs", () => {
  for (const [weight, expected] of [
    ["100lb", 45.4],
    ["100lbs", 45.4],
    ["100 LBS", 45.4],
    ["22.5lbs", 10.2],
    ["100kg", 100],
    ["100 KG", 100],
    ["100", 100],
  ]) {
    const lift = { name: "Bench", sets: 3, reps: 10, load: expected, day: null };
    assert.deepEqual(parseLifts(`Bench 3x10 @${weight}`), [lift], weight);
    assert.deepEqual(parseLifts(`## Bench\n- ${weight} x 10 x 3`), [lift], weight);
  }
});

test("sessionsForExercise: pounds do not outrank a heavier metric top set", () => {
  const { sessions, allSets } = sessionsForExercise(
    [{ date: "2026-10-16", body: "Bench 3x10 @100lb\n## Bench\n- 50kg x 10" }],
    "Bench",
  );
  assert.equal(sessions[0].load, 50);
  assert.deepEqual(
    allSets.map((set) => set.load),
    [45.4, 50],
  );
});

test("parseLifts: reads the canonical 'Name SxR @Load kg' lines, multiple per body", () => {
  const lifts = parseLifts("Squat 5x5 @80kg\nBench 3x8 @60 ; RDL 3x8@70kg");
  assert.equal(lifts.length, 3);
  assert.deepEqual(lifts[0], { name: "Squat", sets: 5, reps: 5, load: 80, day: null });
  assert.deepEqual(lifts[1], { name: "Bench", sets: 3, reps: 8, load: 60, day: null });
  assert.deepEqual(lifts[2], { name: "RDL", sets: 3, reps: 8, load: 70, day: null });
});

test("parseLifts: sets without a stated load still parse with load null", () => {
  const lifts = parseLifts("Pull-ups 4x8");
  assert.deepEqual(lifts, [{ name: "Pull-ups", sets: 4, reps: 8, load: null, day: null }]);
});

test("parseLifts: heading-carried pairs from current log bodies", () => {
  const lifts = parseLifts(
    "## DB Bench Press\n- 10kg x 12, 12kg x 12\n### Lat Pull Down\n- 23kg x 12",
  );
  assert.deepEqual(lifts, [
    { name: "DB Bench Press", sets: 1, reps: 12, load: 10, day: null },
    { name: "DB Bench Press", sets: 1, reps: 12, load: 12, day: null },
    { name: "Lat Pull Down", sets: 1, reps: 12, load: 23, day: null },
  ]);
});

test("parseLifts: day sections mark the day, trailing sets-count expands", () => {
  const lifts = parseLifts("## Tue 1/9 - Leg Day\n### Squat\n- 80kg x 5 x 5");
  assert.deepEqual(lifts, [
    { name: "Squat", sets: 5, reps: 5, load: 80, day: "Tue 1/9 - Leg Day" },
  ]);
});

test("parseLifts: orphan pairs without a heading are skipped", () => {
  assert.deepEqual(parseLifts("- 80kg x 12"), []);
});

test("parseLifts: multi-word names survive", () => {
  assert.equal(parseLifts("Hip thrust 3x10 @40kg")[0].name, "Hip thrust");
});

test("matchesExercise: case-insensitive containment", () => {
  assert.equal(matchesExercise("Barbell squat", "SQUAT"), true);
  assert.equal(matchesExercise("Leg press", "squat"), false);
});

// ─── estimated 1RM ───────────────────────────────────────────────────────────

test("estimate1RM: Epley rounded to half a kilo", () => {
  assert.equal(estimate1RM(100, 1), 103.5); // 103.33 -> 103.5
  assert.equal(estimate1RM(100, 6), 120);
  assert.equal(round05(103.33), 103.5);
});

test("estimate1RM: refuses reps above the cap or nonsense input", () => {
  assert.equal(estimate1RM(100, 13), null);
  assert.equal(estimate1RM(null, 5), null);
  assert.equal(estimate1RM(80, 0), null);
});

test("bestEpley: picks the highest estimate and keeps its provenance", () => {
  const best = bestEpley([
    { load: 80, reps: 8, date: "2026-08-01" }, // 101.5
    { load: 100, reps: 5, date: "2026-08-10" }, // 116.5
    { load: 102.5, reps: 3, date: "2026-08-15" }, // 112.75 -> rounds 113
  ]);
  assert.equal(best.estimate, 116.5);
  assert.equal(best.load, 100);
  assert.equal(best.date, "2026-08-10");
});

// ─── progression rules ───────────────────────────────────────────────────────

const s = (load, reps, date) => ({ load, reps, sets: 3, date });

test("nextLinear: increase on target reached, hold when missed", () => {
  const up = nextLinear([s(90, 5)], { targetReps: 5 });
  assert.equal(up.action, "increase");
  assert.equal(up.load, 92.5);
  const hold = nextLinear([s(90, 4)], { targetReps: 5 });
  assert.equal(hold.action, "hold");
  assert.equal(hold.load, 90);
});

test("nextDouble: add at top of range, hold inside and below", () => {
  const add = nextDouble([s(70, 8)], { repMin: 5, repMax: 8 });
  assert.equal(add.action, "increase");
  assert.equal(add.load, 72.5);
  const mid = nextDouble([s(70, 6)], {});
  assert.equal(mid.action, "hold");
  assert.match(mid.reason, /inside the 5-8 range/);
  const low = nextDouble([s(70, 3)], {});
  assert.equal(low.action, "hold");
  assert.match(low.reason, /below the 5-8 range/);
});

test("detectStall: same load three sessions running, otherwise quiet", () => {
  const stuck = detectStall([s(90, 5), s(90, 5), s(90, 4)]);
  assert.deepEqual(stuck, { load: 90, sessions: 3 });
  assert.equal(detectStall([s(90, 5), s(92.5, 5), s(90, 5)]), null);
  assert.equal(detectStall([s(90, 5), s(90, 5)]), null);
});

test("deloadLoad: ten percent off snapped to plates", () => {
  assert.equal(deloadLoad(100), 90);
  assert.equal(deloadLoad(95), 85);
  assert.equal(deloadLoad(72.5), 65);
});

// ─── plate math ──────────────────────────────────────────────────────────────

test("calculatePlates: exact breakdown for 62.5 on a 20kg bar", () => {
  const r = calculatePlates(62.5, { bar: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.exact, true);
  assert.deepEqual(r.perSide, [20, 1.25]);
  assert.equal(r.achievable, 62.5);
  assert.equal(r.note, null);
});

test("calculatePlates: reports the nearest achievable load when not exact", () => {
  const r = calculatePlates(63, { bar: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.exact, false);
  assert.equal(r.achievable, 62.5);
  assert.match(r.note, /closest barbell load is 62\.5kg/);
});

test("calculatePlates: lighter than the bar is an error", () => {
  const r = calculatePlates(15, { bar: 20 });
  assert.equal(r.ok, false);
  assert.match(r.error, /lighter than the 20kg bar/);
});

// ─── consistency squares ─────────────────────────────────────────────────────

test("renderStreaks: monday-start rows, counts, and a total", () => {
  // 2026-08-26 is a Wednesday; its Monday is 2026-08-24.
  const out = renderStreaks(["2026-08-18", "2026-08-24"], {
    weeks: 2,
    today: new Date("2026-08-26T00:00:00Z"),
  });
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^w\/c 2026-08-17: ⬜🟩⬜⬜⬜⬜⬜ \(1\)$/);
  assert.match(lines[1], /^w\/c 2026-08-24: 🟩⬜⬜⬜⬜⬜⬜ \(1\)$/);
  assert.match(lines[2], /Total: 2 sessions over 2 weeks/);
});

test("renderStreaks: empty log renders blank weeks", () => {
  const out = renderStreaks([], { weeks: 1, today: new Date("2026-08-26T00:00:00Z") });
  assert.match(out, /^w\/c 2026-08-24: ⬜⬜⬜⬜⬜⬜⬜ \(0\)/);
  assert.match(out, /Total: 0 sessions/);
});

// ─── workout calendar heatmap ────────────────────────────────────────────────

test("heatCell: intensity buckets for 0, 1, 2, 3, then 4+", () => {
  assert.equal(heatCell(0), "⬜");
  assert.equal(heatCell(1), "🟩");
  assert.equal(heatCell(2), "🟨");
  assert.equal(heatCell(3), "🟧");
  assert.equal(heatCell(4), "🟥");
  assert.equal(heatCell(9), "🟥");
});

test("renderHeatmapGrid: monday-start table, duplicate dates count, totals row", () => {
  // 2026-08-28 is a Friday; its Monday is 2026-08-24. Window is two weeks:
  // w/c 2026-08-17 and w/c 2026-08-24 (the week containing `today`).
  const out = renderHeatmapGrid(["2026-08-19", "2026-08-24", "2026-08-24", "2026-08-27"], {
    weeks: 2,
    today: new Date("2026-08-28T00:00:00Z"),
  });
  const lines = out.split("\n");
  assert.equal(lines.length, 14); // legend, blank, header, divider, 7 days, totals, blank, summary
  assert.match(lines[2], /^\| Day \| w\/c 17\/08 \| w\/c 24\/08 \|$/);
  // Monday row: week 1 (2026-08-17) rests, week 2 (2026-08-24) has two sessions.
  assert.match(lines[4], /^\| Mon \| ⬜ \| 🟨 \|$/);
  // Wednesday row: week 1 (2026-08-19) = 1 session.
  assert.match(lines[6], /^\| Wed \| 🟩 \| ⬜ \|$/);
  // Thursday row: week 2 (2026-08-27) = 1 session.
  assert.match(lines[7], /^\| Thu \| ⬜ \| 🟩 \|$/);
  assert.match(lines[11], /^\| Total \| 1 \| 3 \|$/);
  assert.match(lines[13], /4 sessions in the last 2 weeks/);
});

test("renderHeatmapGrid: empty log is a blank grid", () => {
  const out = renderHeatmapGrid([], { weeks: 1, today: new Date("2026-08-28T00:00:00Z") });
  assert.match(out, /^\| Total \| 0 \|$/m);
  assert.match(out, /0 sessions in the last 1 weeks/);
});

// ─── session grouping over parsed bodies ─────────────────────────────────────

test("sessionsForExercise: filters to the exercise, oldest first, tracks all sets", () => {
  const rows = [
    { date: "2026-08-10", title: "Lower A", body: "Squat 5x5 @90kg; Leg curl 3x10 @40kg" },
    { date: "2026-08-03", title: "Lower B", body: "Squat 5x5 @87.5kg" },
    { date: "2026-08-05", title: "Upper A", body: "Bench 4x6 @70kg" },
  ];
  const { sessions, allSets } = sessionsForExercise(rows, "squat");
  assert.deepEqual(
    sessions.map((x) => [x.date, x.load, x.reps]),
    [
      ["2026-08-03", 87.5, 5],
      ["2026-08-10", 90, 5],
    ],
  );
  assert.equal(allSets.length, 2);
});

test("distinctNames: unique sorted exercise names from bodies", () => {
  const names = distinctNames([
    { body: "Squat 5x5 @90kg; leg curl 3x10 @40kg" },
    { body: "Squat 3x5 @95kg; Bench 5x5 @70kg" },
    { body: "no numbers here" },
  ]);
  assert.deepEqual(names, ["Bench", "Squat", "leg curl"]);
});
