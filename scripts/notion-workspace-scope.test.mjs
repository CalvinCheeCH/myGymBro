import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const cwd = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "notion-workspace-scope-"));
fs.mkdirSync(path.join(fixture, "data"));
const priorToken = process.env.NOTION_TOKEN;
const priorHub = process.env.NOTION_PARENT_PAGE_ID;
process.env.NOTION_TOKEN = "test-notion-token";
process.chdir(fixture);
const { resolveDbId, pageIsWithinHub, workspaceDatabases, cmdResolveWorkspace } = await import(
  "./notion.mjs"
);
process.chdir(cwd);
if (priorToken === undefined) Reflect.deleteProperty(process.env, "NOTION_TOKEN");
else process.env.NOTION_TOKEN = priorToken;
const HUB = "11111111111111111111111111111111";
const FOOD = "22222222222222222222222222222222";
const RESOURCES = "33333333333333333333333333333333";
const DB = "44444444444444444444444444444444";
const OTHER = "55555555555555555555555555555555";
const childPage = (id, title) => ({ id, type: "child_page", child_page: { title } });
const childDb = (id, title) => ({ id, type: "child_database", child_database: { title } });
let parents;
let children;
let requests;
beforeEach(() => {
  Reflect.deleteProperty(process.env, "NOTION_PARENT_PAGE_ID");
  parents = new Map([
    [FOOD, HUB],
    [RESOURCES, FOOD],
  ]);
  children = new Map([
    [HUB, [childPage(FOOD, "Food & Knowledge")]],
    [FOOD, [childPage(RESOURCES, "Workspace Resources")]],
    [RESOURCES, [childDb(DB, "Meal Log")]],
  ]);
  requests = [];
  fs.writeFileSync(path.join(fixture, "data/notion-ids.json"), JSON.stringify({ __hub: HUB }));
});
after(() => {
  if (priorHub === undefined) Reflect.deleteProperty(process.env, "NOTION_PARENT_PAGE_ID");
  else process.env.NOTION_PARENT_PAGE_ID = priorHub;
  fs.rmSync(fixture, { recursive: true, force: true });
});
function api(t, databaseParent = RESOURCES) {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const endpoint = new URL(url).pathname.replace("/v1", "");
    requests.push(endpoint);
    assert.equal(options.headers.Authorization, "Bearer test-notion-token");
    let body;
    if (endpoint === `/databases/${DB}`) body = { id: DB, parent: { page_id: databaseParent } };
    else if (endpoint.startsWith("/pages/"))
      body = {
        id: endpoint.split("/")[2],
        parent: { page_id: parents.get(endpoint.split("/")[2]) },
      };
    else if (endpoint.startsWith("/blocks/"))
      body = { results: children.get(endpoint.split("/")[2]) ?? [], has_more: false };
    else throw new Error(`Unexpected test request ${endpoint}`);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

test("cold cache resolves the original database nested beneath Food & Knowledge", async (t) => {
  api(t);
  assert.equal(await resolveDbId("Meal Log"), DB);
  assert.ok(requests.includes(`/blocks/${RESOURCES}/children`));
});

test("cached source database stays usable after relocation within its Hub", async (t) => {
  api(t);
  fs.writeFileSync(
    path.join(fixture, "data/notion-ids.json"),
    JSON.stringify({ __hub: HUB, "Meal Log": DB }),
  );
  assert.equal(await resolveDbId("Meal Log"), DB);
  assert.ok(await pageIsWithinHub(RESOURCES, HUB));
});

test("moving a source outside the Hub stops writes and never accepts stale cache", async (t) => {
  api(t, OTHER);
  children.set(RESOURCES, []);
  fs.writeFileSync(
    path.join(fixture, "data/notion-ids.json"),
    JSON.stringify({ __hub: HUB, "Meal Log": DB }),
  );
  await assert.rejects(resolveDbId("Meal Log"), /No database named/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(fixture, "data/notion-ids.json"), "utf8"))["Meal Log"],
    undefined,
  );
});

test("an explicit new Hub pin takes precedence over old cached workspace IDs", async (t) => {
  api(t);
  process.env.NOTION_PARENT_PAGE_ID = OTHER;
  fs.writeFileSync(
    path.join(fixture, "data/notion-ids.json"),
    JSON.stringify({ __hub: HUB, "Meal Log": DB }),
  );
  await assert.rejects(resolveDbId("Meal Log"), /No database named/);
  assert.ok(requests.includes(`/blocks/${OTHER}/children`));
});

test("workspace discovery does not follow training rows or arbitrary imported pages", async (t) => {
  api(t);
  children.get(HUB).push(childPage(OTHER, "Imported program"));
  await workspaceDatabases(HUB);
  assert.ok(!requests.includes(`/blocks/${OTHER}/children`));
});

test("workspace recovery rebuilds nested source and page aliases without creating pages", async (t) => {
  const workouts = "66666666666666666666666666666666";
  const calendar = "77777777777777777777777777777777";
  const knowledge = "88888888888888888888888888888888";
  const exercise = "99999999999999999999999999999999";
  const meals = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  children.get(HUB).push(childPage(workouts, "Workout Log"), childPage(meals, "Meal Log"));
  children.set(workouts, [childPage(calendar, "Training Calendar")]);
  children.set(calendar, []);
  children.set(meals, [
    {
      id: "summary",
      type: "callout",
      callout: { rich_text: [{ type: "text", text: { content: "Daily nutrition" } }] },
    },
  ]);
  children.get(FOOD).push(childPage(knowledge, "Knowledge Base"));
  children.set(knowledge, [childPage(exercise, "Exercise Library")]);
  children.set(exercise, []);
  api(t);
  t.mock.method(console, "log", () => {});
  await cmdResolveWorkspace();
  const cache = JSON.parse(fs.readFileSync(path.join(fixture, "data/notion-ids.json"), "utf8"));
  assert.equal(cache["Meal Log"], DB);
  assert.equal(cache.__knowledgeBase, knowledge);
  assert.equal(cache.__trainingCalendar, calendar);
  assert.equal(cache.__exerciseLibrary, exercise);
  assert.equal(cache.__workspacePages.meals, meals);
  assert.equal(cache.__resources, RESOURCES);
  assert.deepEqual(cache.__nutritionSummary, { pageId: meals, blockId: "summary" });
  assert.ok(!requests.includes("/pages"));
});
