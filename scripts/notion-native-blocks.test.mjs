import assert from "node:assert/strict";
import { test } from "node:test";
import { syncNativeBlocks } from "./notion-native-blocks.mjs";

const text = (content) => [{ type: "text", text: { content } }];
const paragraph = (content) => ({ type: "paragraph", paragraph: { rich_text: text(content) } });
const callout = (children) => ({
  type: "callout",
  callout: { rich_text: text("Summary"), children },
});
const layout = (value = "15\\%") => [
  callout([
    {
      type: "column_list",
      column_list: {
        children: [
          {
            type: "column",
            column: {
              children: [callout([{ type: "equation", equation: { expression: value } }])],
            },
          },
          { type: "column", column: { children: [paragraph("Meals")] } },
        ],
      },
    },
  ]),
];

function fixture(initial, failAppendAt = 0) {
  const nodes = new Map();
  const lists = new Map([["container", []]]);
  const calls = [];
  let sequence = 0;
  let appends = 0;
  const insert = (parent, block) => {
    const id = `block-${++sequence}`;
    const { children = [], ...own } = structuredClone(block[block.type] ?? {});
    const node = {
      object: "block",
      id,
      type: block.type,
      [block.type]: own,
      parent: { block_id: parent },
      has_children: !!children.length,
    };
    if (own.rich_text) for (const item of own.rich_text) item.plain_text = item.text.content;
    nodes.set(id, node);
    lists.set(id, []);
    lists.get(parent).push(id);
    for (const child of children) insert(id, child);
    if (nodes.has(parent)) nodes.get(parent).has_children = true;
    return node;
  };
  for (const block of initial) insert("container", block);
  const depth = (block) => {
    const children = block[block.type]?.children ?? [];
    return children.length ? 1 + Math.max(...children.map(depth)) : 0;
  };
  const api = async (url, method = "GET", body = undefined) => {
    calls.push({ url, method, body: structuredClone(body) });
    const path = url.split("?")[0];
    const [, id, suffix] = /^\/blocks\/([^/]+)(\/children)?$/.exec(path) ?? [];
    assert.ok(id, `Unexpected API path ${path}`);
    if (method === "GET" && suffix)
      return {
        results: structuredClone(lists.get(id).map((child) => nodes.get(child))),
        has_more: false,
      };
    if (method === "PATCH" && suffix) {
      appends++;
      if (appends === failAppendAt) throw new Error("Append failed");
      assert.ok(
        body.children.every((block) => depth(block) <= 2),
        "Notion append nesting exceeds two levels",
      );
      return { results: body.children.map((block) => structuredClone(insert(id, block))) };
    }
    const node = nodes.get(id);
    assert.ok(node, `Unknown block ${id}`);
    if (method === "DELETE") {
      const siblings = lists.get(node.parent.block_id);
      siblings.splice(siblings.indexOf(id), 1);
      return {};
    }
    assert.equal(method, "PATCH");
    Object.assign(node, structuredClone(body));
    return structuredClone(node);
  };
  return { api, calls, nodes, lists };
}

test("unchanged native content writes nothing despite Notion response metadata", async () => {
  const state = fixture(layout());
  assert.deepEqual(await syncNativeBlocks(state.api, "container", layout()), {
    updated: 0,
    created: 0,
    removed: 0,
  });
  assert.ok(state.calls.every((call) => call.method === "GET"));
});

test("a nutrition value change patches only its existing equation", async () => {
  const state = fixture(layout());
  const result = await syncNativeBlocks(state.api, "container", layout("25\\%"));
  assert.equal(result.updated, 1);
  const writes = state.calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { equation: { expression: "25\\%" } });
});

test("layout changes stage deep columns within Notion's two-level append limit", async () => {
  const state = fixture([
    {
      type: "image",
      image: { type: "external", external: { url: "https://example.com/old.png" } },
    },
  ]);
  const oldRoot = state.lists.get("container")[0];
  const result = await syncNativeBlocks(state.api, "container", layout());
  assert.equal(result.removed, 1);
  assert.ok(result.created > 1);
  assert.equal(state.calls.at(-1).url, `/blocks/${oldRoot}`);
  assert.equal(state.calls.at(-1).method, "DELETE");
  assert.deepEqual(await syncNativeBlocks(state.api, "container", layout()), {
    updated: 0,
    created: 0,
    removed: 0,
  });
});

test("unexpected nested data blocks prevent every write", async () => {
  for (const type of ["child_page", "child_database", "unsupported"]) {
    const state = fixture([
      callout([paragraph("Before"), { type, [type]: { title: "Keep my source" } }]),
    ]);
    await assert.rejects(
      syncNativeBlocks(state.api, "container", layout()),
      /Refusing to replace non-display/,
    );
    assert.ok(state.calls.every((call) => call.method === "GET"));
  }
  const state = fixture([paragraph("Keep")]);
  await assert.rejects(
    syncNativeBlocks(state.api, "container", [
      { type: "child_page", child_page: { title: "Bad" } },
    ]),
    /Refusing to replace non-display/,
  );
  assert.ok(state.calls.every((call) => call.method === "GET"));
});

test("an incomplete staged layout never deletes the previous display", async () => {
  const state = fixture([paragraph("Previous complete dashboard")], 4);
  const oldRoot = state.lists.get("container")[0];
  await assert.rejects(syncNativeBlocks(state.api, "container", layout()), /Append failed/);
  assert.ok(state.lists.get("container").includes(oldRoot));
  assert.ok(
    !state.calls.some((call) => call.url === `/blocks/${oldRoot}` && call.method === "DELETE"),
  );
});

test("one new meal rebuilds only its column and preserves every unrelated block ID", async () => {
  const state = fixture(layout());
  const oldRoots = [...state.lists.get("container")];
  const ring = [...state.nodes.values()].find((node) => node.type === "equation");
  const meal = [...state.nodes.values()].find((node) => node.type === "paragraph");
  const desired = layout();
  const mealChildren = desired[0].callout.children[0].column_list.children[1].column.children;
  mealChildren.push({
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: text("Overnight oats") },
  });
  const result = await syncNativeBlocks(state.api, "container", desired);
  assert.deepEqual(result, { updated: 0, created: 2, removed: 1 });
  assert.deepEqual(state.lists.get("container"), oldRoots);
  assert.equal(state.nodes.get(ring.id).equation.expression, "15\\%");
  const deletes = state.calls.filter((call) => call.method === "DELETE");
  assert.deepEqual(
    deletes.map((call) => call.url),
    [`/blocks/${meal.id}`],
  );
  const appends = state.calls.filter(
    (call) => call.method === "PATCH" && call.url.endsWith("/children"),
  );
  assert.ok(appends.every((call) => call.url === `/blocks/${meal.parent.block_id}/children`));
  const writesBeforeDelete = state.calls
    .slice(0, state.calls.indexOf(deletes[0]))
    .filter((call) => call.method === "PATCH");
  assert.equal(writesBeforeDelete.length, 2);
  assert.deepEqual(await syncNativeBlocks(state.api, "container", desired), {
    updated: 0,
    created: 0,
    removed: 0,
  });
});

test("Notion can merge same-style heatmap text runs without causing repeated writes", async () => {
  const span = (content, color = "gray") => ({
    type: "text",
    text: { content },
    annotations: { code: true, color },
  });
  const cells = [
    span("Mon  "),
    ...Array.from({ length: 8 }, () => span("□ ")),
    span("▪ ", "green"),
    span("▪ ", "green"),
    span("□ "),
    span("· "),
  ];
  const desired = [{ type: "paragraph", paragraph: { rich_text: cells } }];
  const state = fixture(desired);
  const node = [...state.nodes.values()][0];
  node.paragraph.rich_text = [
    { ...span("Mon  □ □ □ □ □ □ □ □ "), plain_text: "response metadata", href: null },
    span("▪ ▪ ", "green"),
    span("□ · "),
  ].map((part) => ({
    ...part,
    annotations: {
      color: part.annotations.color,
      code: true,
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
    },
    text: { ...part.text, link: null },
  }));
  assert.deepEqual(await syncNativeBlocks(state.api, "container", desired), {
    updated: 0,
    created: 0,
    removed: 0,
  });
  assert.ok(state.calls.every((call) => call.method === "GET"));
  desired[0].paragraph.rich_text[5] = span("▪ ", "green");
  assert.equal((await syncNativeBlocks(state.api, "container", desired)).updated, 1);
  const writes = state.calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.paragraph.rich_text.length, 13);
});

test("text comparison ignores dropped empty spans but preserves links and exact whitespace", async () => {
  const desired = [paragraph("Hello ")];
  desired[0].paragraph.rich_text.unshift({ type: "text", text: { content: "" } });
  const state = fixture([paragraph("Hello ")]);
  assert.equal((await syncNativeBlocks(state.api, "container", desired)).updated, 0);
  desired[0].paragraph.rich_text[1].text.link = { url: "https://example.com/record" };
  assert.equal((await syncNativeBlocks(state.api, "container", desired)).updated, 1);
  desired[0].paragraph.rich_text[1].text.content = "Hello";
  assert.equal((await syncNativeBlocks(state.api, "container", desired)).updated, 1);
});
