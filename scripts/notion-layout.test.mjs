import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKSPACE_PAGES,
  compactWorkspaceLayout,
  discoverWorkspace,
  ensureWorkspacePages,
  initializeWorkspacePages,
  listLayoutChildren,
  selectWorkspaceDatabase,
  updateWorkspaceNavigation,
  workspaceNavigation,
} from "./notion-layout.mjs";

const SOURCE_NAMES = ["Programs", "Goals", "Body Stats", "Workout Log", "Meal Log", "Food Library"];
const richText = (value) => [{ type: "text", text: { content: value } }];

function fixture() {
  let sequence = 0;
  const pages = new Map([["hub", { id: "hub" }]]);
  const children = new Map([["hub", []]]);
  const databases = new Map();
  const calls = [];
  const cache = { __hub: "hub" };
  const records = {};
  const originalIds = {};
  const saveCache = () => {};
  const addPage = (id, title, parentId) => {
    pages.set(id, { id, parent: { page_id: parentId } });
    children.set(id, []);
    children.get(parentId).push({ id, type: "child_page", child_page: { title } });
  };
  addPage("dashboard", "Dashboard", "hub");
  addPage("knowledge", "Knowledge Base", "hub");
  addPage("calendar", "Training Calendar", "hub");
  addPage("exercise", "Exercise Library", "knowledge");
  cache.__dashboard = { pageId: "dashboard" };
  cache.__knowledgeBase = "knowledge";
  cache.__trainingCalendar = "calendar";
  cache.__exerciseLibrary = "exercise";
  for (const [index, title] of SOURCE_NAMES.entries()) {
    const id = `source-${index}`;
    databases.set(id, {
      id,
      title,
      parent: { page_id: "hub" },
      data_sources: [{ id: `data-${index}` }],
      properties: Object.fromEntries(
        [
          "Session",
          "Meal",
          "Name",
          "Date",
          "Serving",
          "Focus",
          "Duration (min)",
          "Status",
          "Calories (kcal)",
          "Protein (g)",
          "Source",
        ].map((name, propertyIndex) => [name, { id: `prop-${propertyIndex}` }]),
      ),
    });
    children.get("hub").push({ id, type: "child_database", child_database: { title } });
    cache[title] = id;
    originalIds[title] = id;
    records[id] = [{ id: `record-${index}`, content: `Existing ${title} data` }];
  }

  const append = (parentId, blocks, after) => {
    const result = blocks.map((block) => {
      const saved = structuredClone(block);
      saved.id = `block-${++sequence}`;
      if (saved[saved.type]?.children) {
        children.set(saved.id, []);
        append(saved.id, saved[saved.type].children);
        saved[saved.type].children = undefined;
        saved.has_children = true;
      }
      return saved;
    });
    const target = children.get(parentId);
    const index = after ? target.findIndex((block) => block.id === after) + 1 : target.length;
    target.splice(index, 0, ...result);
    return result;
  };

  async function api(pathname, method = "GET", body = undefined, version = undefined) {
    calls.push({ pathname, method, body: structuredClone(body), version });
    const path = pathname.split("?")[0];
    const [, id, action] = path.split("/");
    if (path.startsWith("blocks/") && action === "children") {
      if (method === "GET")
        return { results: structuredClone(children.get(id) ?? []), has_more: false };
      return { results: append(id, body.children, body.after) };
    }
    if (path.startsWith("databases/")) {
      const db = databases.get(id);
      assert.ok(db, `Unknown database ${id}`);
      if (method === "PATCH") {
        assert.deepEqual(Object.keys(body).sort(), ["is_inline", "parent"]);
        children.set(
          db.parent.page_id,
          children.get(db.parent.page_id).filter((block) => block.id !== id),
        );
        db.parent = body.parent;
        children
          .get(db.parent.page_id)
          .push({ id, type: "child_database", child_database: { title: db.title } });
      }
      return structuredClone(db);
    }
    if (path === "pages" && method === "POST") {
      assert.ok(body.parent.page_id, "Layout must never create or modify database records");
      const pageId = `page-${++sequence}`;
      addPage(pageId, body.properties.title.title[0].text.content, body.parent.page_id);
      return { id: pageId };
    }
    if (path.startsWith("pages/")) {
      const page = pages.get(id);
      assert.ok(page, `Unknown page ${id}`);
      if (action === "move") {
        const original = children.get(page.parent.page_id).find((block) => block.id === id);
        children.set(
          page.parent.page_id,
          children.get(page.parent.page_id).filter((block) => block.id !== id),
        );
        page.parent = body.parent;
        children.get(body.parent.page_id).push(original);
      }
      return structuredClone(page);
    }
    if (path === "views" && method === "POST") {
      const source = [...databases.values()].find((db) =>
        db.data_sources.some((data) => data.id === body.data_source_id),
      );
      const dbId = `linked-${++sequence}`;
      const viewId = `view-${++sequence}`;
      const pageId = body.create_database.parent.page_id;
      databases.set(dbId, {
        id: dbId,
        title: source.title,
        parent: { page_id: pageId },
        data_sources: structuredClone(source.data_sources),
      });
      const target = children.get(pageId);
      const anchor = target.findIndex(
        (block) => block.id === body.create_database.position.block_id,
      );
      assert.notEqual(anchor, -1, "Linked view must follow a real heading");
      target.splice(anchor + 1, 0, {
        id: dbId,
        type: "child_database",
        child_database: { title: source.title },
      });
      return { id: viewId, parent: { database_id: dbId } };
    }
    if (path.startsWith("blocks/") && method === "PATCH") {
      for (const blocks of children.values()) {
        const block = blocks.find((item) => item.id === id);
        if (block) return Object.assign(block, structuredClone(body));
      }
    }
    if (path.startsWith("blocks/") && method === "DELETE") {
      for (const [parentId, blocks] of children) {
        const block = blocks.find((item) => item.id === id);
        if (!block) continue;
        assert.equal(
          block.type,
          "callout",
          "Compaction may only remove redundant generated navigation",
        );
        children.set(
          parentId,
          blocks.filter((item) => item.id !== id),
        );
        return { id };
      }
    }
    throw new Error(`Unhandled mock API request: ${method} ${pathname}`);
  }
  return { api, cache, children, calls, records, originalIds, saveCache, databases, append };
}

async function prepare(f) {
  const layout = await ensureWorkspacePages(f.api, "hub", f.cache, f.saveCache);
  await initializeWorkspacePages(f.api, f.cache, layout.created, f.saveCache);
  return layout;
}

test("workspace navigation contains exactly five daily-use pages and preserves database cache keys", async () => {
  const f = fixture();
  await prepare(f);
  const labels = workspaceNavigation(f.cache)
    .callout.rich_text.filter((part) => part.text.link)
    .map((part) => part.text.content);
  assert.deepEqual(labels, [
    "Dashboard",
    "Workout Log",
    "Meal Log",
    "Weekly Plan",
    "Food & Knowledge",
  ]);
  for (const name of SOURCE_NAMES) assert.equal(f.cache[name], f.originalIds[name]);
  assert.notEqual(f.cache.__workspacePages.meals, f.cache["Meal Log"]);
  assert.equal(f.cache.__weeklyPlan, f.cache.__workspacePages.weeklyPlan);
  assert.equal(f.cache.__resources, f.cache.__workspacePages.resources);
});

test("setup reuses its pages and summary container without duplicating content", async () => {
  const f = fixture();
  await prepare(f);
  const summary = structuredClone(f.cache.__nutritionSummary);
  const createCount = f.calls.filter(
    (call) => call.pathname === "pages" && call.method === "POST",
  ).length;
  await prepare(f);
  assert.deepEqual(f.cache.__nutritionSummary, summary);
  assert.equal(
    f.calls.filter((call) => call.pathname === "pages" && call.method === "POST").length,
    createCount,
  );
  const meals = f.children.get(f.cache.__workspacePages.meals);
  assert.ok(
    meals.findIndex((block) => block.id === summary.blockId) <
      meals.findIndex((block) => block.type === "heading_2"),
  );
});

test("compact layout verifies linked views before moving original databases and preserves records", async () => {
  const f = fixture();
  const before = structuredClone(f.records);
  await prepare(f);
  await compactWorkspaceLayout(f.api, "hub", f.cache, f.saveCache);
  assert.equal(
    f.calls.filter((call) => call.pathname === "views" && call.method === "POST").length,
    3,
  );
  const firstMove = f.calls.findIndex(
    (call) => call.pathname.startsWith("databases/") && call.method === "PATCH",
  );
  const lastView = f.calls.findLastIndex((call) => call.pathname === "views");
  assert.ok(firstMove > lastView);
  for (const name of SOURCE_NAMES) {
    assert.equal(f.cache[name], f.originalIds[name]);
    assert.equal(f.databases.get(f.cache[name]).parent.page_id, f.cache.__resources);
  }
  assert.deepEqual(f.records, before);
  assert.deepEqual(
    f.children
      .get("hub")
      .map((block) => block.child_page?.title)
      .sort(),
    WORKSPACE_PAGES.map((page) => page.title).sort(),
  );
  const moveCount = f.calls.filter(
    (call) => call.method === "PATCH" && call.pathname.startsWith("databases/"),
  ).length;
  await compactWorkspaceLayout(f.api, "hub", f.cache, f.saveCache);
  assert.equal(f.calls.filter((call) => call.pathname === "views").length, 3);
  assert.equal(
    f.calls.filter((call) => call.method === "PATCH" && call.pathname.startsWith("databases/"))
      .length,
    moveCount,
  );
});

test("failed linked-view verification stops before any database is moved", async () => {
  const f = fixture();
  await prepare(f);
  const failingApi = async (...args) => {
    const response = await f.api(...args);
    if (args[0].startsWith("databases/linked-") && args[1] === "GET")
      response.data_sources = [{ id: "wrong-source" }];
    return response;
  };
  await assert.rejects(
    compactWorkspaceLayout(failingApi, "hub", f.cache, f.saveCache),
    /original data source/,
  );
  assert.equal(
    f.calls.some((call) => call.pathname.startsWith("databases/") && call.method === "PATCH"),
    false,
  );
});

test("cold-cache discovery chooses original resources over identically titled linked containers", async () => {
  const f = fixture();
  await prepare(f);
  await compactWorkspaceLayout(f.api, "hub", f.cache, f.saveCache);
  const discovery = await discoverWorkspace(f.api, "hub");
  const coldCache = { __workspacePages: { resources: f.cache.__resources } };
  assert.equal(
    selectWorkspaceDatabase(discovery, "Meal Log", coldCache, "hub"),
    f.originalIds["Meal Log"],
  );
  const recovered = { __workspacePages: structuredClone(f.cache.__workspacePages) };
  for (const name of SOURCE_NAMES)
    recovered[name] = selectWorkspaceDatabase(discovery, name, coldCache, "hub");
  recovered.__resources = f.cache.__resources;
  recovered.__foodKnowledge = f.cache.__foodKnowledge;
  recovered.__knowledgeBase = f.cache.__knowledgeBase;
  recovered.__trainingCalendar = f.cache.__trainingCalendar;
  const viewCount = f.calls.filter((call) => call.pathname === "views").length;
  await compactWorkspaceLayout(f.api, "hub", recovered, f.saveCache);
  assert.equal(f.calls.filter((call) => call.pathname === "views").length, viewCount);
});

test("navigation cleanup replaces only generated links and retains custom page content", async () => {
  const f = fixture();
  await prepare(f);
  const custom = f.append("dashboard", [
    { type: "callout", callout: { rich_text: richText("My personal training note") } },
  ])[0];
  const navLink = (label) => ({
    type: "text",
    text: { content: label, link: { url: "https://www.notion.so/original" } },
  });
  const personalLink = f.append("dashboard", [
    { type: "callout", callout: { rich_text: [navLink("Programs")] } },
  ])[0];
  f.append("dashboard", [
    {
      type: "callout",
      callout: {
        rich_text: ["Programs", "Goals", "Body Stats", "Workout Log", "Training Calendar"].map(
          navLink,
        ),
      },
    },
    {
      type: "callout",
      callout: {
        rich_text: ["Meal Log", "Food Library", "Exercise Library", "Knowledge Base"].map(navLink),
      },
    },
  ]);
  await updateWorkspaceNavigation(f.api, f.cache);
  assert.ok(f.children.get("dashboard").some((block) => block.id === custom.id));
  assert.ok(f.children.get("dashboard").some((block) => block.id === personalLink.id));
  const nav = f.children
    .get("dashboard")
    .filter(
      (block) =>
        block.id !== personalLink.id && block.callout?.rich_text.some((part) => part.text.link),
    );
  assert.equal(nav.length, 1);
  assert.equal(nav[0].callout.rich_text.filter((part) => part.text.link).length, 5);
});

test("incomplete pagination fails before setup can treat missing records as absent", async () => {
  await assert.rejects(
    listLayoutChildren(async () => ({ results: [], has_more: true }), "hub"),
    /next_cursor is missing/,
  );
});
