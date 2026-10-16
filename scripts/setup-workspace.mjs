#!/usr/bin/env node
/**
 * setup-workspace.mjs: deterministic builder for the coaching Notion workspace.
 *
 * Builds, in the strict order the relations require:
 *   1. Programs DB
 *   2. Goals DB
 *   3. Body Stats DB
 *   4. Workout Log DB   (has a relation to Programs, so Programs must exist first)
 *   5. Meal Log DB      (food logging: calories and protein per meal)
 *   6. an initial Programs row (only if Programs is empty)
 *   7. five daily-use pages, with supporting records grouped in Resources
 *
 * Idempotent: existing databases/pages under the Hub are detected by title and
 * reused, never duplicated. All resolved ids (databases, hub, dashboard page,
 * and the managed overview block or legacy tile column ids) are written to
 * data/notion-ids.json so the agent and the notion.mjs helper can find them on
 * this instance. The committed code hardcodes no ids; they are per-workspace.
 *
 * Uses the Notion REST API directly.
 *
 * Usage:
 *   node scripts/setup-workspace.mjs                 # build/repair, keep existing dashboard content
 *   node scripts/setup-workspace.mjs --rebuild-dashboard
 *   node scripts/setup-workspace.mjs --compact-layout  # verify linked views, group existing records
 *   node scripts/setup-workspace.mjs --hub <pageId>  # override NOTION_PARENT_PAGE_ID
 */
import fs from "node:fs";
import path from "node:path";
import {
  compactDashboardBody,
  findDashboardOverview,
  legacyDashboardDisplayIds,
} from "./notion-dashboard-layout.mjs";
import {
  compactWorkspaceLayout,
  ensureSourceViews,
  ensureWorkspacePages,
  initializeWorkspacePages,
  listLayoutChildren,
  selectWorkspaceDatabase,
  updateWorkspaceNavigation,
} from "./notion-layout.mjs";

const TOKEN = process.env.NOTION_TOKEN;
const API = "https://api.notion.com/v1";
const CACHE_FILE = path.resolve(process.cwd(), "data", "notion-ids.json");

if (!TOKEN) {
  console.error("NOTION_TOKEN is not set. Notion is not configured.");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

// Hub resolution order: --hub flag, NOTION_PARENT_PAGE_ID, then the gitignored local
// pin file config/notion-hub.json ({ "hubPageId": "..." }, copy the .example) so a fresh deployment
// with an empty data/ mount can still rebuild against the right workspace.
function pinnedHub() {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "config", "notion-hub.json"), "utf8"),
    ).hubPageId;
  } catch {
    return undefined;
  }
}
const HUB = opt("hub") ?? process.env.NOTION_PARENT_PAGE_ID ?? pinnedHub();
if (!HUB) {
  console.error(
    "No Hub page id. Set NOTION_PARENT_PAGE_ID, pass --hub <pageId>, or add config/notion-hub.json.",
  );
  process.exit(1);
}

// Notion rate-limits at ~3 req/s per integration, so a builder that creates
// several databases, rows, and dozens of blocks can hit HTTP 429. Retry with
// backoff (honouring Retry-After) on 429 and transient 5xx, then surface the
// error if it persists.
const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, method = "GET", body = undefined, version = "2022-06-28") {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": version,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Reads can be safely replayed after an ambiguous server error. Writes
    // cannot: Notion may have committed a create/append before returning 5xx.
    const retryableServerError = method === "GET" || pathname.endsWith("/query");
    if (
      (res.status === 429 || (res.status >= 500 && retryableServerError)) &&
      attempt < MAX_RETRIES
    ) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt, 8) * 1000;
      await sleep(waitMs);
      continue;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`Notion ${method} ${pathname} -> ${res.status}: ${json.message ?? ""}`);
    return json;
  }
}

// ─── cache ───────────────────────────────────────────────────────────────────
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeCache(c) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  // Atomic write (temp + rename): a crash mid-write must not leave a truncated
  // cache that readCache swallows as {}, which would re-create duplicate databases.
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}
const cache = readCache();
let layout;

// ─── block helpers (from the build spec) ─────────────────────────────────────
const RT = (t) => [{ type: "text", text: { content: t } }];
const h2 = (t) => ({ type: "heading_2", heading_2: { rich_text: RT(t) } });
const p = (t) => ({ type: "paragraph", paragraph: { rich_text: RT(t) } });
const div = () => ({ type: "divider", divider: {} });
const box = (t, e, c = "default") => ({
  type: "callout",
  callout: { rich_text: RT(t), icon: { type: "emoji", emoji: e }, color: c },
});
async function append(parentId, blocks) {
  for (let i = 0; i < blocks.length; i += 90) {
    await api(`blocks/${parentId}/children`, "PATCH", { children: blocks.slice(i, i + 90) });
  }
}

// ─── discovery / idempotency ─────────────────────────────────────────────────
/** Resolve original source databases across the Hub's nested resource pages. */
async function hubChildDatabases() {
  const map = {};
  for (const title of [
    "Programs",
    "Goals",
    "Body Stats",
    "Workout Log",
    "Meal Log",
    "Food Library",
  ]) {
    const id = selectWorkspaceDatabase(layout.discovery, title, cache, HUB);
    if (id) map[title.toLowerCase()] = id;
  }
  return map;
}

/** First child page under the Hub with the given title, or null. */
async function findHubChildPage(title) {
  const matches = layout.discovery.pages.filter((page) => page.title === title);
  const preferred =
    title === "Knowledge Base"
      ? cache.__knowledgeBase
      : title === "Training Calendar"
        ? cache.__trainingCalendar
        : cache.__workspacePages.dashboard;
  const found = matches.find(
    (page) => page.id.replace(/-/g, "") === (preferred ?? "").replace(/-/g, ""),
  );
  if (found) return found.id;
  if (matches.length > 1) throw new Error(`Several ${title} pages exist. Setup will not guess.`);
  return matches[0]?.id ?? null;
}

async function ensureDatabase(title, properties, existing) {
  const found = existing[title.toLowerCase()];
  if (found) {
    console.log(`= ${title} exists (${found})`);
    return found;
  }
  const db = await api("databases", "POST", {
    parent: { type: "page_id", page_id: cache.__resources },
    title: [{ type: "text", text: { content: title } }],
    properties,
  });
  console.log(`+ created ${title} (${db.id})`);
  return db.id;
}

const sel = (...names) => ({ select: { options: names.map((name) => ({ name })) } });
const multi = (...names) => ({ multi_select: { options: names.map((name) => ({ name })) } });

/** Add a property to a live database when an older workspace lacks it. */
async function ensureProperty(dbId, name, def) {
  const schema = (await api(`databases/${dbId}`, "GET")).properties ?? {};
  if (schema[name]) {
    console.log(`= ${name} property exists`);
    return;
  }
  await api(`databases/${dbId}`, "PATCH", { properties: { [name]: def } });
  console.log(`+ added ${name} property`);
}

// ─── build ───────────────────────────────────────────────────────────────────
async function main() {
  cache.__hub = HUB;
  layout = await ensureWorkspacePages(api, HUB, cache, writeCache);
  const existing = await hubChildDatabases();

  // 1. Programs
  const programs = await ensureDatabase(
    "Programs",
    {
      Program: { title: {} },
      Type: sel("Powerbuilding", "Strength", "Hypertrophy", "Cardio", "Deload"),
      Status: sel("Active", "Completed", "Planned", "Paused"),
      "Start Date": { date: {} },
      "End Date": { date: {} },
      Weeks: { number: {} },
      Notes: { rich_text: {} },
    },
    existing,
  );
  cache.Programs = programs;

  // 2. Goals
  cache.Goals = await ensureDatabase(
    "Goals",
    {
      Goal: { title: {} },
      Category: sel("Strength", "Body Composition", "Cardio", "Habit"),
      Metric: { rich_text: {} },
      "Starting Value": { number: {} },
      "Current Value": { number: {} },
      "Target Value": { number: {} },
      "Target Date": { date: {} },
      Status: sel("On track", "At risk", "Achieved", "Paused"),
    },
    existing,
  );

  // 3. Body Stats
  cache["Body Stats"] = await ensureDatabase(
    "Body Stats",
    {
      "Check-in": { title: {} },
      Date: { date: {} },
      "Bodyweight (kg)": { number: {} },
      "Waist (cm)": { number: {} },
      "Chest (cm)": { number: {} },
      "Arm (cm)": { number: {} },
      Conditions: sel("Morning fasted", "Evening", "After holiday", "Post-training"),
      Notes: { rich_text: {} },
    },
    existing,
  );

  // 4. Workout Log (relation to Programs, which must already exist).
  // One row per training date: Date and Day are exact, Duration is independent
  // for that day, and session details live in the row body.
  cache["Workout Log"] = await ensureDatabase(
    "Workout Log",
    {
      Session: { title: {} },
      Date: { date: {} },
      Week: sel("Week 1", "Week 2", "Week 3", "Week 4", "Week 5", "Week 6", "Week 7", "Week 8"),
      Day: sel("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
      Focus: multi(
        "Legs",
        "Chest",
        "Back",
        "Shoulders",
        "Biceps",
        "Triceps",
        "Cardio",
        "Full Body",
        "Mobility",
      ),
      Status: sel("Completed", "Partial", "Skipped"),
      "Top Set": { number: {} },
      "Volume (kg)": { number: {} },
      "Duration (min)": { number: {} },
      "RPE (1-10)": { number: {} },
      Sessions: { number: {} },
      Program: {
        relation: { database_id: programs, type: "single_property", single_property: {} },
      },
    },
    existing,
  );
  // Sessions counts distinct workouts recorded on a day when there are multiple.
  await ensureProperty(cache["Workout Log"], "Sessions", { number: {} });

  // 5. Meal Log (no relations, so order does not matter; kept beside Workout Log)
  cache["Meal Log"] = await ensureDatabase(
    "Meal Log",
    {
      Meal: { title: {} },
      Date: { date: {} },
      "Meal Type": sel(
        "Breakfast",
        "Lunch",
        "Tea",
        "Dinner",
        "Supper",
        "Snack",
        "Pre-workout",
        "Post-workout",
      ),
      "Calories (kcal)": { number: {} },
      "Protein (g)": { number: {} },
      "Carbs (g)": { number: {} },
      "Fat (g)": { number: {} },
      Source: sel("Text", "Voice", "Photo", "Label"),
      Notes: { rich_text: {} },
    },
    existing,
  );

  // 6. Food Library (repeat-food nutrition: label-exact numbers first, so
  // tomorrow's estimate for the same food is a lookup, not a guess)
  cache["Food Library"] = await ensureDatabase(
    "Food Library",
    {
      Name: { title: {} },
      Serving: { rich_text: {} },
      "Calories (kcal)": { number: {} },
      "Protein (g)": { number: {} },
      "Carbs (g)": { number: {} },
      "Fat (g)": { number: {} },
      Source: sel("Label", "Manual", "Estimate"),
      Category: sel(
        "Restaurant",
        "Street Food",
        "Packaged",
        "Fast Food",
        "Home-cooked",
        "Drinks",
        "Supplements",
        "Other",
      ),
      Notes: { rich_text: {} },
    },
    existing,
  );
  await ensureProperty(
    cache["Food Library"],
    "Category",
    sel(
      "Restaurant",
      "Street Food",
      "Packaged",
      "Fast Food",
      "Home-cooked",
      "Drinks",
      "Supplements",
      "Other",
    ),
  );

  // 7. Initial program row, only if Programs is empty.
  const progRows = await api(`databases/${programs}/query`, "POST", { page_size: 1 });
  if (!progRows.results?.length) {
    await api("pages", "POST", {
      parent: { database_id: programs },
      properties: {
        Program: { title: RT("Current Program") },
        Type: { select: { name: "Powerbuilding" } },
        Status: { select: { name: "Active" } },
      },
    });
    console.log("+ seeded initial Programs row");
  } else {
    console.log("= Programs already has rows");
  }

  // 7. Knowledge Base page: where dumped training programs are organised.
  //    Built before the Dashboard so the Dashboard can link to it.
  await ensureKnowledgeBase();
  await ensureExerciseLibrary();

  // 8. Training Calendar page: the GitHub-style workout heatmap lives here,
  //    refreshed by publish-heatmap.mjs after sessions are logged.
  await ensureTrainingCalendar();

  await initializeWorkspacePages(api, cache, layout.created, writeCache);

  // 9. Dashboard page (links to everything above).
  await ensureDashboard();

  if (flag("compact-layout")) {
    await compactWorkspaceLayout(api, HUB, cache, writeCache);
    await updateWorkspaceNavigation(api, cache);
  } else await ensureSourceViews(api, cache, writeCache);

  writeCache(cache);
  console.log("\nWorkspace ready. Ids cached to data/notion-ids.json");
}

async function ensureTrainingCalendar() {
  let pageId = await findHubChildPage("Training Calendar");
  if (!pageId) {
    const page = await api("pages", "POST", {
      parent: { type: "page_id", page_id: cache.__workspacePages.workouts },
      icon: { type: "emoji", emoji: "🗓️" },
      properties: { title: { title: RT("Training Calendar") } },
    });
    pageId = page.id;
    console.log(`+ created Training Calendar page (${pageId})`);
  } else {
    console.log(`= Training Calendar page exists (${pageId})`);
  }
  cache.__trainingCalendar = pageId;
}

async function ensureDashboard() {
  const pageId = cache.__workspacePages.dashboard;
  let children = await listLayoutChildren(api, pageId);
  if (!findDashboardOverview(children) && (children.length === 0 || flag("rebuild-dashboard"))) {
    const generated = flag("rebuild-dashboard")
      ? await legacyDashboardDisplayIds(api, children, cache)
      : new Set();
    // Append first so a failed write cannot leave a cleared dashboard. Only
    // positively identified legacy display blocks are removed, never user content.
    await buildDashboardBody(pageId);
    for (const id of generated) await api(`blocks/${id}`, "DELETE");
    children = await listLayoutChildren(api, pageId);
    console.log(`+ compact Dashboard overview ready (${pageId})`);
  }
  const overview = findDashboardOverview(children);
  cache.__dashboard = overview
    ? { pageId, layout: "overview", overviewBlockId: overview.id, columns: {} }
    : { pageId, columns: await captureTileColumns(pageId) };
}

async function buildDashboardBody(pageId) {
  await append(pageId, compactDashboardBody(cache));
}

async function ensureKnowledgeBase() {
  let pageId = await findHubChildPage("Knowledge Base");
  if (!pageId) {
    const page = await api("pages", "POST", {
      parent: { type: "page_id", page_id: cache.__foodKnowledge },
      icon: { type: "emoji", emoji: "📚" },
      properties: { title: { title: RT("Knowledge Base") } },
    });
    pageId = page.id;
    await append(pageId, [
      box(
        "Training programs and reference material the coach draws on. Drop files in the repo's knowledge/ folder and ask the coach to import them.",
        "📚",
        "gray_background",
      ),
      div(),
    ]);
    console.log(`+ created Knowledge Base page (${pageId})`);
  } else {
    console.log(`= Knowledge Base page exists (${pageId})`);
  }
  cache.__knowledgeBase = pageId;
}

async function ensureExerciseLibrary() {
  const parentId = cache.__knowledgeBase;
  if (!parentId) throw new Error("Knowledge Base page is missing.");

  let cursor;
  let pageId;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await api(`blocks/${parentId}/children${qs}`);
    const found = (res.results ?? []).find(
      (b) => b.type === "child_page" && b.child_page?.title === "Exercise Library",
    );
    if (found) {
      pageId = found.id;
      break;
    }
    if (res.has_more && !res.next_cursor) {
      throw new Error("Knowledge Base child pagination is incomplete: next_cursor is missing.");
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  if (!pageId) {
    const page = await api("pages", "POST", {
      parent: { type: "page_id", page_id: parentId },
      icon: { type: "emoji", emoji: "🏋️" },
      properties: { title: { title: RT("Exercise Library") } },
    });
    pageId = page.id;
    await append(pageId, [
      p(
        "Canonical catalog of exercises actually performed, grouped under every muscle group meaningfully trained.",
      ),
      p(
        "Keep exercise variations stable for progression. Record aliases only when they clearly refer to the same movement. Challenge unsafe or poor-fit choices with a specific reason; never rewrite workout history.",
      ),
      h2("Chest"),
      h2("Biceps"),
      h2("Triceps"),
      h2("Back"),
      h2("Legs"),
      h2("Shoulders"),
    ]);
    console.log(`+ created Exercise Library page (${pageId})`);
  } else {
    console.log(`= Exercise Library page exists (${pageId})`);
  }
  cache.__exerciseLibrary = pageId;
}

/** Capture legacy Dashboard tile ids without upgrading an existing layout.
 * Keep these old row names in sync with the legacy fallback in notion.mjs. */
const TILE_ROWS = [
  ["nextSession", "progressionGuide"],
  ["thisWeek", "nutrition", "bodyStats"],
  ["goals", "activeProgram"],
  ["quickCommands", "messageCoach"],
];
async function captureTileColumns(pageId) {
  const top = await listLayoutChildren(api, pageId);
  const lists = top.filter((b) => b.type === "column_list");
  const out = { listId: lists[0]?.id };
  for (let r = 0; r < lists.length && r < TILE_ROWS.length; r++) {
    const cols = await api(`blocks/${lists[r].id}/children`);
    const ids = (cols.results ?? []).map((c) => c.id);
    TILE_ROWS[r].forEach((name, i) => {
      if (ids[i]) out[name] = ids[i];
    });
  }
  return out;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
