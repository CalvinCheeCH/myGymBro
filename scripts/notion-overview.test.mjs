import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const cwd = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "notion-overview-"));
fs.mkdirSync(path.join(fixture, "data"));
const priorToken = process.env.NOTION_TOKEN;
const priorHub = process.env.NOTION_PARENT_PAGE_ID;
process.env.NOTION_TOKEN = "test-notion-token";
process.chdir(fixture);
const { dashboardModel, cmdSyncDashboard } = await import("./notion.mjs");
process.chdir(cwd);
if (priorToken === undefined) Reflect.deleteProperty(process.env, "NOTION_TOKEN");
else process.env.NOTION_TOKEN = priorToken;

const DATE = "2026-10-16";
const HUB = "11111111111111111111111111111111";
const FOOD = "22222222222222222222222222222222";
const RESOURCES = "33333333333333333333333333333333";
const DASHBOARD = "44444444444444444444444444444444";
const MEALS = "55555555555555555555555555555555";
const OUTSIDE = "99999999999999999999999999999999";
const DAILY = "01010101010101010101010101010101";
const SOURCES = {
  "Workout Log": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "Meal Log": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "Body Stats": "cccccccccccccccccccccccccccccccc",
  Goals: "dddddddddddddddddddddddddddddddd",
  Programs: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};
const cacheFile = path.join(fixture, "data", "notion-ids.json");
const rt = (content) => [{ type: "text", text: { content }, plain_text: content }];
const title = (content) => ({ type: "title", title: rt(content) });
const number = (value) => ({ type: "number", number: value });
const date = (value) => ({ type: "date", date: { start: value } });
const select = (value) => ({ type: "select", select: { name: value } });
const childPage = (id, name) => ({ id, type: "child_page", child_page: { title: name } });
const paragraph = (id, content) => ({
  id,
  type: "paragraph",
  paragraph: { rich_text: rt(content) },
});
let children;
let parents;
let databaseParents;
let schemas;
let rows;
let calls;
let blockParents;
let sequence;

beforeEach(() => {
  process.chdir(fixture);
  process.env.NOTION_PARENT_PAGE_ID = HUB;
  calls = [];
  sequence = 0;
  parents = new Map([
    [FOOD, HUB],
    [RESOURCES, FOOD],
    [DASHBOARD, HUB],
    [MEALS, HUB],
    [DAILY, SOURCES["Meal Log"]],
  ]);
  databaseParents = new Map(Object.values(SOURCES).map((id) => [id, RESOURCES]));
  schemas = {
    [SOURCES["Workout Log"]]: {
      Session: { type: "title" },
      Date: { type: "date" },
      "Duration (min)": { type: "number" },
      Sessions: { type: "number" },
      Focus: { type: "multi_select" },
      Status: { type: "select" },
    },
    [SOURCES["Meal Log"]]: {
      Meal: { type: "title" },
      Date: { type: "date" },
      "Calories (kcal)": { type: "number" },
      "Protein (g)": { type: "number" },
    },
    [SOURCES["Body Stats"]]: {
      "Check-in": { type: "title" },
      Date: { type: "date" },
      "Bodyweight (kg)": { type: "number" },
    },
    [SOURCES.Goals]: {
      Goal: { type: "title" },
      "Current Value": { type: "number" },
      "Target Value": { type: "number" },
      Status: { type: "select" },
    },
    [SOURCES.Programs]: { Program: { type: "title" }, Status: { type: "select" } },
  };
  rows = {
    [SOURCES["Workout Log"]]: [
      {
        id: "workout-row",
        properties: {
          Session: title("Recorded upper body"),
          Date: date("2026-10-14"),
          "Duration (min)": number(46),
          Sessions: number(1),
          Focus: { type: "multi_select", multi_select: [{ name: "Chest" }, { name: "Back" }] },
          Status: select("Completed"),
        },
      },
    ],
    [SOURCES["Meal Log"]]: [
      {
        id: DAILY,
        properties: {
          Meal: title("16/10/26 (Friday)"),
          Date: date(DATE),
          "Calories (kcal)": number(370),
          "Protein (g)": number(13),
        },
      },
    ],
    [SOURCES["Body Stats"]]: [
      {
        id: "weight-row",
        properties: {
          "Check-in": title("Recorded morning check-in"),
          Date: date("2026-10-15"),
          "Bodyweight (kg)": number(75.2),
        },
      },
    ],
    [SOURCES.Goals]: [
      {
        id: "active-goal",
        properties: {
          Goal: title("My stated strength goal"),
          "Current Value": number(60),
          "Target Value": number(70),
          Status: select("On track"),
        },
      },
      {
        id: "old-goal",
        properties: {
          Goal: title("An achieved goal"),
          "Current Value": number(1),
          "Target Value": number(1),
          Status: select("Achieved"),
        },
      },
    ],
    [SOURCES.Programs]: [
      {
        id: "saved-program",
        properties: { Program: title("My actual saved program"), Status: select("Active") },
      },
    ],
  };
  children = new Map([
    [
      HUB,
      [
        childPage(DASHBOARD, "Dashboard"),
        childPage(MEALS, "Meal Log"),
        childPage(FOOD, "Food & Knowledge"),
      ],
    ],
    [FOOD, [childPage(RESOURCES, "Workspace Resources")]],
    [
      RESOURCES,
      Object.entries(SOURCES).map(([name, id]) => ({
        id,
        type: "child_database",
        child_database: { title: name },
      })),
    ],
    [
      DASHBOARD,
      [
        {
          id: "verified-overview",
          type: "callout",
          callout: { rich_text: rt("Your daily overview") },
          has_children: true,
        },
        paragraph("dashboard-personal-note", "Keep my personal dashboard note"),
      ],
    ],
    [
      "verified-overview",
      [
        {
          id: "dashboard-image",
          type: "image",
          image: { type: "file_upload", file_upload: { id: "old-image" } },
        },
        paragraph("dashboard-caption", "Old overview caption"),
      ],
    ],
    [
      MEALS,
      [
        {
          id: "verified-nutrition",
          type: "callout",
          callout: { rich_text: rt("Daily nutrition") },
          has_children: true,
        },
        { id: "meal-source-view", type: "child_database", child_database: { title: "Meal Log" } },
      ],
    ],
    [
      "verified-nutrition",
      [
        {
          id: "meal-image",
          type: "image",
          image: { type: "file_upload", file_upload: { id: "old-meal-image" } },
        },
        paragraph("meal-caption", "Old nutrition caption"),
      ],
    ],
    [
      DAILY,
      [
        {
          id: "meal-detail",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: rt("Breakfast: toast and eggs, 370 kcal, 13 g protein"),
          },
        },
      ],
    ],
  ]);
  blockParents = new Map();
  for (const [parent, blocks] of children)
    for (const block of blocks) blockParents.set(block.id, parent);
  fs.writeFileSync(
    cacheFile,
    JSON.stringify(
      {
        __hub: HUB,
        __resources: RESOURCES,
        __workspacePages: {
          dashboard: DASHBOARD,
          meals: MEALS,
          foodKnowledge: FOOD,
          resources: RESOURCES,
        },
        __dashboard: {
          pageId: OUTSIDE,
          layout: "overview",
          overviewBlockId: "unverified-cached-overview",
          columns: {},
        },
        __nutritionSummary: { pageId: OUTSIDE, blockId: "unverified-cached-nutrition" },
        ...SOURCES,
      },
      null,
      2,
    ),
  );
});

afterEach(() => process.chdir(cwd));
after(() => {
  if (priorHub === undefined) Reflect.deleteProperty(process.env, "NOTION_PARENT_PAGE_ID");
  else process.env.NOTION_PARENT_PAGE_ID = priorHub;
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith("notion-overview-"));
  fs.rmSync(fixture, { recursive: true, force: true });
});

function api(t) {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const endpoint = new URL(url).pathname.replace("/v1", "");
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ endpoint, method, body });
    assert.equal(new URL(url).origin, "https://api.notion.com");
    assert.equal(options.headers.Authorization, "Bearer test-notion-token");
    let result;
    if (endpoint.startsWith("/databases/")) {
      const id = endpoint.split("/")[2];
      assert.ok(schemas[id], `Unexpected source database ${id}`);
      result = endpoint.endsWith("/query")
        ? { results: rows[id], has_more: false }
        : { id, parent: { page_id: databaseParents.get(id) }, properties: schemas[id] };
    } else if (endpoint.startsWith("/pages/") && method === "GET") {
      const id = endpoint.split("/")[2];
      result = { id, parent: { page_id: parents.get(id) } };
    } else if (
      endpoint.startsWith("/blocks/") &&
      endpoint.endsWith("/children") &&
      method === "GET"
    ) {
      result = { results: children.get(endpoint.split("/")[2]) ?? [], has_more: false };
    } else if (endpoint.startsWith("/blocks/") && method === "PATCH") {
      const id = endpoint.split("/")[2];
      if (endpoint.endsWith("/children")) {
        assert.ok(Array.isArray(body.children));
        const results = body.children.map((payload) => materialize(id, payload));
        children.set(id, [...(children.get(id) ?? []), ...results]);
        const parent = findBlock(id);
        if (parent) parent.has_children = true;
        result = { results };
      } else {
        const existing = findBlock(id);
        assert.ok(existing, `Cannot update missing block ${id}`);
        assert.ok(!body[existing.type]?.children, "Update-block cannot replace children");
        Object.assign(existing, structuredClone(body));
        result = existing;
      }
    } else if (endpoint.startsWith("/blocks/") && method === "DELETE") {
      const id = endpoint.split("/")[2];
      const parent = blockParents.get(id);
      assert.ok(parent, `Cannot delete missing block ${id}`);
      children.set(
        parent,
        children.get(parent).filter((block) => block.id !== id),
      );
      const parentBlock = findBlock(parent);
      if (parentBlock) parentBlock.has_children = children.get(parent).length > 0;
      result = { id, archived: true };
    } else assert.fail(`Unexpected overview request ${method} ${endpoint}`);
    return new Response(JSON.stringify(result), { status: 200 });
  });
}

function findBlock(id) {
  for (const blocks of children.values()) {
    const block = blocks.find((item) => item.id === id);
    if (block) return block;
  }
}

function materialize(parent, payload, depth = 0) {
  assert.ok(depth <= 2, "Notion append accepts at most two nested levels");
  const item = structuredClone(payload);
  item.id = `native-${++sequence}`;
  blockParents.set(item.id, parent);
  const nested = item[item.type]?.children;
  if (nested) {
    Reflect.deleteProperty(item[item.type], "children");
    const descendants = nested.map((child) => materialize(item.id, child, depth + 1));
    item.has_children = descendants.length > 0;
    children.set(item.id, descendants);
  } else item.has_children = false;
  return item;
}

function displayTree(id) {
  return (children.get(id) ?? []).flatMap((block) => [block, ...displayTree(block.id)]);
}

function displayText(id) {
  return displayTree(id)
    .map((block) =>
      (block[block.type]?.rich_text ?? []).map((part) => part.text?.content ?? "").join(""),
    )
    .join("\n");
}

function writes() {
  return calls.filter((call) => call.method !== "GET" && !call.endpoint.endsWith("/query"));
}

function assertDisplayWritesOnly() {
  for (const write of writes()) {
    assert.ok(
      write.endpoint.startsWith("/blocks/"),
      `Unexpected non-block write ${write.endpoint}`,
    );
    let id = write.endpoint.split("/")[2];
    const visited = new Set();
    while (!["verified-overview", "verified-nutrition"].includes(id)) {
      assert.ok(id && !visited.has(id), `Write outside verified display: ${write.endpoint}`);
      visited.add(id);
      id = blockParents.get(id);
    }
  }
}

test("overview model reads actual scoped values without assumed targets or cache writes", async (t) => {
  api(t);
  const before = fs.readFileSync(cacheFile, "utf8");
  const { model, failures } = await dashboardModel(DATE);
  assert.deepEqual(failures, []);
  assert.equal(model.nutrition.calories, 370);
  assert.equal(model.nutrition.protein, 13);
  assert.equal(model.nutrition.calorieTarget, null);
  assert.equal(model.nutrition.proteinTarget, null);
  assert.equal(model.trainingTarget, undefined);
  assert.equal(model.dailyPageId, DAILY);
  assert.equal(model.bodyStats[0].weight, 75.2);
  assert.equal(model.workouts[0].duration, 46);
  assert.equal(model.goals.length, 1);
  assert.equal(model.program.name, "My actual saved program");
  assert.ok(calls.some((call) => call.endpoint === `/pages/${RESOURCES}`));
  assert.ok(calls.some((call) => call.endpoint === `/pages/${FOOD}`));
  assert.equal(fs.readFileSync(cacheFile, "utf8"), before);
  const query = calls.find((call) => call.endpoint === `/databases/${SOURCES["Meal Log"]}/query`);
  assert.deepEqual(query.body.filter, { property: "Date", date: { equals: DATE } });
  assert.ok(calls.every((call) => call.method === "GET" || call.endpoint.endsWith("/query")));
});

test("missing sources become unavailable model fields rather than zero-valued data", async (t) => {
  api(t);
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  Reflect.deleteProperty(cache, "Meal Log");
  Reflect.deleteProperty(cache, "Body Stats");
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const before = fs.readFileSync(cacheFile, "utf8");
  const { model, failures } = await dashboardModel(DATE);
  assert.deepEqual(failures, ["Meal Log", "Body Stats"]);
  assert.equal(model.nutrition, undefined);
  assert.equal(model.meals, undefined);
  assert.equal(model.bodyStats, undefined);
  assert.equal(fs.readFileSync(cacheFile, "utf8"), before);
});

test("resources outside the pinned Hub prevent all private source queries", async (t) => {
  api(t);
  parents.set(RESOURCES, OUTSIDE);
  await assert.rejects(dashboardModel(DATE), /resources are not verified/);
  assert.equal(
    calls.some((call) => call.endpoint.startsWith("/databases/")),
    false,
  );
});

test("a moved source database is not queried outside verified Workspace Resources", async (t) => {
  api(t);
  databaseParents.set(SOURCES["Meal Log"], OUTSIDE);
  const { model, failures } = await dashboardModel(DATE);
  assert.deepEqual(failures, ["Meal Log"]);
  assert.equal(model.nutrition, undefined);
  assert.equal(
    calls.some((call) => call.endpoint === `/databases/${SOURCES["Meal Log"]}/query`),
    false,
  );
  assert.equal(
    calls.some((call) => call.endpoint === `/blocks/${DAILY}/children`),
    false,
  );
});

test("sync replaces old images with matching native summaries inside verified display containers", async (t) => {
  api(t);
  const before = fs.readFileSync(cacheFile, "utf8");
  const sourceBefore = structuredClone(rows);
  const dailyBefore = structuredClone(children.get(DAILY));
  const dashboardBefore = structuredClone(children.get(DASHBOARD));
  const mealBefore = structuredClone(children.get(MEALS));
  await cmdSyncDashboard({ now: DATE });
  const overview = displayTree("verified-overview");
  const nutrition = displayTree("verified-nutrition");
  assert.ok([...overview, ...nutrition].every((block) => !["image", "embed"].includes(block.type)));
  assert.equal(overview.filter((block) => block.type === "equation").length, 3);
  assert.equal(nutrition.filter((block) => block.type === "equation").length, 2);
  assert.match(displayText("verified-overview"), /370 kcal/);
  assert.match(displayText("verified-overview"), /13 g/);
  assert.match(displayText("verified-nutrition"), /370 kcal/);
  assert.match(displayText("verified-nutrition"), /13 g/);
  assert.equal(
    calls.some((call) => call.endpoint.startsWith("/file_uploads")),
    false,
  );
  assertDisplayWritesOnly();
  assert.deepEqual(rows, sourceBefore);
  assert.deepEqual(children.get(DAILY), dailyBefore);
  assert.deepEqual(children.get(DASHBOARD), dashboardBefore);
  assert.deepEqual(children.get(MEALS), mealBefore);
  assert.equal(
    calls.some((call) => call.endpoint.includes("unverified-cached")),
    false,
  );
  assert.equal(fs.readFileSync(cacheFile, "utf8"), before);
});

test("an identical native refresh makes no display writes", async (t) => {
  api(t);
  await cmdSyncDashboard({ now: DATE });
  const overviewBefore = structuredClone(displayTree("verified-overview"));
  const nutritionBefore = structuredClone(displayTree("verified-nutrition"));
  calls.length = 0;
  await cmdSyncDashboard({ now: DATE });
  assert.deepEqual(writes(), []);
  assert.deepEqual(displayTree("verified-overview"), overviewBefore);
  assert.deepEqual(displayTree("verified-nutrition"), nutritionBefore);
});

test("updated totals patch their existing native blocks without rebuilding the display", async (t) => {
  api(t);
  await cmdSyncDashboard({ now: DATE });
  const overviewIds = displayTree("verified-overview").map((block) => block.id);
  const nutritionIds = displayTree("verified-nutrition").map((block) => block.id);
  rows[SOURCES["Meal Log"]][0].properties["Calories (kcal)"] = number(420);
  calls.length = 0;
  await cmdSyncDashboard({ now: DATE });
  assert.equal(writes().length, 3);
  assert.ok(writes().every((call) => JSON.stringify(call.body).includes("420")));
  assert.ok(
    writes().every((call) => call.method === "PATCH" && !call.endpoint.endsWith("/children")),
  );
  assertDisplayWritesOnly();
  assert.deepEqual(
    displayTree("verified-overview").map((block) => block.id),
    overviewIds,
  );
  assert.deepEqual(
    displayTree("verified-nutrition").map((block) => block.id),
    nutritionIds,
  );
  assert.match(displayText("verified-overview"), /420 kcal/);
  assert.match(displayText("verified-nutrition"), /420 kcal/);
});

test("partial sync shows unavailable nutrition on both displays and reports the failure", async (t) => {
  api(t);
  databaseParents.set(SOURCES["Meal Log"], OUTSIDE);
  const sourceBefore = structuredClone(rows);
  const dailyBefore = structuredClone(children.get(DAILY));
  await assert.rejects(cmdSyncDashboard({ now: DATE }), /unavailable sources: Meal Log/);
  assert.match(displayText("verified-overview"), /Nutrition records could not be read/);
  assert.match(displayText("verified-nutrition"), /Nutrition records could not be read/);
  assert.doesNotMatch(displayText("verified-overview"), /0 kcal|0 g|370 kcal/);
  assert.doesNotMatch(displayText("verified-nutrition"), /0 kcal|0 g|370 kcal/);
  assert.ok(
    [...displayTree("verified-overview"), ...displayTree("verified-nutrition")].every(
      (block) => !["image", "embed"].includes(block.type),
    ),
  );
  assert.equal(
    calls.some((call) => call.endpoint.startsWith("/file_uploads")),
    false,
  );
  assertDisplayWritesOnly();
  assert.deepEqual(rows, sourceBefore);
  assert.deepEqual(children.get(DAILY), dailyBefore);
});
