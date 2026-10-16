/** Five daily-use pages, with source databases preserved behind their own views. */
export const LAYOUT_API_VERSION = "2026-03-11";
export const WORKSPACE_PAGES = [
  { key: "dashboard", title: "Dashboard", icon: "🏠" },
  { key: "workouts", title: "Workout Log", icon: "🏋️" },
  { key: "meals", title: "Meal Log", icon: "🍽️" },
  { key: "weeklyPlan", title: "Weekly Plan", icon: "📅" },
  { key: "foodKnowledge", title: "Food & Knowledge", icon: "📚" },
];

const idKey = (id) =>
  String(id ?? "")
    .replace(/-/g, "")
    .toLowerCase();
const text = (content) => [{ type: "text", text: { content } }];
const paragraph = (content) => ({ type: "paragraph", paragraph: { rich_text: text(content) } });
const heading = (content) => ({ type: "heading_2", heading_2: { rich_text: text(content) } });
const pageLink = (label, id) => ({
  type: "text",
  text: { content: label, link: { url: `https://www.notion.so/${idKey(id)}` } },
});
const blockText = (block) =>
  (block[block.type]?.rich_text ?? [])
    .map((part) => part.plain_text ?? part.text?.content ?? "")
    .join("");

export async function listLayoutChildren(api, pageId) {
  const blocks = [];
  let cursor;
  do {
    const response = await api(
      `blocks/${pageId}/children${cursor ? `?start_cursor=${cursor}` : ""}`,
      "GET",
    );
    blocks.push(...(response.results ?? []));
    if (response.has_more && !response.next_cursor)
      throw new Error("Workspace discovery is incomplete: next_cursor is missing.");
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

/** Walk physical child pages, never database rows or cross-workspace linked pages. */
export async function discoverWorkspace(api, hub) {
  const pages = [];
  const databases = [];
  const visited = new Set();
  const pending = [hub];
  while (pending.length) {
    const parentId = pending.shift();
    if (visited.has(idKey(parentId))) continue;
    visited.add(idKey(parentId));
    for (const block of await listLayoutChildren(api, parentId)) {
      if (block.archived || block.in_trash) continue;
      if (block.type === "child_database") {
        databases.push({ id: block.id, title: block.child_database.title, parentId });
      } else if (block.type === "child_page") {
        pages.push({ id: block.id, title: block.child_page.title, parentId });
        pending.push(block.id);
      }
    }
  }
  return { pages, databases };
}

function findPage(discovery, title, preferredId, parentId) {
  const matches = discovery.pages.filter((page) => page.title === title);
  const cached = matches.find((page) => idKey(page.id) === idKey(preferredId));
  if (cached) return cached.id;
  const direct = matches.filter((page) => idKey(page.parentId) === idKey(parentId));
  if (direct.length === 1) return direct[0].id;
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1)
    throw new Error(`Several pages named ${title} exist. Resolve the intended page before setup.`);
  return null;
}

export function selectWorkspaceDatabase(discovery, title, cache, hub) {
  const pinned = discovery.databases.find((db) => idKey(db.id) === idKey(cache[title]));
  if (pinned) return pinned.id;
  const matches = discovery.databases.filter(
    (db) => db.title.toLowerCase() === title.toLowerCase(),
  );
  // Linked database containers are navigation, not new storage. Prefer the
  // canonical source location when rebuilding a cache after it was lost.
  for (const parentId of [cache.__workspacePages?.resources, cache.__resources, hub]) {
    if (!parentId) continue;
    const sources = matches.filter((db) => idKey(db.parentId) === idKey(parentId));
    if (sources.length === 1) return sources[0].id;
    if (sources.length > 1) break;
  }
  const linkedIds = new Set(
    Object.values(cache.__workspaceViews ?? {}).map((view) => idKey(view.databaseId)),
  );
  const sources = matches.filter((db) => !linkedIds.has(idKey(db.id)));
  if (sources.length === 1) return sources[0].id;
  if (sources.length > 1)
    throw new Error(
      `Several databases named ${title} exist. Setup will not guess or create a replacement.`,
    );
  return null;
}

export function workspaceNavigation(cache) {
  const rich = [];
  for (const page of WORKSPACE_PAGES) {
    const id = cache.__workspacePages?.[page.key];
    if (!id) continue;
    if (rich.length) rich.push({ type: "text", text: { content: "   ·   " } });
    rich.push(pageLink(page.title, id));
  }
  return {
    type: "callout",
    callout: { icon: { type: "emoji", emoji: "🧭" }, color: "gray_background", rich_text: rich },
  };
}

function resourceLink(label, id) {
  return { type: "paragraph", paragraph: { rich_text: [pageLink(label, id)] } };
}

export function workspacePageBody(key, cache) {
  const nav = workspaceNavigation(cache);
  if (key === "workouts")
    return [
      paragraph(
        "Your recorded training days, with sets, reps, loads, and measured session duration together.",
      ),
      nav,
      heading("Recorded workouts"),
      resourceLink("Open the Workout Log database", cache["Workout Log"]),
      heading("Training calendar"),
      resourceLink("Open your full Training Calendar", cache.__trainingCalendar),
    ];
  if (key === "meals")
    return [
      paragraph(
        "Today's recorded intake first, then your meal history. Totals reflect logged meals and your own targets.",
      ),
      nav,
      {
        type: "callout",
        callout: {
          rich_text: text("Daily nutrition"),
          icon: { type: "emoji", emoji: "🍽️" },
          color: "green_background",
          children: [
            paragraph("Log a meal and sync the workspace to see today's recorded intake."),
          ],
        },
      },
      heading("Recorded meals"),
      resourceLink("Open the Meal Log database", cache["Meal Log"]),
    ];
  if (key === "weeklyPlan")
    return [
      paragraph(
        "Your newest saved plan appears first below. Ask /plan in Telegram to save a dated plan based on your goals and actual history.",
      ),
      nav,
      heading("Plan history"),
    ];
  if (key === "foodKnowledge")
    return [
      paragraph(
        "Keep repeat foods, exercise variations, and useful references close to your routine.",
      ),
      nav,
      heading("Food Library"),
      resourceLink("Open your saved Food Library", cache["Food Library"]),
      paragraph(
        "Serving and source matter. Label values and estimates retain their original basis when reused.",
      ),
      heading("Training knowledge"),
      resourceLink("Knowledge Base", cache.__knowledgeBase),
      resourceLink("Exercise Library", cache.__exerciseLibrary),
      heading("Workspace resources"),
      resourceLink("Programs, goals, body stats, and source databases", cache.__resources),
    ];
  if (key === "resources")
    return [
      paragraph(
        "Supporting records live here so your main navigation stays focused. These are the original databases used by the coach.",
      ),
      ...["Programs", "Goals", "Body Stats", "Workout Log", "Meal Log", "Food Library"].map(
        (name) => resourceLink(name, cache[name]),
      ),
    ];
  return [];
}

export async function ensureWorkspacePages(api, hub, cache, saveCache) {
  const discovery = await discoverWorkspace(api, hub);
  const created = new Set();
  cache.__workspacePages ??= {};
  for (const page of [
    ...WORKSPACE_PAGES,
    { key: "resources", title: "Workspace Resources", icon: "🗂️" },
  ]) {
    const parentId = page.key === "resources" ? cache.__workspacePages.foodKnowledge : hub;
    const legacyId =
      page.key === "dashboard"
        ? cache.__dashboard?.pageId
        : page.key === "weeklyPlan"
          ? cache.__weeklyPlan
          : undefined;
    let id = findPage(
      discovery,
      page.title,
      cache.__workspacePages[page.key] ?? legacyId,
      parentId,
    );
    if (!id) {
      const result = await api("pages", "POST", {
        parent: { type: "page_id", page_id: parentId },
        icon: { type: "emoji", emoji: page.icon },
        properties: { title: { title: text(page.title) } },
      });
      id = result.id;
      created.add(idKey(id));
      discovery.pages.push({ id, title: page.title, parentId });
      console.log(`+ created ${page.title} page (${id})`);
    }
    cache.__workspacePages[page.key] = id;
    saveCache(cache);
  }
  cache.__weeklyPlan = cache.__workspacePages.weeklyPlan;
  cache.__foodKnowledge = cache.__workspacePages.foodKnowledge;
  cache.__resources = cache.__workspacePages.resources;
  cache.__mealLogPage = cache.__workspacePages.meals;
  saveCache(cache);
  return { discovery, created };
}

export async function initializeWorkspacePages(api, cache, created, saveCache) {
  for (const key of ["workouts", "meals", "weeklyPlan", "foodKnowledge", "resources"]) {
    const pageId = cache.__workspacePages[key];
    let children = await listLayoutChildren(api, pageId);
    if (created.has(idKey(pageId)) || children.length === 0) {
      const result = await api(`blocks/${pageId}/children`, "PATCH", {
        children: workspacePageBody(key, cache),
      });
      children = result.results ?? [];
    }
    if (key === "meals") {
      let summary = children.find(
        (block) => block.type === "callout" && blockText(block) === "Daily nutrition",
      );
      if (!summary) {
        const first = children[0];
        if (first && first.type !== "paragraph")
          throw new Error(
            "The Meal Log page needs an introductory paragraph before its nutrition summary can be inserted safely.",
          );
        const result = await api(`blocks/${pageId}/children`, "PATCH", {
          children: [
            workspacePageBody("meals", cache).find(
              (block) => block.type === "callout" && blockText(block) === "Daily nutrition",
            ),
          ],
          ...(first ? { after: first.id } : {}),
        });
        summary = result.results?.[0];
      }
      if (!summary?.id) throw new Error("Daily nutrition summary container could not be captured.");
      cache.__nutritionSummary = { pageId, blockId: summary.id };
      saveCache(cache);
    }
  }
}

const SOURCE_VIEWS = [
  {
    key: "workouts",
    db: "Workout Log",
    page: "workouts",
    heading: "Recorded workouts",
    name: "Recent training days",
    visible: ["Session", "Date", "Focus", "Duration (min)", "Status"],
    sort: "Date",
  },
  {
    key: "meals",
    db: "Meal Log",
    page: "meals",
    heading: "Recorded meals",
    name: "Recent meal days",
    visible: ["Meal", "Date", "Calories (kcal)", "Protein (g)"],
    sort: "Date",
  },
  {
    key: "foodLibrary",
    db: "Food Library",
    page: "foodKnowledge",
    heading: "Food Library",
    name: "Saved foods",
    visible: ["Name", "Serving", "Calories (kcal)", "Protein (g)", "Source"],
    sort: "Name",
  },
];

export async function ensureSourceViews(api, cache, saveCache) {
  cache.__workspaceViews ??= {};
  for (const spec of SOURCE_VIEWS) {
    const sourceId = cache[spec.db];
    const pageId = cache.__workspacePages[spec.page];
    const source = await api(`databases/${sourceId}`, "GET", undefined, LAYOUT_API_VERSION);
    if (source.data_sources?.length !== 1)
      throw new Error(`${spec.db} needs exactly one data source to build a linked view safely.`);
    const dataSourceId = source.data_sources[0].id;
    const previous = cache.__workspaceViews[spec.key];
    if (previous?.databaseId && idKey(previous.sourceDatabaseId) === idKey(sourceId)) {
      const children = await listLayoutChildren(api, pageId);
      if (children.some((block) => idKey(block.id) === idKey(previous.databaseId))) {
        const linked = await api(
          `databases/${previous.databaseId}`,
          "GET",
          undefined,
          LAYOUT_API_VERSION,
        );
        if (linked.data_sources?.some((dataSource) => idKey(dataSource.id) === idKey(dataSourceId)))
          continue;
      }
    }
    const children = await listLayoutChildren(api, pageId);
    // Recover an existing linked view before creating another after a cache loss.
    let recovered;
    for (const child of children.filter((block) => block.type === "child_database")) {
      const linked = await api(`databases/${child.id}`, "GET", undefined, LAYOUT_API_VERSION);
      if (
        idKey(child.id) !== idKey(sourceId) &&
        linked.data_sources?.some((dataSource) => idKey(dataSource.id) === idKey(dataSourceId))
      ) {
        recovered = child.id;
        break;
      }
    }
    if (recovered) {
      cache.__workspaceViews[spec.key] = {
        databaseId: recovered,
        sourceDatabaseId: sourceId,
        dataSourceId,
      };
      saveCache(cache);
      continue;
    }
    let anchor = children.find(
      (block) => block.type === "heading_2" && blockText(block) === spec.heading,
    );
    if (!anchor) {
      const result = await api(`blocks/${pageId}/children`, "PATCH", {
        children: [heading(spec.heading)],
      });
      anchor = result.results?.[0];
    }
    if (!anchor?.id) throw new Error(`The ${spec.heading} view anchor could not be created.`);
    const legacySchema = await api(`databases/${sourceId}`, "GET");
    const view = await api(
      "views",
      "POST",
      {
        create_database: {
          parent: { type: "page_id", page_id: pageId },
          position: { type: "after_block", block_id: anchor.id },
        },
        data_source_id: dataSourceId,
        name: spec.name,
        type: "table",
        sorts: [
          { property: spec.sort, direction: spec.sort === "Date" ? "descending" : "ascending" },
        ],
        configuration: {
          type: "table",
          properties: Object.entries(legacySchema.properties ?? {}).map(([name, property]) => ({
            property_id: property.id,
            visible: spec.visible.includes(name),
          })),
          wrap_cells: true,
          show_vertical_lines: false,
        },
      },
      LAYOUT_API_VERSION,
    );
    const databaseId = view.parent?.database_id;
    if (!databaseId) throw new Error(`Notion did not return the linked ${spec.db} database id.`);
    const linked = await api(`databases/${databaseId}`, "GET", undefined, LAYOUT_API_VERSION);
    if (!linked.data_sources?.some((dataSource) => idKey(dataSource.id) === idKey(dataSourceId)))
      throw new Error(`Linked ${spec.db} view does not reference the original data source.`);
    cache.__workspaceViews[spec.key] = {
      viewId: view.id,
      databaseId,
      sourceDatabaseId: sourceId,
      dataSourceId,
    };
    saveCache(cache);
    console.log(`+ linked ${spec.db} on its daily-use page`);
  }
}

export async function compactWorkspaceLayout(api, hub, cache, saveCache) {
  // All three usable source views must be verified before any source is moved.
  await ensureSourceViews(api, cache, saveCache);
  for (const name of [
    "Programs",
    "Goals",
    "Body Stats",
    "Workout Log",
    "Meal Log",
    "Food Library",
  ]) {
    const id = cache[name];
    const db = await api(`databases/${id}`, "GET", undefined, LAYOUT_API_VERSION);
    if (idKey(db.parent?.page_id) === idKey(cache.__resources)) continue;
    await api(
      `databases/${id}`,
      "PATCH",
      { parent: { type: "page_id", page_id: cache.__resources }, is_inline: false },
      LAYOUT_API_VERSION,
    );
    const moved = await api(`databases/${id}`, "GET", undefined, LAYOUT_API_VERSION);
    const sourceIds = (value) =>
      (value.data_sources ?? [])
        .map((source) => idKey(source.id))
        .sort()
        .join(",");
    if (
      idKey(moved.id) !== idKey(id) ||
      idKey(moved.parent?.page_id) !== idKey(cache.__resources) ||
      sourceIds(moved) !== sourceIds(db)
    )
      throw new Error(
        `${name} could not be verified after moving. Its original id remains in the cache.`,
      );
    console.log(`~ grouped original ${name} database in Workspace Resources`);
  }
  for (const [id, parentId] of [
    ...WORKSPACE_PAGES.map((page) => [cache.__workspacePages[page.key], hub]),
    [cache.__resources, cache.__foodKnowledge],
    [cache.__knowledgeBase, cache.__foodKnowledge],
    [cache.__trainingCalendar, cache.__workspacePages.workouts],
  ]) {
    const page = await api(`pages/${id}`, "GET");
    if (idKey(page.parent?.page_id) === idKey(parentId)) continue;
    await api(
      `pages/${id}/move`,
      "POST",
      { parent: { type: "page_id", page_id: parentId } },
      LAYOUT_API_VERSION,
    );
    const moved = await api(`pages/${id}`, "GET");
    if (idKey(moved.parent?.page_id) !== idKey(parentId))
      throw new Error("A supporting page could not be verified after moving.");
  }
  cache.__layoutVersion = 1;
  cache.__hub = hub;
  saveCache(cache);
}

export async function updateWorkspaceNavigation(api, cache) {
  const labels = new Set([
    ...WORKSPACE_PAGES.map((page) => page.title),
    "Programs",
    "Goals",
    "Body Stats",
    "Training Calendar",
    "Food Library",
    "Exercise Library",
    "Knowledge Base",
  ]);
  for (const page of WORKSPACE_PAGES) {
    const pageId = cache.__workspacePages[page.key];
    const children = await listLayoutChildren(api, pageId);
    const navigation = children.filter((block) => {
      if (block.type !== "callout") return false;
      const rich = block.callout.rich_text ?? [];
      const linkedLabels = rich
        .filter((part) => part.text?.link || part.href)
        .map((part) => part.plain_text ?? part.text?.content ?? "");
      const mainNavigation = WORKSPACE_PAGES.every((item) => linkedLabels.includes(item.title));
      const legacyTraining = ["Programs", "Goals", "Body Stats", "Workout Log"].every((label) =>
        linkedLabels.includes(label),
      );
      const legacyReferences = ["Meal Log", "Food Library", "Knowledge Base"].every((label) =>
        linkedLabels.includes(label),
      );
      return (
        (mainNavigation || legacyTraining || legacyReferences) &&
        rich.every((part) => {
          const content = part.plain_text ?? part.text?.content ?? "";
          return part.text?.link || part.href ? labels.has(content) : /^[\s·]*$/.test(content);
        })
      );
    });
    if (navigation.length) {
      await api(`blocks/${navigation[0].id}`, "PATCH", {
        callout: workspaceNavigation(cache).callout,
      });
      // Only obsolete generated navigation links are removed. Records, custom
      // callouts, page bodies, and source databases are never cleared here.
      for (const duplicate of navigation.slice(1)) await api(`blocks/${duplicate.id}`, "DELETE");
    } else {
      const first = children[0];
      await api(`blocks/${pageId}/children`, "PATCH", {
        children: [workspaceNavigation(cache)],
        ...(first ? { after: first.id } : {}),
      });
    }
  }
}
