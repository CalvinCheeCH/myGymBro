const DISPLAY_TYPES = new Set([
  "paragraph",
  "heading_3",
  "callout",
  "column_list",
  "column",
  "equation",
  "bulleted_list_item",
  "image",
  "divider",
]);

function ownPayload(block) {
  const { children: _children, ...payload } = block[block.type] ?? {};
  return payload;
}

function textRuns(parts) {
  const runs = [];
  const defaults = {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  };
  for (const part of parts) {
    if (part.type !== "text") {
      runs.push(part);
      continue;
    }
    const content = part.text.content;
    if (!content) continue;
    const style = JSON.stringify([
      ...Object.entries(defaults).map(([key, value]) => part.annotations?.[key] ?? value),
      part.text.link?.url ?? null,
    ]);
    const previous = runs.at(-1);
    if (previous?.type === "text" && previous.style === style) previous.content += content;
    else runs.push({ type: "text", content, style });
  }
  return runs;
}

function matches(actual, desired, key) {
  if (Array.isArray(desired)) {
    const current = key === "rich_text" && Array.isArray(actual) ? textRuns(actual) : actual;
    const expected = key === "rich_text" ? textRuns(desired) : desired;
    return (
      Array.isArray(current) &&
      current.length === expected.length &&
      expected.every((value, index) => matches(current[index], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(desired).every(([key, value]) => matches(actual[key], value, key))
    );
  }
  return actual === desired;
}

function validate(blocks) {
  for (const block of blocks) {
    if (!DISPLAY_TYPES.has(block.type)) {
      throw new Error(`Refusing to replace non-display Notion block: ${block.type}.`);
    }
    validate(block.children ?? block[block.type]?.children ?? []);
  }
}

/** Callers must verify this container is the workspace's generated display region. */
export async function syncNativeBlocks(api, containerId, desired) {
  const children = async (id) => {
    const results = [];
    let cursor;
    do {
      const page = await api(
        `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      results.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
      if (page.has_more && !cursor) throw new Error("Notion returned incomplete block pagination.");
    } while (cursor);
    return results;
  };
  const snapshot = async (id) =>
    Promise.all(
      (await children(id)).map(async (block) => ({
        ...block,
        children: block.has_children ? await snapshot(block.id) : [],
      })),
    );
  const old = await snapshot(containerId);
  validate(old);
  validate(desired);
  const nested = (block) => block.children ?? block[block.type]?.children ?? [];
  const result = { updated: 0, created: 0, removed: 0 };
  const placeholder = () => ({ object: "block", type: "paragraph", paragraph: { rich_text: [] } });
  const fillColumn = async (id, column) => {
    const placeholders = await children(id);
    if (
      placeholders.length !== 1 ||
      placeholders[0].type !== "paragraph" ||
      placeholders[0].paragraph.rich_text.length
    )
      throw new Error("Refusing to remove unexpected staged column content.");
    for (const child of nested(column)) await append(id, child);
    await api(`/blocks/${placeholders[0].id}`, "DELETE");
  };
  const append = async (parentId, block) => {
    const node = { object: "block", type: block.type, [block.type]: ownPayload(block) };
    if (block.type === "column_list") {
      node.column_list.children = nested(block).map((column) => ({
        object: "block",
        type: "column",
        column: {
          ...ownPayload(column),
          children: [placeholder()],
        },
      }));
    } else if (block.type === "column") {
      node.column.children = [placeholder()];
    }
    const response = await api(`/blocks/${parentId}/children`, "PATCH", { children: [node] });
    const created = response.results?.[0];
    if (!created?.id) throw new Error("Notion returned no created display block ID.");
    result.created++;
    if (block.type === "column_list") {
      const columns = await children(created.id);
      if (
        columns.length !== nested(block).length ||
        columns.some((column) => column.type !== "column")
      ) {
        throw new Error("Notion returned an unexpected staged column layout.");
      }
      for (let index = 0; index < columns.length; index++) {
        await fillColumn(columns[index].id, nested(block)[index]);
      }
    } else if (block.type === "column") {
      await fillColumn(created.id, block);
    } else {
      for (const child of nested(block)) await append(created.id, child);
    }
  };
  const reconcile = async (actual, expected, parentId) => {
    if (
      actual.length !== expected.length ||
      expected.some((block, index) => block.type !== actual[index].type)
    ) {
      for (const block of expected) await append(parentId, block);
      for (const block of actual) {
        await api(`/blocks/${block.id}`, "DELETE");
        result.removed++;
      }
      return;
    }
    for (let index = 0; index < expected.length; index++) {
      const wanted = expected[index];
      const existing = actual[index];
      if (
        !["column", "column_list"].includes(wanted.type) &&
        !matches(existing[wanted.type], ownPayload(wanted))
      ) {
        await api(`/blocks/${existing.id}`, "PATCH", { [wanted.type]: ownPayload(wanted) });
        result.updated++;
      }
      await reconcile(existing.children, nested(wanted), existing.id);
    }
  };
  await reconcile(old, desired, containerId);
  return result;
}
