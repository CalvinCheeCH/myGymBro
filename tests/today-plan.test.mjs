import assert from "node:assert/strict";
import path from "node:path";
import { beforeEach, mock, test } from "node:test";

const config = { notionToken: "synthetic-token-not-a-credential", timezone: "Asia/Kuala_Lumpur" };
const executions = [];
let output = "";
let failure;
mock.module("../dist/config.js", { namedExports: { config } });
mock.module("../dist/agent/tooling.js", { namedExports: { PROJECT_ROOT: process.cwd() } });
mock.module("node:child_process", {
  namedExports: {
    execFile: (file, args, options, callback) => {
      executions.push({ file, args, options });
      callback(failure, output, "");
    },
  },
});
const { extractTodaySession, readTodayPlan } = await import("../dist/notion/today.js");
const MONDAY = "2026-10-19";
const wrapper =
  "Weekly Plan page: synthetic-id\n## Weekly Plan - 2026-10-18 · Saved 2026-10-18T10:00:00Z\n";

beforeEach(() => {
  config.notionToken = "synthetic-token-not-a-credential";
  config.timezone = "Asia/Kuala_Lumpur";
  executions.length = 0;
  output = "";
  failure = undefined;
});

test("reads the saved day section and preserves prescribed exercises without other days", () => {
  const plan = extractTodaySession(
    `${wrapper}# Week priority\nBuild steadily.\n## Sunday\nRest day.\n## Monday · Upper body\nBench 3 × 8 at 40 kg\n### Rows\n- 3 × 10 at 30 kg\n## Tuesday\nLower body`,
    MONDAY,
  );
  assert.equal(plan.status, "planned");
  assert.match(plan.text, /Monday · Upper body\nBench 3 × 8 at 40 kg\n### Rows/);
  assert.doesNotMatch(plan.text, /Sunday|Tuesday|Lower body|Week priority|synthetic-id/);
  assert.equal(
    extractTodaySession(`${wrapper}## Sunday\nRest day\n## Monday\nUpper`, "2026-10-18").status,
    "rest",
  );
});

test("matches abbreviated, ISO and existing day/month headings; explicit dates take precedence", () => {
  for (const heading of [
    "Mon · Upper body",
    "Mon. 19/10 · Upper body",
    "Monday 19/10/2026 · Upper body",
    "Mon 19/10/26 · Upper body",
    "2026-10-19 · Upper body",
    "Monday (2026-10-19) · Upper body",
    "**Monday** · Upper body",
  ]) {
    assert.equal(
      extractTodaySession(`## ${heading}\n- Bench 3 × 8`, MONDAY).status,
      "planned",
      heading,
    );
  }
  for (const heading of [
    "Monday 26/10/2026",
    "Tuesday 19/10/2026",
    "Monday / Wednesday",
    "Monday 19/10/2026 / Wednesday",
    "Monday 31/02/2026",
  ]) {
    assert.equal(
      extractTodaySession(`## ${heading}\nUpper body`, MONDAY).status,
      "missing",
      heading,
    );
  }
});

test("distinguishes an actual rest day from rest intervals in a training session", () => {
  for (const body of [
    "## Monday · Rest day\nOptional easy walk",
    "## Mon\nRest day. Resume tomorrow.",
    "## 2026-10-19 · Active recovery\nEasy walk",
  ]) {
    assert.equal(extractTodaySession(body, MONDAY).status, "rest");
  }
  assert.equal(
    extractTodaySession(
      "## Monday · Upper body\n- Bench 3 × 8\nRest 90 seconds between sets.",
      MONDAY,
    ).status,
    "planned",
  );
});

test("bare day headings with set-rest instructions remain planned sessions", () => {
  for (const instruction of [
    "Rest 90 seconds between sets.",
    "Rest 2 minutes between sets.",
    "Rest (90 seconds) between sets.",
    "Rest: 90 seconds between sets.",
    "Rest-pause bench sets below.",
  ]) {
    assert.equal(
      extractTodaySession(`## Monday\n${instruction}\n- Bench 3 × 8 at 40 kg`, MONDAY).status,
      "planned",
      instruction,
    );
  }
  for (const label of ["Rest", "Recovery", "Off", "Rest day", "Active recovery", "No workout"]) {
    assert.equal(
      extractTodaySession(`## Monday\n${label}\nOptional easy walk.`, MONDAY).status,
      "rest",
      label,
    );
  }
});
test("missing, duplicate, empty and fenced sections never fabricate a saved session", () => {
  for (const body of [
    "No saved plan found for this week.",
    "## Tuesday\n- Squats",
    "## Monday\n## Tuesday\n- Squats",
    "## Monday\n- Bench\n## Mon\n- Rows",
    "```markdown\n## Monday\n- Example bench\n```",
    "# Notes for 2026-10-19\nThis is not a daily session.",
  ])
    assert.deepEqual(extractTodaySession(body, MONDAY), { status: "missing", text: "" });
  assert.equal(extractTodaySession("## Monday\n- Bench", "2026-02-31").status, "missing");
});

test("canonical Day/Focus/Key work/Time tables retain all saved row values", () => {
  for (const separator of ["", "| --- | --- | --- | --- |\n"]) {
    const plan = extractTodaySession(
      `${wrapper}| Day | Focus | Key work | Time |\n${separator}| Sunday | Rest | Easy walk | Flexible |\n| Mon | Upper body | Bench 3 × 8 at 40 kg; rows 3 × 10 | 18:00, 45 min |\n| Tuesday | Lower body | Squat | 18:00 |`,
      MONDAY,
    );
    assert.equal(plan.status, "planned");
    assert.equal(
      plan.text,
      "Day: Mon\nFocus: Upper body\nKey work: Bench 3 × 8 at 40 kg; rows 3 × 10\nTime: 18:00, 45 min",
    );
  }
  assert.equal(extractTodaySession("| Day | Focus |\n| Mon | Rest day |", MONDAY).status, "rest");
});

test("named session columns determine rest status when table columns are reordered", () => {
  for (const header of ["Focus", "Session", "Workout", "**Activity**"]) {
    const table = `| Day | Time | ${header} |\n| Monday | 18:00 | Rest |`;
    assert.equal(extractTodaySession(table, MONDAY).status, "rest", header);
    assert.equal(
      extractTodaySession(
        `| Day | Time | ${header} |\n| Monday | 18:00 | Rest 90 seconds between sets; bench 3 × 8 |`,
        MONDAY,
      ).status,
      "planned",
      header,
    );
  }
  assert.equal(extractTodaySession("| Day | Notes |\n| Monday | Rest |", MONDAY).status, "rest");
});
test("table dates must agree and duplicate rows are ambiguous; full day headings take precedence", () => {
  assert.equal(
    extractTodaySession("| Date | Focus |\n| 19/10/2026 | Upper body |", MONDAY).status,
    "planned",
  );
  assert.equal(
    extractTodaySession("| Day | Date | Focus |\n| Mon | 2026-10-19 | Upper |", MONDAY).status,
    "planned",
  );
  for (const table of [
    "| Day | Focus |\n| Mon | Upper |\n| Monday | Lower |",
    "| Day | Date | Focus |\n| Mon | 2026-10-26 | Upper |",
    "| Day | Date | Focus |\n| Mon | TBD | Upper |",
    "| Focus | Day |\n| Upper | Mon | Extra |",
    "| Day | Focus |\n| Monday | |",
    "| Focus | Work |\n| Upper | Bench |",
  ])
    assert.equal(extractTodaySession(table, MONDAY).status, "missing", table);
  const preferred = extractTodaySession(
    "| Day | Focus |\n| Monday | Upper |\n\n## Monday · Upper body\n- Bench 3 × 8 at 40 kg",
    MONDAY,
  );
  assert.match(preferred.text, /Bench 3 × 8 at 40 kg/);
  assert.doesNotMatch(preferred.text, /Day:/);
});

test("bounds saved output without dropping the shortened-content notice", () => {
  const plan = extractTodaySession(
    `## Monday · Upper body\n${"- Bench detail\n".repeat(500)}`,
    MONDAY,
  );
  assert.equal(plan.status, "planned");
  assert.ok(plan.text.length <= 3000);
  assert.match(plan.text, /Saved session shortened/);
});

test("readTodayPlan uses the local day and its Sunday, including local Sunday rollover", async () => {
  output = "## Sunday\nRest day";
  let plan = await readTodayPlan("42", new Date("2026-10-17T16:05:00Z"));
  assert.deepEqual(plan, { status: "rest", date: "2026-10-18", text: "Sunday\nRest day" });
  assert.equal(executions[0].file, process.execPath);
  assert.deepEqual(executions[0].args, [
    path.join(process.cwd(), "scripts", "notion.mjs"),
    "weekly-plan",
    "--action",
    "show",
    "--week",
    "2026-10-18",
  ]);
  assert.equal(executions[0].options.timeout, 6000);
  assert.equal(executions[0].options.maxBuffer, 256 * 1024);
  assert.equal(executions[0].options.cwd, process.cwd());
  config.timezone = "America/Los_Angeles";
  output = "## Saturday\nLower body";
  plan = await readTodayPlan("42", new Date("2026-10-18T00:05:00Z"));
  assert.equal(plan.date, "2026-10-17");
  assert.equal(executions[1].args.at(-1), "2026-10-11");
});

test("unconfigured and genuinely missing plans stay distinct from bounded read failures", async () => {
  config.notionToken = "";
  assert.equal((await readTodayPlan("42", new Date("2026-10-19T00:00:00Z"))).status, "missing");
  assert.equal(executions.length, 0);
  config.notionToken = "synthetic-token-not-a-credential";
  output = "No saved plan found for this week.";
  assert.equal((await readTodayPlan("42", new Date("2026-10-19T00:00:00Z"))).status, "missing");
  for (const code of ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", 1]) {
    failure = Object.assign(new Error("Synthetic private error must not reach the reply"), {
      code,
    });
    output = "## Monday\nUntrusted partial output";
    const plan = await readTodayPlan("42", new Date("2026-10-19T00:00:00Z"));
    assert.deepEqual(plan, { status: "unavailable", date: MONDAY, text: "" });
  }
});
