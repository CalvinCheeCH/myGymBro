import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NOTION_TOKEN = "synthetic-food-library-test";
const { cmdLookup } = await import("../scripts/notion.mjs");

const DATABASE = "11111111111111111111111111111111";
const schema = {
  Name: { type: "title" },
  Serving: { type: "rich_text" },
  "Calories (kcal)": { type: "number" },
  "Protein (g)": { type: "number" },
  "Carbs (g)": { type: "number" },
  "Calories per 100g": { type: "number" },
  Category: { type: "select" },
  Source: { type: "select" },
  State: { type: "status" },
  Notes: { type: "rich_text" },
};
const textProperty = (type, value) => ({ type, [type]: [{ plain_text: value }] });
const numberProperty = (value) => ({ type: "number", number: value });
const optionProperty = (type, value) => ({ type, [type]: { name: value } });
const food = (name = "Oats") => ({
  properties: {
    Name: textProperty("title", name),
    Serving: textProperty("rich_text", "100 g dry"),
    "Calories (kcal)": numberProperty(370),
    "Protein (g)": numberProperty(13),
    "Carbs (g)": numberProperty(0),
    "Calories per 100g": numberProperty(370),
    Category: optionProperty("select", "Packaged"),
    Source: optionProperty("select", "Label"),
    State: optionProperty("status", "Saved"),
    Notes: textProperty("rich_text", "Private free-form note should not be included"),
  },
});

async function lookup(t, args, result) {
  const requests = [];
  const output = [];
  t.mock.method(console, "log", (value) => output.push(value));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ pathname, method: options.method, body });
    if (pathname === `/v1/databases/${DATABASE}`) {
      assert.equal(options.method, undefined);
      return Response.json({ properties: schema });
    }
    assert.equal(pathname, `/v1/databases/${DATABASE}/query`);
    assert.equal(options.method, "POST");
    return Response.json(result);
  });
  await cmdLookup({ db: DATABASE, limit: "50", ...args });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, {
    sorts: [{ property: "Name", direction: "ascending" }],
    page_size: 50,
  });
  return output;
}

test("JSON lookup retains exact serving, numeric basis, zero values and category/source, excluding free-form notes and archived rows", async (t) => {
  const archived = { ...food("Archived food"), archived: true };
  const trashed = { ...food("Trashed food"), in_trash: true };
  const output = await lookup(
    t,
    { json: true },
    { results: [food(), archived, trashed], has_more: true, next_cursor: "not-disclosed" },
  );
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]), {
    rows: [
      {
        name: "Oats",
        serving: "100 g dry",
        properties: {
          "Calories (kcal)": 370,
          "Protein (g)": 13,
          "Carbs (g)": 0,
          "Calories per 100g": 370,
          Category: "Packaged",
          Source: "Label",
          State: "Saved",
        },
      },
    ],
    hasMore: true,
  });
  assert.doesNotMatch(output[0], /Private|Notes|Archived food|Trashed food|not-disclosed/);
});

test("JSON lookup keeps missing nutrition unknown rather than substituting zero", async (t) => {
  const row = {
    properties: {
      Name: textProperty("title", "Homemade soup"),
      "Calories (kcal)": numberProperty(null),
      "Protein (g)": numberProperty(0),
    },
  };
  const output = await lookup(t, { json: true }, { results: [row], has_more: false });
  assert.deepEqual(JSON.parse(output[0]), {
    rows: [{ name: "Homemade soup", serving: "", properties: { "Protein (g)": 0 } }],
    hasMore: false,
  });
});

test("empty JSON lookup returns structured rows instead of prose", async (t) => {
  for (const result of [{ results: [], has_more: false }, {}]) {
    const output = await lookup(t, { json: true }, result);
    assert.deepEqual(JSON.parse(output[0]), { rows: [], hasMore: false });
    t.mock.restoreAll();
  }
});

test("plain lookup retains its established CLI row format and empty-state text", async (t) => {
  const output = await lookup(t, {}, { results: [food()], has_more: true });
  assert.deepEqual(output, [
    "- Oats (100 g dry) | Calories=370, Protein=13, Carbs=0, Calories per 100g=370 | Category=Packaged, Source=Label, State=Saved",
  ]);
  t.mock.restoreAll();
  const empty = await lookup(t, {}, { results: [], has_more: false });
  assert.deepEqual(empty, [`No rows in ${DATABASE} (no filter (list-all)).`]);
});
