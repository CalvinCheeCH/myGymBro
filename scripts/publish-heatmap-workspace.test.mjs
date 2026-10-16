import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const cwd = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "heatmap-workspace-"));
fs.mkdirSync(path.join(fixture, "data"));
const priorToken = process.env.NOTION_TOKEN;
const priorHub = process.env.NOTION_PARENT_PAGE_ID;
process.env.NOTION_TOKEN = "test-notion-token";
process.chdir(fixture);
const { trainingCalendarPage, dashboardPage } = await import("./publish-heatmap.mjs");
process.chdir(cwd);
if (priorToken === undefined) Reflect.deleteProperty(process.env, "NOTION_TOKEN");
else process.env.NOTION_TOKEN = priorToken;

const HUB = "11111111111111111111111111111111";
const WORKOUTS = "22222222222222222222222222222222";
const CALENDAR = "33333333333333333333333333333333";
const DASHBOARD = "44444444444444444444444444444444";
const OTHER = "55555555555555555555555555555555";
const OLD_CALENDAR = "66666666666666666666666666666666";
const OLD_DASHBOARD = "77777777777777777777777777777777";
const CREATED = "88888888888888888888888888888888";
const cacheFile = path.join(fixture, "data", "notion-ids.json");
const childPage = (id, title) => ({ id, type: "child_page", child_page: { title } });
let children;
let parents;
let calls;

beforeEach(() => {
  process.chdir(fixture);
  process.env.NOTION_PARENT_PAGE_ID = HUB;
  fs.writeFileSync(cacheFile, JSON.stringify({ __hub: HUB }));
  children = new Map([
    [HUB, [childPage(WORKOUTS, "Workout Log"), childPage(DASHBOARD, "Dashboard")]],
    [WORKOUTS, [childPage(CALENDAR, "Training Calendar")]],
    [CALENDAR, []],
    [DASHBOARD, []],
  ]);
  parents = new Map([
    [WORKOUTS, HUB],
    [CALENDAR, WORKOUTS],
    [DASHBOARD, HUB],
    [OLD_CALENDAR, OTHER],
    [OLD_DASHBOARD, OTHER],
  ]);
  calls = [];
});
afterEach(() => process.chdir(cwd));
after(() => {
  if (priorHub === undefined) Reflect.deleteProperty(process.env, "NOTION_PARENT_PAGE_ID");
  else process.env.NOTION_PARENT_PAGE_ID = priorHub;
  fs.rmSync(fixture, { recursive: true, force: true });
});

function api(t) {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.notion.com");
    assert.equal(options.headers.Authorization, "Bearer test-notion-token");
    const endpoint = new URL(url).pathname.replace("/v1", "");
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ endpoint, method: options.method, body });
    let response;
    if (endpoint.startsWith("/blocks/")) {
      response = { results: children.get(endpoint.split("/")[2]) ?? [], has_more: false };
    } else if (endpoint === "/pages" && options.method === "POST") {
      response = { id: CREATED };
    } else if (endpoint.startsWith("/pages/")) {
      const id = endpoint.split("/")[2];
      response = { id, parent: { page_id: parents.get(id) } };
    } else assert.fail(`Unexpected fixture request ${endpoint}`);
    return new Response(JSON.stringify(response), { status: 200 });
  });
}

test("cold cache reuses Training Calendar nested under Workout Log without creating a page", async (t) => {
  api(t);
  assert.equal(await trainingCalendarPage(), CALENDAR);
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).__trainingCalendar, CALENDAR);
});

test("explicit Hub rejects cached calendar and Dashboard from another workspace", async (t) => {
  api(t);
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      __hub: OTHER,
      __trainingCalendar: OLD_CALENDAR,
      __dashboard: { pageId: OLD_DASHBOARD },
    }),
  );
  assert.equal(await trainingCalendarPage(), CALENDAR);
  assert.equal(await dashboardPage(), DASHBOARD);
  assert.ok(calls.some((call) => call.endpoint === `/pages/${OLD_CALENDAR}`));
  assert.ok(calls.some((call) => call.endpoint === `/pages/${OLD_DASHBOARD}`));
  assert.equal(
    calls.some((call) => call.endpoint === `/blocks/${OTHER}/children`),
    false,
  );
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
});

test("missing calendar is created under the existing Workout Log wrapper", async (t) => {
  api(t);
  children.set(WORKOUTS, []);
  assert.equal(await trainingCalendarPage(), CREATED);
  const created = calls.find((call) => call.endpoint === "/pages" && call.method === "POST");
  assert.equal(created.body.parent.page_id, WORKOUTS);
});

test("legacy workspace without a Workout Log wrapper creates its calendar under the Hub", async (t) => {
  api(t);
  children.set(HUB, [childPage(DASHBOARD, "Dashboard")]);
  assert.equal(await trainingCalendarPage(), CREATED);
  const created = calls.find((call) => call.endpoint === "/pages" && call.method === "POST");
  assert.equal(created.body.parent.page_id, HUB);
});
