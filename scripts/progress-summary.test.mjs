import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

process.env.TIMEZONE = "Etc/UTC";
process.env.NOTION_TOKEN = "synthetic-progress-summary-test";
const actual = await import("./notion.mjs");
let schema;
let queryPages;
let bodies;
let requests;
let reads;
let activeReads;
let maxActiveReads;
let bodyFailure;
let useRealBodyReader;
let useRealQuery;
mock.module("./notion.mjs", {
  namedExports: {
    ...actual,
    resolveDbId: async (name) => {
      assert.equal(name, "Workout Log");
      return "workout-db";
    },
    notion: async (pathname, method, body) => {
      requests.push({ pathname, method, body });
      if (pathname === "/databases/workout-db") return { properties: schema };
      assert.equal(pathname, "/databases/workout-db/query");
      assert.equal(method, "POST");
      if (useRealQuery) return actual.notion(pathname, method, body);
      const page = queryPages.shift();
      if (page instanceof Error) throw page;
      assert.ok(page, "Unexpected extra query");
      return page;
    },
    blocksToMarkdown: async (pageId) => {
      reads.push(pageId);
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (bodyFailure === pageId) throw new Error("Synthetic unreadable body");
        assert.ok(bodies.has(pageId), "Unexpected body read");
        return useRealBodyReader ? actual.blocksToMarkdown(pageId) : bodies.get(pageId);
      } finally {
        activeReads--;
      }
    },
  },
});
const { buildProgressSummary, fetchProgressSummary, progressReadErrorCode } = await import(
  "./progress-summary.mjs"
);
const row = (date, body, endDate = null) => ({ date, body, endDate });
const page = (id, date = "2026-10-21", status = "Done", extra = {}) => ({
  id,
  properties: {
    "Training date": { type: "date", date: { start: date } },
    "Session status": { type: "status", status: { name: status } },
  },
  ...extra,
});
const bench = "## Bench\n- 60kg x 8 x 3";
const dataPage = (results, extra = {}) => ({ results, has_more: false, ...extra });

beforeEach(() => {
  schema = {
    "Training date": { type: "date" },
    "Session status": {
      type: "status",
      status: { options: ["Done", "Planned", "Skipped"].map((name) => ({ name })) },
    },
  };
  queryPages = [];
  bodies = new Map();
  requests = [];
  reads = [];
  activeReads = 0;
  maxActiveReads = 0;
  bodyFailure = undefined;
  useRealBodyReader = false;
  useRealQuery = false;
});

test("summary declares two exact 28-day windows with empty logs and validates calendar dates", () => {
  const result = buildProgressSummary([], { date: "2026-10-21" });
  assert.deepEqual(result, {
    date: "2026-10-21",
    window: {
      start: "2026-09-24",
      end: "2026-10-21",
      trainingDays: 0,
      loggedSets: 0,
      exercises: [],
    },
    comparison: {
      start: "2026-08-27",
      end: "2026-09-23",
      trainingDays: 0,
      loggedSets: 0,
      exercises: [],
    },
    partial: false,
    warnings: [],
  });
  for (const date of ["2026-02-30", "2026-2-01", "nonsense", "2026-10-21T00:00:00Z"]) {
    assert.throws(() => buildProgressSummary([], { date }), /valid YYYY-MM-DD/);
  }
});

test("summary counts actual recorded days once, excludes future dates and uses independent comparison", () => {
  const result = buildProgressSummary(
    [
      row("2026-09-23", "Bench 3x10 @55kg"),
      row("2026-09-24", bench),
      row("2026-09-24", "## Squat\n- 80kg x 5 x 4"),
      row("2026-10-21", "Bench 2x10 @60kg"),
      row("2026-10-22", "Bench 5x5 @100kg"),
    ],
    { date: "2026-10-21" },
  );
  assert.equal(result.window.trainingDays, 2);
  assert.equal(result.window.loggedSets, 9);
  assert.deepEqual(result.window.exercises, [
    { name: "Bench", loggedSets: 5, bestSet: { loadKg: 60, reps: 10, date: "2026-10-21" } },
    { name: "Squat", loggedSets: 4, bestSet: { loadKg: 80, reps: 5, date: "2026-09-24" } },
  ]);
  assert.equal(result.comparison.trainingDays, 1);
  assert.equal(result.comparison.loggedSets, 3);
});

test("weekly records and same-day top-ups resolve across the year without double-counting days", () => {
  const result = buildProgressSummary(
    [
      row(
        "2026-12-27",
        [
          "## Thu 31/12 - Upper",
          "### Bench",
          "- 50kg x 8 x 2",
          "## Fri 1/1 - Lower",
          "### Squat",
          "- 70kg x 5 x 3",
          "**Top-up Thu 31/12**",
          "### Bench",
          "- 55kg x 6",
        ].join("\n"),
        "2027-01-02",
      ),
    ],
    { date: "2027-01-02" },
  );
  assert.equal(result.window.trainingDays, 2);
  assert.equal(result.window.loggedSets, 6);
  assert.deepEqual(result.window.exercises[0].bestSet, { loadKg: 55, reps: 6, date: "2026-12-31" });
  assert.deepEqual(result.window.exercises[1].bestSet, { loadKg: 70, reps: 5, date: "2027-01-01" });
});

test("explicit years, invalid dates, future sections and undated weekly sets are not misattributed", () => {
  const result = buildProgressSummary(
    [
      row(
        "2026-12-27",
        "## Fri 1/1/2027\n### Bench\n- 60kg x 5\n## Sat 2/1/2028\n### Bench\n- 200kg x 5",
        "2027-01-02",
      ),
      row("2026-12-27", "Bench 3x8 @400kg", "2027-01-02"),
      row("2026-12-27", "## Thu 31/2\n### Bench\n- 300kg x 5", "2027-01-02"),
    ],
    { date: "2027-01-02" },
  );
  assert.equal(result.window.trainingDays, 1);
  assert.equal(result.window.loggedSets, 1);
  assert.deepEqual(result.window.exercises[0].bestSet, { loadKg: 60, reps: 5, date: "2027-01-01" });
  assert.ok(result.warnings.some((warning) => /reliable session date/.test(warning)));
});

test("mixed units and legacy inline sets retain exact set/repetition evidence without claiming PRs", () => {
  const result = buildProgressSummary(
    [
      row("2026-10-20", "Bench 3x10 @100lb\nBench 1x12 @50kg\nBench 1x8 @50kg\nPull-ups 4x8"),
      row("2026-10-21", "## Bench\n- 100lbs x 10, 52.5kg x 6"),
    ],
    { date: "2026-10-21" },
  );
  assert.equal(result.window.loggedSets, 11);
  assert.deepEqual(result.window.exercises[0].bestSet, {
    loadKg: 52.5,
    reps: 6,
    date: "2026-10-21",
  });
  assert.deepEqual(result.window.exercises[1], { name: "Pull-ups", loggedSets: 4, bestSet: null });
  assert.doesNotMatch(JSON.stringify(result), /volume|1rm|personal record/i);
});

test("recorded activity duration counts a day while unknown text warns instead of inventing sets", () => {
  const result = buildProgressSummary(
    [
      row("2026-10-20", "**Duration: 30 min**"),
      row("2026-10-21", "I went for a gentle walk."),
      row("2026-10-19", "## Bench\n- 40kg x 0 x 2"),
      row(null, bench),
    ],
    { date: "2026-10-21", partial: true },
  );
  assert.equal(result.window.trainingDays, 1);
  assert.equal(result.window.loggedSets, 0);
  assert.equal(result.partial, true);
  assert.match(result.warnings.join(" "), /latest 60|Undated|Unrecognized|no recognizable/);
  assert.throws(
    () => buildProgressSummary([row("2026-10-21", undefined)], { date: "2026-10-21" }),
    /not completely read/,
  );
});

test("fetch uses one schema-aware query sequence, paginates and reads each eligible body once", async () => {
  queryPages = [
    dataPage([page("one"), page("two", "2026-10-20")], { has_more: true, next_cursor: "next" }),
    dataPage([page("three", "2026-10-19")]),
  ];
  for (const id of ["one", "two", "three"]) bodies.set(id, bench);
  const result = await fetchProgressSummary({ date: "2026-10-21" });
  assert.equal(result.window.trainingDays, 3);
  assert.equal(result.window.loggedSets, 9);
  assert.deepEqual([...reads].sort(), ["one", "three", "two"]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].body.filter, {
    and: [
      { property: "Training date", date: { on_or_after: "2026-08-21" } },
      { property: "Training date", date: { on_or_before: "2026-10-21" } },
      { property: "Session status", status: { does_not_equal: "Planned" } },
      { property: "Session status", status: { does_not_equal: "Skipped" } },
    ],
  });
  assert.deepEqual(requests[1].body.sorts, [
    { property: "Training date", direction: "descending" },
  ]);
  assert.equal(requests[2].body.start_cursor, "next");
});

test("fetch excludes archived, trashed, planned, skipped, future and undated rows before body reads", async () => {
  queryPages = [
    dataPage([
      page("ok"),
      page("archived", "2026-10-21", "Done", { archived: true }),
      page("trash", "2026-10-21", "Done", { in_trash: true }),
      page("planned", "2026-10-21", "Planned"),
      page("skipped", "2026-10-21", "sKiPpEd"),
      page("future", "2026-10-22"),
      page("undated", null),
    ]),
  ];
  bodies.set("ok", bench);
  const result = await fetchProgressSummary({ date: "2026-10-21" });
  assert.equal(result.window.loggedSets, 3);
  assert.deepEqual(reads, ["ok"]);
});

test("fetch caps body reads at sixty with four workers and marks incomplete totals", async () => {
  queryPages = [dataPage(Array.from({ length: 61 }, (_, index) => page(`row-${index}`)))];
  for (let index = 0; index < 60; index++) bodies.set(`row-${index}`, bench);
  const result = await fetchProgressSummary({ date: "2026-10-21" });
  assert.equal(result.partial, true);
  assert.equal(reads.length, 60);
  assert.equal(maxActiveReads, 4);
  assert.equal(result.window.trainingDays, 1);
  assert.equal(result.window.loggedSets, 180);
});

test("fetch fails closed on missing schema, unreadable bodies, malformed rows and incomplete pagination", async () => {
  schema = { Name: { type: "title" } };
  await assert.rejects(fetchProgressSummary({ date: "2026-10-21" }), /date property/);
  schema = { "Training date": { type: "date" } };
  for (const broken of [
    {},
    { results: [], has_more: true },
    dataPage([], { has_more: true, next_cursor: "repeat" }),
  ]) {
    queryPages = [broken, dataPage([], { has_more: true, next_cursor: "repeat" })];
    await assert.rejects(
      fetchProgressSummary({ date: "2026-10-21" }),
      /invalid rows|pagination is incomplete/,
    );
  }
  queryPages = [dataPage([page("unreadable")])];
  bodyFailure = "unreadable";
  await assert.rejects(fetchProgressSummary({ date: "2026-10-21" }), /Synthetic unreadable/);
});

test("real body pagination errors fail the whole summary instead of publishing partial workout facts", async (t) => {
  queryPages = [dataPage([page("paged-body")])];
  bodies.set("paged-body", "unused placeholder");
  useRealBodyReader = true;
  const fetched = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    fetched.push(new URL(url).pathname + new URL(url).search);
    return Response.json({
      results: [{ type: "heading_2", heading_2: { rich_text: [{ plain_text: "Bench" }] } }],
      has_more: true,
      ...(fetched.length === 1 ? { next_cursor: "body-next" } : {}),
    });
  });
  await assert.rejects(
    fetchProgressSummary({ date: "2026-10-21" }),
    /child pagination is incomplete/,
  );
  assert.deepEqual(fetched, [
    "/v1/blocks/paged-body/children",
    "/v1/blocks/paged-body/children?start_cursor=body-next",
  ]);
});

test("status properties can be renamed and duplicate pagination rows are read once", async () => {
  schema = {
    "Training date": { type: "date" },
    State: {
      type: "status",
      status: { options: ["Done", "Planned", "Skipped"].map((name) => ({ name })) },
    },
  };
  const renamed = (id, status) => {
    const result = page(id);
    result.properties.State = { type: "status", status: { name: status } };
    result.properties["Session status"] = undefined;
    return result;
  };
  queryPages = [
    dataPage([renamed("one", "Done"), renamed("one", "Done"), renamed("plan", "Planned")]),
  ];
  bodies.set("one", bench);
  const result = await fetchProgressSummary({ date: "2026-10-21" });
  assert.equal(result.window.loggedSets, 3);
  assert.deepEqual(reads, ["one"]);
  assert.deepEqual(requests[1].body.filter.and[2], {
    property: "State",
    status: { does_not_equal: "Planned" },
  });
});

test("select status filters use only existing options, including a workspace with no Planned option", async (t) => {
  schema["Session status"] = {
    type: "select",
    select: { options: ["Completed", "Partial", "Skipped"].map((name) => ({ name })) },
  };
  useRealQuery = true;
  const rows = ["Completed", "Partial", "Skipped"].map((name) => {
    const result = page(name.toLowerCase());
    result.properties["Session status"] = { type: "select", select: { name } };
    return result;
  });
  let sentQuery;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).pathname, "/v1/databases/workout-db/query");
    sentQuery = JSON.parse(options.body);
    const validOptions = schema["Session status"].select.options.map((option) => option.name);
    for (const filter of sentQuery.filter.and) {
      if (filter.select && !validOptions.includes(filter.select.does_not_equal)) {
        return Response.json(
          { message: "Unknown select option in query filter." },
          { status: 400 },
        );
      }
    }
    return Response.json(dataPage(rows));
  });
  bodies.set("completed", bench);
  bodies.set("partial", bench);
  const result = await fetchProgressSummary({ date: "2026-10-21" });
  assert.equal(result.window.loggedSets, 6);
  assert.deepEqual(reads.sort(), ["completed", "partial"]);
  assert.deepEqual(sentQuery.filter.and.slice(2), [
    { property: "Session status", select: { does_not_equal: "Skipped" } },
  ]);
});

test("status exclusion matches case insensitively while preserving the stored option names", async () => {
  schema["Session status"].status.options = ["Completed", "planned", "sKiPpEd"].map((name) => ({
    name,
  }));
  queryPages = [dataPage([page("complete", "2026-10-21", "Completed")])];
  bodies.set("complete", bench);
  await fetchProgressSummary({ date: "2026-10-21" });
  assert.deepEqual(requests[1].body.filter.and.slice(2), [
    { property: "Session status", status: { does_not_equal: "planned" } },
    { property: "Session status", status: { does_not_equal: "sKiPpEd" } },
  ]);
});

test("missing option metadata or no excluded options never invent status filters", async () => {
  for (const definition of [
    { type: "select" },
    { type: "status", status: {} },
    { type: "select", select: { options: [{ name: "Completed" }, { name: "Partial" }] } },
  ]) {
    schema["Session status"] = definition;
    requests = [];
    reads = [];
    queryPages = [
      dataPage([
        page("complete", "2026-10-21", "Completed"),
        page("planned", "2026-10-21", "Planned"),
        page("skipped", "2026-10-21", "Skipped"),
      ]),
    ];
    bodies.set("complete", bench);
    const result = await fetchProgressSummary({ date: "2026-10-21" });
    assert.equal(result.window.loggedSets, 3);
    assert.deepEqual(reads, ["complete"]);
    assert.equal(requests[1].body.filter.and.length, 2);
  }
});

test("legacy weekly titles do not turn undated sets into a Sunday workout", async () => {
  schema.Name = { type: "title" };
  const weekly = page("legacy-weekly", "2026-10-18");
  weekly.properties.Name = {
    type: "title",
    title: [{ plain_text: "Week of 18/10/2026 - private note never returned" }],
  };
  const dated = page("dated-weekly", "2026-10-18");
  dated.properties.Name = { type: "title", title: [{ plain_text: "Week of 18/10/2026" }] };
  queryPages = [dataPage([weekly, dated])];
  bodies.set("legacy-weekly", "Bench 3x8 @100kg");
  bodies.set("dated-weekly", "## Tue 20/10 - Upper\n### Bench\n- 60kg x 8 x 2");
  const result = await fetchProgressSummary({ date: "2026-10-21" });
  assert.equal(result.window.trainingDays, 1);
  assert.equal(result.window.loggedSets, 2);
  assert.deepEqual(result.window.exercises[0].bestSet, { loadKg: 60, reps: 8, date: "2026-10-20" });
  assert.match(result.warnings.join(" "), /without a reliable session date/);
  assert.doesNotMatch(JSON.stringify(result), /private note|Week of|legacy-weekly|dated-weekly/);
});

test("progress diagnostics expose only an allowlisted HTTP status or a generic failure code", () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
    assert.equal(
      progressReadErrorCode(new Error(`Notion POST /private-path -> ${status}: private record`)),
      `NOTION_${status}`,
    );
  }
  for (const error of [
    new Error("Notion POST /private-path -> 599: private record"),
    new Error("private notes or credential-like content"),
    { message: "Notion POST /private-path -> 400: private record" },
    null,
  ]) {
    assert.equal(progressReadErrorCode(error), "READ_FAILED");
  }
});
