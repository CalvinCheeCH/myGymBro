import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const originalCwd = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-meal-"));
const priorToken = process.env.NOTION_TOKEN;
process.env.NOTION_TOKEN = "test-notion-token";
process.chdir(fixture);
const { cmdLogMeal } = await import("./notion.mjs");
process.chdir(originalCwd);
if (priorToken === undefined) Reflect.deleteProperty(process.env, "NOTION_TOKEN");
else process.env.NOTION_TOKEN = priorToken;
after(() => {
  assert.equal(path.dirname(fixture), os.tmpdir());
  fs.rmSync(fixture, { recursive: true, force: true });
});

const HUB = "11111111111111111111111111111111";
const DB = "22222222222222222222222222222222";
const DATE = "2026-10-16";
const rich = (value) => [{ type: "text", text: { content: value }, plain_text: value }];
const select = (values) => ({
  type: "select",
  select: { options: values.map((name) => ({ name })) },
});
const schema = {
  Meal: { type: "title" },
  Date: { type: "date" },
  "Meal Type": select(["Breakfast", "Lunch", "Tea", "Dinner", "Supper"]),
  "Calories (kcal)": { type: "number" },
  "Protein (g)": { type: "number" },
  "Carbs (g)": { type: "number" },
  "Fat (g)": { type: "number" },
  Source: select(["Text", "Voice", "Photo", "Label"]),
  Notes: { type: "rich_text" },
};
const normalize = (properties) =>
  Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      { type: schema[name].type, ...value },
    ]),
  );
const heading = (id, title) => ({ id, type: "heading_2", heading_2: { rich_text: rich(title) } });
const bullet = (id, title) => ({
  id,
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: rich(title) },
});
let rows;
let blocks;
let requests;
let sequence;

beforeEach(() => {
  fs.mkdirSync(path.join(fixture, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "data", "notion-ids.json"),
    JSON.stringify({ __hub: HUB, "Meal Log": DB }),
  );
  rows = [];
  blocks = new Map();
  requests = [];
  sequence = 0;
});

function addDailyRow(
  id = "existing-row",
  body = [heading("breakfast", "Breakfast"), bullet("old-meal", "Existing breakfast")],
) {
  rows.push({
    id,
    parent: { database_id: DB },
    properties: normalize({
      Meal: { title: rich("16/10/26 (Friday)") },
      Date: { date: { start: DATE } },
      "Calories (kcal)": { number: 450 },
      "Protein (g)": { number: 25 },
      "Meal Type": { select: { name: "Breakfast" } },
      Source: { select: { name: "Text" } },
    }),
  });
  blocks.set(id, structuredClone(body));
}

function mealArgs(extra = {}) {
  return {
    date: DATE,
    set: ["Meal Type=Dinner", "Calories (kcal)=180", "Protein (g)=36", "Source=Label"],
    body: "## Dinner\n- Sample whey, 1.5 servings (180 kcal / 36 g protein)",
    ...extra,
  };
}

function mockNotion(t, fail = () => false) {
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const pathname = new URL(url).pathname.replace(/^\/v1/, "");
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    const request = { pathname, method, body, version: options.headers["Notion-Version"] };
    requests.push(request);
    const status = fail(request);
    if (status) return Response.json({ message: "synthetic failure" }, { status });
    if (pathname === `/databases/${DB}` && method === "GET") {
      return Response.json({
        id: DB,
        parent: { page_id: HUB },
        title: rich("Meal Log"),
        properties: schema,
      });
    }
    if (pathname === `/databases/${DB}/query` && method === "POST") {
      return Response.json({ results: rows, has_more: false });
    }
    if (pathname === "/pages" && method === "POST") {
      const id = `meal-row-${++sequence}`;
      const row = { id, parent: body.parent, properties: normalize(body.properties) };
      rows.push(row);
      blocks.set(id, []);
      return Response.json(row);
    }
    const rowMatch = /^\/pages\/([^/]+)$/.exec(pathname);
    if (rowMatch && method === "PATCH") {
      const row = rows.find((item) => item.id === rowMatch[1]);
      assert.ok(row, "updated row must exist");
      Object.assign(row.properties, normalize(body.properties));
      return Response.json(row);
    }
    const children = /^\/blocks\/([^/]+)\/children$/.exec(pathname);
    if (children && method === "GET")
      return Response.json({ results: blocks.get(children[1]) ?? [], has_more: false });
    if (children && method === "PATCH") {
      const current = blocks.get(children[1]);
      assert.ok(current, "meal body target must exist");
      const added = body.children.map((block) => ({ id: `block-${++sequence}`, ...block }));
      const index =
        body.position?.type === "start"
          ? 0
          : body.after
            ? current.findIndex((block) => block.id === body.after) + 1
            : current.length;
      assert.ok(!body.after || index > 0, "meal insertion anchor must exist");
      current.splice(index, 0, ...added);
      return Response.json({ results: added });
    }
    throw new Error(`Unexpected Notion request: ${method} ${pathname}`);
  });
}

const writes = () =>
  requests.filter(
    (request) =>
      request.method === "PATCH" || (request.method === "POST" && request.pathname === "/pages"),
  );

test("one meal command creates the canonical daily row, saves details and returns reread totals without visual work", async (t) => {
  mockNotion(t);
  const result = await cmdLogMeal(mealArgs());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].properties.Meal.title[0].text.content, "16/10/26 (Friday)");
  assert.equal(result.pageId, rows[0].id);
  assert.equal(result.date, DATE);
  assert.equal(result.totals["Calories (kcal)"], 180);
  assert.equal(result.totals["Protein (g)"], 36);
  assert.equal(requests.filter((request) => request.pathname.endsWith("/query")).length, 2);
  assert.ok(
    requests.every(
      (request) =>
        request.pathname === `/databases/${DB}` ||
        request.pathname === `/databases/${DB}/query` ||
        request.pathname === "/pages" ||
        request.pathname === `/blocks/${result.pageId}/children`,
    ),
  );
  assert.deepEqual(
    blocks.get(result.pageId).map((block) => block.type),
    ["heading_2", "bulleted_list_item"],
  );
});

test("later meals add values to the one daily row and preserve all previous blocks", async (t) => {
  addDailyRow();
  rows[0].properties.Notes = { type: "rich_text", rich_text: rich("Keep the earlier note") };
  const previous = structuredClone(blocks.get("existing-row"));
  mockNotion(t);
  const result = await cmdLogMeal(mealArgs({ set: [...mealArgs().set, "Notes=New meal note"] }));
  assert.equal(rows.length, 1);
  assert.equal(result.totals["Calories (kcal)"], 630);
  assert.equal(result.totals["Protein (g)"], 61);
  assert.deepEqual(blocks.get("existing-row").slice(0, 2), previous);
  assert.equal(
    rows[0].properties.Notes.rich_text[0].text.content,
    "Keep the earlier note\nNew meal note",
  );
  assert.equal(
    requests.filter((request) => request.method === "POST" && request.pathname === "/pages").length,
    0,
  );
});

test("repeat eating occasions reuse their heading and insert before the next occasion", async (t) => {
  addDailyRow("existing-row", [
    heading("breakfast", "Breakfast"),
    bullet("old-breakfast", "Old breakfast"),
    heading("dinner", "Dinner"),
    bullet("old-dinner", "Old dinner"),
  ]);
  mockNotion(t);
  await cmdLogMeal(
    mealArgs({
      set: ["Meal Type=Breakfast", "Calories (kcal)=120", "Protein (g)=24", "Source=Label"],
      body: "## Breakfast\n- Another serving",
    }),
  );
  const body = blocks.get("existing-row");
  assert.equal(body.filter((block) => block.type === "heading_2").length, 2);
  assert.deepEqual(
    body.map((block) => block.id).filter((id) => !id.startsWith("block-")),
    ["breakfast", "old-breakfast", "dinner", "old-dinner"],
  );
  assert.equal(body[2].bulleted_list_item.rich_text[0].text.content, "Another serving");
});

test("a forgotten breakfast is prepended before lunch using the scoped current API version", async (t) => {
  addDailyRow("existing-row", [heading("lunch", "Lunch"), bullet("old-lunch", "Old lunch")]);
  mockNotion(t);
  await cmdLogMeal(
    mealArgs({
      set: ["Meal Type=Breakfast", "Calories (kcal)=120", "Protein (g)=24", "Source=Label"],
      body: "- Breakfast",
    }),
  );
  const append = requests.find(
    (request) => request.pathname === "/blocks/existing-row/children" && request.method === "PATCH",
  );
  assert.deepEqual(append.body.position, { type: "start" });
  assert.equal(append.version, "2026-03-11");
  assert.equal(blocks.get("existing-row")[0].heading_2.rich_text[0].text.content, "Breakfast");
  assert.equal(blocks.get("existing-row")[2].id, "lunch");
});

test("multiple daily rows are refused without changing either record", async (t) => {
  addDailyRow("first");
  addDailyRow("second");
  mockNotion(t);
  await assert.rejects(cmdLogMeal(mealArgs()), /multiple daily rows.*nothing was written/);
  assert.deepEqual(writes(), []);
});

test("unknown Source, numeric operators and mismatched meal headings fail before writes", async (t) => {
  mockNotion(t);
  for (const set of [
    ["Meal Type=Dinner", "Calories (kcal)=180", "Protein (g)=36", "Source=Manual"],
    ["Meal Type=Dinner", "Calories (kcal)=+=180", "Protein (g)=36", "Source=Text"],
    ["Meal Type=Dinner", "Calories (kcal)=Infinity", "Protein (g)=36", "Source=Text"],
    ["Meal Type=Dinner", "Calories (kcal)=-1", "Protein (g)=36", "Source=Text"],
  ])
    await assert.rejects(cmdLogMeal(mealArgs({ set })));
  await assert.rejects(
    cmdLogMeal(mealArgs({ body: "## Lunch\n- Wrong heading" })),
    /only the supplied Meal Type/,
  );
  await assert.rejects(cmdLogMeal(mealArgs({ body: "## Dinner" })), /meal details/);
  assert.deepEqual(writes(), []);
});

test("invalid dates and missing details are rejected without contacting Notion", async (t) => {
  mockNotion(t);
  await assert.rejects(cmdLogMeal(mealArgs({ date: "2026-02-30" })), /--date/);
  await assert.rejects(cmdLogMeal(mealArgs({ body: "" })), /nonempty/);
  assert.deepEqual(requests, []);
});

test("a write failure is not retried and warns that it may have committed", async (t) => {
  mockNotion(t, (request) =>
    request.pathname === "/pages" && request.method === "POST" ? 503 : 0,
  );
  await assert.rejects(cmdLogMeal(mealArgs()), /may have committed.*do not automatically retry/);
  assert.equal(requests.filter((request) => request.pathname === "/pages").length, 1);
  assert.equal(rows.length, 0);
});

test("a post-save totals failure says the meal was saved and must not be logged twice", async (t) => {
  let queries = 0;
  mockNotion(t, (request) => (request.pathname.endsWith("/query") && ++queries === 2 ? 400 : 0));
  await assert.rejects(
    cmdLogMeal(mealArgs()),
    /was saved.*Check the existing row.*do not log the meal twice/,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].properties["Calories (kcal)"].number, 180);
});

test("dry run validates the meal input without changing schema, rows or body", async (t) => {
  mockNotion(t);
  assert.deepEqual(await cmdLogMeal(mealArgs({ "dry-run": true })), { dryRun: true });
  assert.deepEqual(writes(), []);
  assert.equal(rows.length, 0);
});
