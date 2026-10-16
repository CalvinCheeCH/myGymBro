import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DASHBOARD_OVERVIEW_MARKER,
  compactDashboardBody,
  findDashboardOverview,
  legacyDashboardDisplayIds,
} from "./notion-dashboard-layout.mjs";

const rt = (content) => [{ type: "text", text: { content } }];
const block = (id, type, content) => ({ id, type, [type]: { rich_text: rt(content) } });
const cache = () => ({
  __workspacePages: {
    dashboard: "dash",
    workouts: "workouts",
    meals: "meals",
    weeklyPlan: "plan",
    foodKnowledge: "food",
  },
  __dashboard: { columns: { nextSession: "next", progressionGuide: "progress" } },
});

test("compact dashboard has five navigation links and one managed overview instead of tile columns", () => {
  const body = compactDashboardBody(cache());
  const overview = findDashboardOverview(body);
  assert.ok(overview);
  assert.equal(overview.callout.rich_text[0].text.content, "Your daily overview");
  assert.match(
    overview.callout.children[0].paragraph.rich_text[0].text.content,
    /waiting for a workspace sync/,
  );
  assert.equal(body.filter((item) => item.type === "column_list").length, 0);
  const navigation = body.find((item) => item.type === "callout" && item !== overview);
  assert.deepEqual(
    navigation.callout.rich_text.filter((part) => part.text.link).map((part) => part.text.content),
    ["Dashboard", "Workout Log", "Meal Log", "Weekly Plan", "Food & Knowledge"],
  );
  assert.equal(
    body.filter(
      (item) =>
        item.type === "callout" &&
        item.callout.rich_text[0].text.content === DASHBOARD_OVERVIEW_MARKER,
    ).length,
    1,
  );
});

test("overview ownership requires the exact callout marker", () => {
  assert.equal(
    findDashboardOverview([block("p", "paragraph", DASHBOARD_OVERVIEW_MARKER)]),
    undefined,
  );
  assert.equal(
    findDashboardOverview([block("c", "callout", `${DASHBOARD_OVERVIEW_MARKER} notes`)]),
    undefined,
  );
  const overview = {
    id: "live",
    type: "callout",
    callout: { rich_text: [{ plain_text: DASHBOARD_OVERVIEW_MARKER }] },
  };
  assert.equal(findDashboardOverview([overview]), overview);
});

function legacyFixture() {
  const old = block("hero", "callout", "YOUR TRAINING HQ · real progress, one place");
  const list = { id: "tiles", type: "column_list" };
  const children = [
    old,
    { id: "divider", type: "divider" },
    list,
    block("custom", "paragraph", "My personal note"),
    { id: "page", type: "child_page" },
    { id: "db", type: "child_database" },
  ];
  const nested = new Map([
    [
      "tiles",
      [
        { id: "next", type: "column" },
        { id: "progress", type: "column" },
      ],
    ],
    [
      "next",
      [
        block("header-1", "callout", "Next Session"),
        block("next-context", "paragraph", "Actual saved training context"),
      ],
    ],
    ["progress", [block("header-2", "callout", "Progression")]],
  ]);
  const api = async (pathname, method) => {
    assert.equal(method, "GET", "Display discovery must not mutate any blocks");
    return { results: nested.get(pathname.split("/")[1]) ?? [], has_more: false };
  };
  return { children, nested, api };
}

test("explicit legacy rebuild identifies owned display only and preserves unknown blocks/pages/databases", async () => {
  const f = legacyFixture();
  assert.deepEqual([...(await legacyDashboardDisplayIds(f.api, f.children, cache()))].sort(), [
    "divider",
    "hero",
    "tiles",
  ]);
  assert.deepEqual(
    [...(await legacyDashboardDisplayIds(f.api, f.children, { __dashboard: { columns: {} } }))],
    ["hero"],
  );
});

test("unrecognized column layouts and nested record containers are never cleared", async () => {
  const f = legacyFixture();
  f.nested.set("progress", [block("header-2", "callout", "My custom section")]);
  assert.equal((await legacyDashboardDisplayIds(f.api, f.children, cache())).has("tiles"), false);
  f.nested.set("progress", [
    { ...block("header-2", "callout", "Progression"), has_children: true },
  ]);
  f.nested.set("header-2", [{ id: "nested-records", type: "child_database" }]);
  assert.equal((await legacyDashboardDisplayIds(f.api, f.children, cache())).has("tiles"), false);
});

test("only the exact generated legacy heatmap is removed, with adjacent personal content preserved", async () => {
  const f = legacyFixture();
  const heatmap = [
    block("heading", "heading_2", "Training Calendar"),
    block("legend", "paragraph", "⬜ rest   🟩 1   🟨 2   🟧 3   🟥 4+"),
    { id: "grid", type: "table" },
    block("summary", "paragraph", "12 sessions in the last 12 weeks."),
  ];
  const display = await legacyDashboardDisplayIds(
    f.api,
    [...heatmap, block("custom", "paragraph", "My separate calendar note")],
    cache(),
  );
  assert.deepEqual([...display], ["heading", "legend", "grid", "summary"]);
  heatmap[1] = block("legend", "paragraph", "A table I created myself");
  assert.equal((await legacyDashboardDisplayIds(f.api, heatmap, cache())).size, 0);
});
