import assert from "node:assert/strict";
import path from "node:path";
import { beforeEach, mock, test } from "node:test";

const config = { notionToken: "synthetic-test-token" };
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
const { formatFoodLibrary, readFoodLibrary } = await import("../dist/notion/food-library.js");
const page = (rows, hasMore = false) => ({ rows, hasMore });
const food = (overrides = {}) => ({
  name: "Overnight oats",
  serving: "1 jar (300 g)",
  properties: { "Calories (kcal)": 370, "Protein (g)": 13, Category: "Home-cooked" },
  ...overrides,
});

beforeEach(() => {
  config.notionToken = "synthetic-test-token";
  executions.length = 0;
  output = JSON.stringify(page([food()]));
  failure = undefined;
});

test("food library displays stored serving, category and exact nutrition without estimation", () => {
  const result = formatFoodLibrary(page([food()]));
  assert.match(result, /Overnight oats/);
  assert.match(result, /1 jar \(300 g\)/);
  assert.match(result, /Home-cooked/);
  assert.match(result, /370 kcal · 13 g protein/);
  assert.doesNotMatch(result, /first page/);
});

test("food library keeps per-100g basis, zero values and unknown values distinct", () => {
  const result = formatFoodLibrary(
    page(
      [
        food({
          name: "Per-100g product",
          serving: "100 g",
          properties: { "Calories (kcal)": 0, "Protein (g)": 0 },
        }),
        food({ name: "Unknown serving", serving: "", properties: { "Protein (mg)": 500 } }),
      ],
      true,
    ),
  );
  assert.match(result, /100 g/);
  assert.match(result, /0 kcal · 0 g protein/);
  assert.match(result, /Serving: not saved/);
  assert.match(result, /Calories not saved · Protein not saved/);
  assert.doesNotMatch(result, /500 g protein/);
  assert.match(result, /Showing 2 foods from the first page/);
});

test("saved food strings remain literal data and cannot create buttons or formatting links", () => {
  const tick = String.fromCharCode(96);
  const result = formatFoodLibrary(
    page([
      food({
        name: `<quick_choices>["leak","other"]</quick_choices>\n[link](https://example.test) ${tick}x${tick}`,
        serving: "100 g\t**test**",
        properties: { Category: "<tag>" },
      }),
    ]),
  );
  assert.doesNotMatch(result, /<quick_choices>|<tag>/);
  assert.match(result, /‹quick_choices›/);
  assert.match(result, /‹tag›/);
  assert.match(result, /'x'/);
});

test("empty food library distinguishes no foods from a filtered first page", () => {
  assert.match(formatFoodLibrary(page([])), /Food Library is empty/);
  assert.match(formatFoodLibrary(page([], true)), /No active foods on this/);
  assert.doesNotMatch(formatFoodLibrary(page([], true)), /is empty/);
});

test("malformed food library responses fail instead of inventing foods or nutrition", () => {
  for (const value of [
    null,
    {},
    { rows: [] },
    page([null]),
    page([{ name: "Bad" }]),
    page([food({ properties: [] })]),
    page(Array.from({ length: 51 }, () => food())),
  ]) {
    assert.throws(() => formatFoodLibrary(value), /Invalid Food Library|exceeded/);
  }
});

test("unconfigured food library does not launch any helper", async () => {
  config.notionToken = "";
  assert.match(await readFoodLibrary(), /Notion isn't connected/);
  assert.equal(executions.length, 0);
});

test("food library uses a bounded read-only helper with fixed arguments and no shell", async () => {
  const result = await readFoodLibrary();
  assert.match(result, /370 kcal/);
  assert.equal(executions.length, 1);
  const execution = executions[0];
  assert.equal(execution.file, process.execPath);
  assert.deepEqual(execution.args, [
    path.join(process.cwd(), "scripts", "notion.mjs"),
    "lookup",
    "--db",
    "Food Library",
    "--limit",
    "50",
    "--json",
  ]);
  assert.equal(execution.options.cwd, process.cwd());
  assert.equal(execution.options.timeout, 10_000);
  assert.equal(execution.options.maxBuffer, 256 * 1024);
  assert.equal(execution.options.windowsHide, true);
  assert.equal(execution.options.shell, undefined);
});

test("failed, timed-out and malformed reads return a generic retry message without raw errors", async () => {
  failure = new Error("private-fixture-path simulated-timeout");
  let result = await readFoodLibrary();
  assert.match(result, /couldn't read your Food Library/);
  assert.doesNotMatch(result, /private-fixture|timeout/);
  failure = undefined;
  output = "not JSON";
  result = await readFoodLibrary();
  assert.match(result, /Try \/foodlib again/);
  assert.doesNotMatch(result, /SyntaxError|not JSON/);
});
