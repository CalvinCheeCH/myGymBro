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
let uploads;

beforeEach(() => {
  process.chdir(fixture);
  process.env.NOTION_PARENT_PAGE_ID = HUB;
  calls = [];
  uploads = [];
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
    const body =
      options.body instanceof FormData
        ? options.body
        : options.body
          ? JSON.parse(options.body)
          : undefined;
    calls.push({ endpoint, method, body });
    assert.equal(new URL(url).origin, "https://api.notion.com");
    assert.equal(options.headers.Authorization, "Bearer test-notion-token");
    let result;
    if (endpoint === "/file_uploads" && method === "POST") {
      const id = `ffffffff-ffff-4fff-8fff-${String(uploads.length + 1).padStart(12, "0")}`;
      uploads.push({ id, filename: body.filename });
      result = { id };
    } else if (/^\/file_uploads\/[^/]+\/send$/.test(endpoint)) {
      assert.ok(body instanceof FormData);
      const png = new Uint8Array(await body.get("file").arrayBuffer());
      assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      result = { status: "uploaded" };
    } else if (endpoint.startsWith("/databases/")) {
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
    } else if (endpoint.startsWith("/blocks/") && method === "PATCH")
      result = { id: endpoint.split("/")[2], results: [] };
    else assert.fail(`Unexpected overview request ${method} ${endpoint}`);
    return new Response(JSON.stringify(result), { status: 200 });
  });
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

test("sync uploads matching 370 kcal / 13 g summaries and updates only verified display children", async (t) => {
  api(t);
  const before = fs.readFileSync(cacheFile, "utf8");
  await cmdSyncDashboard({ now: DATE });
  assert.deepEqual(
    uploads.map((upload) => upload.filename),
    ["fitness-overview.png", "daily-nutrition.png"],
  );
  const patches = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(
    patches.map((call) => call.endpoint).sort(),
    [
      "/blocks/dashboard-caption",
      "/blocks/dashboard-image",
      "/blocks/meal-caption",
      "/blocks/meal-image",
    ].sort(),
  );
  const overviewCaption = patches.find((call) => call.endpoint === "/blocks/dashboard-image").body
    .image.caption[0].text.content;
  const mealCaption = patches.find((call) => call.endpoint === "/blocks/meal-image").body.image
    .caption[0].text.content;
  assert.match(overviewCaption, /370 kcal and 13 g protein recorded today/);
  assert.match(mealCaption, /Calories: 370 \(target not set\) kcal/);
  assert.match(mealCaption, /Protein: 13 \(target not set\) g/);
  for (const patch of patches.filter((call) => call.body.image))
    assert.equal(
      patch.body.image.type,
      undefined,
      "Notion update-block payload must omit the append-only image type",
    );
  assert.equal(
    calls.some(
      (call) =>
        call.method === "DELETE" ||
        call.endpoint === "/pages" ||
        (call.method === "PATCH" && call.endpoint.startsWith("/databases/")),
    ),
    false,
  );
  assert.equal(
    calls.some((call) => call.endpoint.includes("unverified-cached")),
    false,
  );
  assert.equal(fs.readFileSync(cacheFile, "utf8"), before);
});

test("partial sync reports unavailable nutrition without overwriting the meal display with zeros", async (t) => {
  api(t);
  databaseParents.set(SOURCES["Meal Log"], OUTSIDE);
  await assert.rejects(cmdSyncDashboard({ now: DATE }), /unavailable sources: Meal Log/);
  assert.deepEqual(
    uploads.map((upload) => upload.filename),
    ["fitness-overview.png"],
  );
  const image = calls.find(
    (call) => call.endpoint === "/blocks/dashboard-image" && call.method === "PATCH",
  );
  assert.match(image.body.image.caption[0].text.content, /Nutrition unavailable/);
  assert.equal(
    calls.some(
      (call) =>
        call.method === "PATCH" &&
        ["/blocks/meal-caption", "/blocks/meal-image"].includes(call.endpoint),
    ),
    false,
  );
});
