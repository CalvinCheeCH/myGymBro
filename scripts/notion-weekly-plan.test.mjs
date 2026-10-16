import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const originalCwd = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-weekly-plan-"));
const cacheFile = path.join(fixture, "data", "notion-ids.json");
fs.mkdirSync(path.dirname(cacheFile));
const priorToken = process.env.NOTION_TOKEN;
process.env.NOTION_TOKEN = "test-notion-token";
process.chdir(fixture);
const { cmdCreatePage, cmdWeeklyPlan, findCurrentWeeklyPlanTitle } = await import("./notion.mjs");
process.chdir(originalCwd);
if (priorToken === undefined) Reflect.deleteProperty(process.env, "NOTION_TOKEN");
else process.env.NOTION_TOKEN = priorToken;
after(() => {
  assert.equal(path.dirname(fixture), os.tmpdir());
  fs.rmSync(fixture, { recursive: true, force: true });
});

const HUB = "11111111111111111111111111111111";
const KB = "22222222222222222222222222222222";
const PLAN = "33333333333333333333333333333333";
const ANCHOR = "44444444444444444444444444444444";
const WEEK = "2026-10-11";
const text = (value) => [{ type: "text", text: { content: value }, plain_text: value }];
const heading = (id, value) => ({ id, type: "heading_2", heading_2: { rich_text: text(value) } });
let pages;
let children;
let requests;
let sequence;

function writeCache(extra = {}) {
  fs.writeFileSync(cacheFile, JSON.stringify({ __hub: HUB, __knowledgeBase: KB, ...extra }));
}

beforeEach(() => {
  pages = new Map();
  pages.set(KB, { id: KB, parent: { page_id: HUB } });
  children = new Map([
    [HUB, []],
    [KB, []],
  ]);
  requests = [];
  sequence = 0;
  writeCache();
});

function addPage(id, title, parent, body = []) {
  pages.set(id, { id, parent: { page_id: parent }, properties: { title: { title: text(title) } } });
  children.get(parent).push({ id, type: "child_page", child_page: { title } });
  children.set(id, body);
}

function addCanonicalPage() {
  addPage(PLAN, "Weekly Plan", HUB, [
    { id: "navigation", type: "paragraph", paragraph: { rich_text: text("Keep navigation") } },
    heading(ANCHOR, "Plan history"),
    { id: "footer", type: "paragraph", paragraph: { rich_text: text("Keep resources") } },
  ]);
  writeCache({ __workspacePages: { weeklyPlan: PLAN }, __weeklyPlan: PLAN });
}

function storeBlock(block) {
  const value = structuredClone(block);
  value.id ??= `block-${++sequence}`;
  const content = value[value.type];
  if (content.rich_text)
    content.rich_text = content.rich_text.map((part) => ({
      ...part,
      plain_text: part.text?.content ?? part.plain_text,
    }));
  const nested = value[value.type]?.children;
  if (nested) {
    children.set(value.id, nested.map(storeBlock));
    value[value.type].children = undefined;
    value.has_children = nested.length > 0;
  }
  return value;
}

function mockNotion(t, fail = () => false) {
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const address = new URL(url);
    const pathname = address.pathname.replace(/^\/v1/, "");
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    const request = { pathname, method, body };
    requests.push(request);
    if (fail(request)) return Response.json({ message: "write failed" }, { status: 503 });
    if (method === "GET" && pathname.startsWith("/pages/")) {
      const page = pages.get(pathname.split("/")[2]);
      return Response.json(page ?? { message: "not found" }, { status: page ? 200 : 404 });
    }
    const childMatch = /^\/blocks\/([^/]+)\/children$/.exec(pathname);
    if (childMatch && method === "GET") {
      const all = children.get(childMatch[1]) ?? [];
      const offset = Number(address.searchParams.get("start_cursor") ?? 0);
      return Response.json({
        results: all.slice(offset, offset + 100),
        has_more: all.length > offset + 100,
        next_cursor: String(offset + 100),
      });
    }
    if (method === "POST" && pathname === "/pages") {
      const id = `page-${++sequence}`;
      const title = body.properties.title.title[0].text.content;
      addPage(id, title, body.parent.page_id, (body.children ?? []).map(storeBlock));
      return Response.json(pages.get(id));
    }
    if (childMatch && method === "PATCH") {
      const current = children.get(childMatch[1]) ?? [];
      const added = body.children.map(storeBlock);
      const index = body.after
        ? current.findIndex((block) => block.id === body.after) + 1
        : current.length;
      assert.ok(!body.after || index > 0, "insert anchor must exist");
      current.splice(index, 0, ...added);
      children.set(childMatch[1], current);
      return Response.json({ results: added });
    }
    if (method === "PATCH" && /^\/blocks\/[^/]+$/.test(pathname)) {
      const id = pathname.split("/")[2];
      for (const blocks of children.values()) {
        const block = blocks.find((item) => item.id === id);
        if (block) {
          Object.assign(block[block.type], body[block.type]);
          return Response.json(block);
        }
      }
    }
    throw new Error(`Unexpected Notion request: ${method} ${pathname}`);
  });
}

test("weekly plan creates one Hub page and prepends later revisions while preserving navigation", async (t) => {
  mockNotion(t);
  await cmdWeeklyPlan({ action: "save", week: WEEK, md: "## Monday\n- Bench 60 kg × 6" });
  const pageId = JSON.parse(fs.readFileSync(cacheFile)).__weeklyPlan;
  const oldEntry = children.get(pageId).find((block) => block.type === "callout");
  await cmdWeeklyPlan({ action: "save", week: WEEK, md: "## Monday\n- Bench 62.5 kg × 5" });
  const entries = children.get(pageId).filter((block) => block.type === "callout");
  assert.equal(
    requests.filter((request) => request.method === "POST" && request.pathname === "/pages").length,
    1,
  );
  assert.equal(pages.get(pageId).parent.page_id, HUB);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].id, oldEntry.id);
  assert.match(children.get(oldEntry.id)[1].bulleted_list_item.rich_text[0].text.content, /60 kg/);
  assert.ok(requests.every((request) => request.method !== "DELETE" && !request.body?.archived));
});

test("weekly plan uses the pinned wrapper and preserves all non-plan blocks", async (t) => {
  addCanonicalPage();
  mockNotion(t);
  await cmdWeeklyPlan({ action: "save", week: WEEK, md: "- Squat 80 kg × 5" });
  assert.deepEqual(
    children.get(PLAN).map((block) => block.id),
    ["navigation", ANCHOR, "block-1", "footer"],
  );
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
});

test("weekly plan show selects the newest requested week and dashboard ignores incomplete entries", async (t) => {
  addCanonicalPage();
  mockNotion(t);
  await cmdWeeklyPlan({ action: "save", week: "2026-10-04", md: "- Older week" });
  await cmdWeeklyPlan({ action: "save", week: WEEK, md: "- Current revision" });
  children.get(PLAN).splice(2, 0, {
    id: "incomplete",
    type: "callout",
    callout: {
      rich_text: text("Weekly Plan - 2026-10-18 · Saving (incomplete) 2026-10-16T12:00:00Z"),
    },
  });
  await cmdWeeklyPlan({ action: "show", week: WEEK });
  const output = console.log.mock.calls.at(-1).arguments[0];
  assert.match(output, /Current revision/);
  assert.doesNotMatch(output, /Older week/);
  assert.equal(
    await findCurrentWeeklyPlanTitle(new Date("2026-10-16T12:00:00Z")),
    `Weekly Plan - ${WEEK}`,
  );
  assert.equal(await findCurrentWeeklyPlanTitle(new Date("2026-10-18T12:00:00Z")), null);
});

test("legacy dated plans stay readable and stale create-page calls save into the persistent page", async (t) => {
  addPage("legacy", `Weekly Plan - ${WEEK}`, KB, [
    { id: "old-body", type: "paragraph", paragraph: { rich_text: text("Original legacy plan") } },
  ]);
  mockNotion(t);
  await cmdWeeklyPlan({ action: "show", week: WEEK });
  assert.match(console.log.mock.calls.at(-1).arguments[0], /Original legacy plan/);
  await cmdCreatePage({ title: `Weekly Plan - ${WEEK}`, parent: KB, md: "- New plan" });
  assert.equal(pages.get("legacy").parent.page_id, KB);
  assert.deepEqual(children.get("legacy")[0].paragraph.rich_text, text("Original legacy plan"));
  const created = requests.filter(
    (request) => request.method === "POST" && request.pathname === "/pages",
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].body.properties.title.title[0].text.content, "Weekly Plan");
});

test("legacy weekly-plan title variants fail before any API call", async (t) => {
  mockNotion(t);
  for (const title of [
    "Weekly Plan: 20/09/2026 -26/09/2026",
    "Week of 20/9 -26/9/2026 Training Plan",
    "Upper Body Plan - Week39",
  ]) {
    await assert.rejects(
      cmdCreatePage({ title, parent: KB, md: "- Existing instructions" }),
      /weekly-plan --action save --week <Sunday YYYY-MM-DD>/,
    );
  }
  assert.deepEqual(requests, []);
});

test("ordinary program and reference pages still use generic create-page", async (t) => {
  mockNotion(t);
  const titles = [
    "Upper Body Program - Week39",
    "Weekly Plan Reference",
    "Upper Body Plan - Week39 Reference",
  ];
  for (const title of titles)
    await cmdCreatePage({ title, parent: KB, md: "- Reference material" });
  assert.deepEqual(
    requests
      .filter((request) => request.method === "POST" && request.pathname === "/pages")
      .map((request) => request.body.properties.title.title[0].text.content),
    titles,
  );
});

test("failed plan body writes keep old plans and do not advertise an incomplete revision", async (t) => {
  addCanonicalPage();
  mockNotion(
    t,
    (request) => request.method === "PATCH" && request.pathname === "/blocks/block-1/children",
  );
  await assert.rejects(
    cmdWeeklyPlan({ action: "save", week: WEEK, md: "- New plan" }),
    /write failed/,
  );
  assert.match(children.get(PLAN)[2].callout.rich_text[0].text.content, /Saving \(incomplete\)/);
  assert.equal(await findCurrentWeeklyPlanTitle(new Date("2026-10-16T12:00:00Z")), null);
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 0);
});

test("invalid dates and empty plans are rejected before any request", async (t) => {
  mockNotion(t);
  for (const week of [undefined, "2026-10-12", "2026-02-30", "invalid"]) {
    await assert.rejects(cmdWeeklyPlan({ action: "save", week, md: "- Plan" }), /Sunday/);
  }
  await assert.rejects(cmdWeeklyPlan({ action: "save", week: WEEK, md: "  " }), /empty/);
  assert.deepEqual(requests, []);
});

test("large plan bodies are batched and a missing history anchor never overwrites content", async (t) => {
  addCanonicalPage();
  mockNotion(t);
  await cmdWeeklyPlan({
    action: "save",
    week: WEEK,
    md: Array.from({ length: 105 }, (_, index) => `- Exercise ${index}`).join("\n"),
  });
  const bodyRequests = requests.filter(
    (request) => request.pathname === "/blocks/block-1/children",
  );
  assert.deepEqual(
    bodyRequests.map((request) => request.body.children.length),
    [100, 5],
  );
  children.set(PLAN, [
    { id: "existing", type: "paragraph", paragraph: { rich_text: text("Do not replace") } },
  ]);
  const before = requests.length;
  await assert.rejects(
    cmdWeeklyPlan({ action: "save", week: WEEK, md: "- Another plan" }),
    /Plan history/,
  );
  assert.ok(requests.slice(before).every((request) => request.method === "GET"));
  assert.equal(children.get(PLAN)[0].paragraph.rich_text[0].text.content, "Do not replace");
});

test("a cached Knowledge Base moved outside the Hub cannot receive or expose plans", async (t) => {
  addPage(PLAN, "Weekly Plan", KB, [heading(ANCHOR, "Plan history")]);
  pages.get(KB).parent = { page_id: "outside" };
  pages.set("outside", { id: "outside", parent: { workspace: true } });
  writeCache({ __weeklyPlan: PLAN });
  mockNotion(t);
  await cmdWeeklyPlan({ action: "save", week: WEEK, md: "- Private plan" });
  assert.ok(
    requests.every(
      (request) =>
        request.pathname !== `/blocks/${KB}/children` &&
        request.pathname !== `/blocks/${PLAN}/children`,
    ),
  );
  assert.equal(children.get(PLAN).length, 1);
  const created = requests.find(
    (request) => request.method === "POST" && request.pathname === "/pages",
  );
  assert.equal(created.body.parent.page_id, HUB);
});
