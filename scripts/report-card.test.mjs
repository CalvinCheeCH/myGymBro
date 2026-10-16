import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
  addDaysKL,
  assertReportOutputPath,
  classifyExercise,
  formatWeekTitle,
  parseWeekBody,
  sundayStartKL,
  weekdayIdxKL,
} from "./report-card.mjs";

test("report output and archive paths reject file links and redirected parent directories", (t) => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "report-paths-")));
  t.after(() => {
    assert.equal(path.dirname(fixture), fs.realpathSync(os.tmpdir()));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const data = path.join(fixture, "data");
  const archived = path.join(data, "report-cards", "2026-10-04-weekly.png");
  const output = path.join(data, "report-card.png");
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.writeFileSync(output, "synthetic output");
  fs.writeFileSync(archived, "synthetic archive");
  assert.doesNotThrow(() => assertReportOutputPath(output));
  assert.doesNotThrow(() => assertReportOutputPath(archived));
  assert.doesNotThrow(() => assertReportOutputPath(path.join(data, "new", "report.png")));

  const lstat = fs.lstatSync;
  const directoryLink = path.join(data, "linked");
  const linkedPaths = new Set([output, archived, path.join(data, "dangling.png"), directoryLink]);
  // Windows sandboxes may forbid creating links; only their filesystem metadata is mocked.
  const statMock = mock.method(fs, "lstatSync", (target, options) =>
    linkedPaths.has(target) ? { isSymbolicLink: () => true } : lstat(target, options),
  );
  try {
    for (const target of linkedPaths) {
      assert.throws(() => assertReportOutputPath(target), /must not contain symbolic links/);
    }
    assert.throws(
      () => assertReportOutputPath(path.join(directoryLink, "new", "report.png")),
      /must not contain symbolic links/,
    );
  } finally {
    statMock.mock.restore();
  }

  assert.equal(fs.readFileSync(output, "utf8"), "synthetic output");
  assert.equal(fs.readFileSync(archived, "utf8"), "synthetic archive");
});

test("week helpers: Sun-Sat calendar weeks", () => {
  assert.equal(weekdayIdxKL("2026-09-05"), 6); // Saturday
  assert.equal(weekdayIdxKL("2026-09-06"), 0); // Sunday
  assert.equal(sundayStartKL("2026-09-05"), "2026-08-30");
  assert.equal(sundayStartKL("2026-09-06"), "2026-09-06");
  assert.equal(addDaysKL("2026-08-30", 6), "2026-09-05");
});

test("report dates stay stable across timezones and daylight saving", () => {
  const moduleUrl = new URL("./report-card.mjs", import.meta.url).href;
  for (const [timezone, midnight, noon] of [
    ["Etc/UTC", "2026-10-08", "2026-10-08"],
    ["Pacific/Kiritimati", "2026-10-08", "2026-10-09"],
    ["America/New_York", "2026-10-07", "2026-10-08"],
  ]) {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';
         const { addDaysKL, dayKeyKL, sundayStartKL } = await import(${JSON.stringify(moduleUrl)});
         assert.equal(dayKeyKL('2026-10-08'), '2026-10-08');
         assert.equal(dayKeyKL('2026-10-08T00:00:00Z'), ${JSON.stringify(midnight)});
         assert.equal(dayKeyKL('2026-10-08T12:00:00Z'), ${JSON.stringify(noon)});
         assert.equal(addDaysKL('2026-10-08', 0), '2026-10-08');
         assert.equal(addDaysKL('2026-10-08', 1), '2026-10-09');
         assert.equal(sundayStartKL('2026-10-08'), '2026-10-04');
         assert.equal(addDaysKL('2026-03-07', 1), '2026-03-08');
         assert.equal(addDaysKL('2026-03-08', 1), '2026-03-09');
         assert.equal(addDaysKL('2028-02-28', 1), '2028-02-29');`,
      ],
      { env: { ...process.env, TIMEZONE: timezone }, stdio: "pipe" },
    );
  }
});

test("parseWeekBody: headings plus weight x reps bullets", () => {
  const md =
    "## DB Bench Press\n- 10kg x 12, 12kg x 12, 12kg x 10\n## Lat Pull Down\n- 23kg x 12, 32kg x 12";
  assert.deepEqual(
    parseWeekBody(md, null).flatMap((section) => section.exercises),
    [
      {
        exercise: "DB Bench Press",
        bestW: 12,
        bestR: 12,
        vol: 384,
        sets: 3,
        pairs: [
          { w: 10, r: 12 },
          { w: 12, r: 12 },
          { w: 12, r: 10 },
        ],
      },
      {
        exercise: "Lat Pull Down",
        bestW: 32,
        bestR: 12,
        vol: 660,
        sets: 2,
        pairs: [
          { w: 23, r: 12 },
          { w: 32, r: 12 },
        ],
      },
    ],
  );
});

test("parseWeekBody: trailing sets-count expands pairs, lb converts", () => {
  const md = "## Squat\n- 80kg x 5 x 5\n## Curl\n- 30lb x 10\n## Pull-ups\n- 10, 12";
  const out = parseWeekBody(md, null).flatMap((section) => section.exercises);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    exercise: "Squat",
    bestW: 80,
    bestR: 5,
    vol: 2000,
    sets: 5,
    pairs: [
      { w: 80, r: 5 },
      { w: 80, r: 5 },
      { w: 80, r: 5 },
      { w: 80, r: 5 },
      { w: 80, r: 5 },
    ],
  });
  assert.ok(Math.abs(out[1].bestW - 13.6) < 0.01);
  assert.equal(out[1].sets, 1);
});

test("parseWeekBody: lb/lbs normalize both body formats without changing metric loads", () => {
  for (const [weight, expected] of [
    ["100lb", 45.4],
    ["100lbs", 45.4],
    ["100 LBS", 45.4],
    ["100kg", 100],
    ["100", 100],
  ]) {
    for (const body of [`Bench 3x10 @${weight}`, `## Bench\n- ${weight} x 10 x 3`]) {
      const exercises = parseWeekBody(body, null).flatMap((section) => section.exercises);
      assert.equal(exercises.length, 1, body);
      assert.equal(exercises[0].bestW, expected, body);
      assert.equal(exercises[0].bestR, 10, body);
      assert.equal(exercises[0].sets, 3, body);
    }
  }
});

test("classifyExercise: keywords beat the row's tags, compounds first", () => {
  assert.equal(classifyExercise("Lat Pull Down"), "Back");
  assert.equal(classifyExercise("Tricep Push Down"), "Triceps");
  assert.equal(classifyExercise("DB Bench Press"), "Chest");
  assert.equal(classifyExercise("BB Squat"), "Legs");
  assert.equal(classifyExercise("Hill run 84m"), "Conditioning");
  assert.equal(classifyExercise("Lateral Raise"), "Shoulders");
  assert.equal(classifyExercise("Mystery Machine"), null);
});

test("parseWeekBody: day headings are markers, never exercises", () => {
  const md =
    "## Tue 1/9 - Leg Day\n### Squat\n- 80kg x 5 x 5\n## Fri 4/9 - Upper Body\n### Bench\n- 60kg x 8";
  const out = parseWeekBody(md, null).flatMap((section) => section.exercises);
  assert.equal(out.length, 2);
  assert.equal(out[0].exercise, "Squat");
  assert.equal(out[1].exercise, "Bench");
});

test("parseWeekBody: groups exercises under day sections with keys", () => {
  const md =
    "## Tue 1/9 - Leg Day\n### Squat\n- 80kg x 5\n## Tue 1/9 - Leg Day\n### Squat\n- 80kg x 5";
  const secs = parseWeekBody(md, "2026-08-30");
  assert.equal(secs.length, 1);
  assert.equal(secs[0].header, "Tue 1/9 - Leg Day");
  assert.equal(secs[0].key, "2026-09-01");
  assert.equal(secs[0].exercises.length, 1);
  assert.equal(secs[0].exercises[0].sets, 2);
});

test("parseWeekBody: legacy bodies land in one untitled section", () => {
  const secs = parseWeekBody("## Squat\n- 80kg x 5", "2026-09-01");
  assert.equal(secs.length, 1);
  assert.equal(secs[0].header, null);
  assert.equal(secs[0].key, "2026-09-01");
});

test("parseWeekBody: **Top-up Day d/m** marker attributes to that day, no new section", () => {
  const md =
    "## Tue 1/9 - Leg Day\n### Squat\n- 80kg x 5\n**Top-up Tue 1/9**\n### Squat\n- 80kg x 5";
  const secs = parseWeekBody(md, "2026-08-30");
  assert.equal(secs.length, 1);
  assert.equal(secs[0].header, "Tue 1/9 - Leg Day");
  assert.equal(secs[0].key, "2026-09-01");
  assert.equal(secs[0].exercises.length, 1);
  assert.equal(secs[0].exercises[0].sets, 2);
});

test("parseWeekBody: top-up for an unseen day opens a plain day section", () => {
  const md = "**Top-up Fri 19/9**\n### Squats\n- 10kg x 12";
  const secs = parseWeekBody(md, "2026-09-13");
  assert.equal(secs.length, 1);
  assert.equal(secs[0].header, "Fri 19/9");
  assert.equal(secs[0].key, "2026-09-19");
  assert.equal(secs[0].exercises[0].exercise, "Squats");
});

test("formatWeekTitle: week label", () => {
  assert.equal(formatWeekTitle("2026-08-30", 2), "Week 2: 30/8/2026 - 5/9/2026");
  assert.equal(formatWeekTitle("2026-08-30", null), "Week of 30/8/2026 - 5/9/2026");
});
