import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const originalCwd = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-plan-reset-"));
const HUB = "11111111111111111111111111111111";
const PLAN = "22222222222222222222222222222222";
const KB = "33333333333333333333333333333333";
const LEGACY = "44444444444444444444444444444444";
const cache = {
  __hub: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  __weeklyPlan: PLAN,
  __knowledgeBase: KB,
};
for (const [index, name] of [
  "Workout Log",
  "Meal Log",
  "Body Stats",
  "Goals",
  "Programs",
  "Food Library",
].entries()) {
  cache[name] = (index + 5).toString(16).repeat(32);
}
fs.mkdirSync(path.join(fixture, "data"));
fs.writeFileSync(path.join(fixture, "data", "notion-ids.json"), JSON.stringify(cache));
mock.module("../dist/config.js", {
  namedExports: { config: { notionToken: "test-token", notionParentPageId: HUB } },
});
mock.module("../dist/calendar/reset.js", {
  namedExports: {
    previewCalendarReset: async () => ({ configured: false, events: [] }),
    deleteResetCalendarEvents: async () => 0,
  },
});
process.chdir(fixture);
const { prepareReset, archiveResetData } = await import("../dist/notion/reset.js");
process.chdir(originalCwd);
after(() => {
  assert.equal(path.dirname(fixture), os.tmpdir());
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("reset clears dated and imported plan entries through Workspace archive, preserving structural pages", async (t) => {
  const requests = [];
  const block = (id, title) => ({ id, type: "child_page", child_page: { title } });
  const entry = (id, title) => ({
    id,
    type: "callout",
    callout: { rich_text: [{ plain_text: title }] },
  });
  const children = new Map([
    [HUB, [block(PLAN, "Weekly Plan"), block("food-knowledge", "Food & Knowledge")]],
    ["food-knowledge", [block("resources", "Workspace Resources")]],
    ["resources", [block("workspace-archive", "Workspace archive")]],
    ["workspace-archive", [block(KB, "Knowledge Base")]],
    [
      PLAN,
      [
        { id: "navigation", type: "paragraph" },
        { id: "history-heading", type: "heading_2" },
        entry("saved-entry", "Weekly Plan - 2026-10-11 · Saved 2026-10-16T12:00:00.000Z"),
        entry(
          "partial-entry",
          "Weekly Plan - 2026-10-04 · Saving (incomplete) 2026-10-16T11:00:00.000Z",
        ),
        entry("imported-entry", "Weekly Plan history · Upper Body Plan Week 39"),
        entry("empty-import-label", "Weekly Plan history · "),
        entry("near-import-label", "Weekly Plan history — Upper Body Plan Week 39"),
        entry("personal-note", "Do not archive this note"),
      ],
    ],
    [
      KB,
      [
        block("old-plans", "Weekly Plans"),
        block("reference", "Program Reference 2026"),
        block("exercise-library", "Exercise Library"),
      ],
    ],
    ["old-plans", [block(LEGACY, "Weekly Plan - 2026-09-27")]],
  ]);
  let tick = 0;
  t.mock.method(Date, "now", () => (tick += 1000));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const pathname = new URL(url).pathname.replace(/^\/v1\//, "");
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ pathname, method: options.method, body });
    if (options.method === "POST" && pathname.endsWith("/query"))
      return Response.json({ results: [], has_more: false });
    if (options.method === "GET") {
      const id = /^blocks\/([^/]+)\/children$/.exec(pathname)?.[1];
      assert.ok(children.has(id), `Unexpected child listing: ${pathname}`);
      return Response.json({ results: children.get(id), has_more: false });
    }
    assert.equal(options.method, "PATCH");
    assert.deepEqual(body, { archived: true });
    return Response.json({});
  });

  const { snapshot, preview } = await prepareReset();
  assert.deepEqual(
    snapshot.weeklyPlanPages.map((page) => page.id),
    [LEGACY],
  );
  assert.deepEqual(
    snapshot.weeklyPlanEntries.map((item) => item.id),
    ["saved-entry", "partial-entry", "imported-entry"],
  );
  assert.equal(preview.weeklyPlanEntries.length, 3);
  assert.ok(preview.weeklyPlanEntries.every((item) => item.parent === "Weekly Plan"));
  const result = await archiveResetData(snapshot);
  assert.equal(result.weeklyPlanPages, 1);
  assert.equal(result.weeklyPlanEntries, 3);
  assert.deepEqual(
    requests.filter((request) => request.method === "PATCH").map((request) => request.pathname),
    [`pages/${LEGACY}`, "blocks/saved-entry", "blocks/partial-entry", "blocks/imported-entry"],
  );
});
