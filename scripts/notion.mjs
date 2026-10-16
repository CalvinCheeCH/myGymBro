#!/usr/bin/env node
/**
 * notion.mjs: the coach's Notion REST helper.
 *
 * Notion is reached entirely through the REST API (there is no MCP server): the
 * API does everything (rich blocks, tables, columns, database rows, page icons),
 * so this single code path keeps pages well structured. This wraps it so skills
 * get, via Bash:
 *
 *   - rich block writing (headings, callouts, dividers, tables, lists), with
 *     inline **bold**, _italic_, `code`, and [links](url) rendered as rich text
 *   - logging a row into a database (the most common task)
 *   - querying recent rows (e.g. last 3 sessions for a Focus)
 *   - resolving + caching database ids so they survive between sessions, with a
 *     self-healing cache (a stale id from a deleted/recreated db is re-resolved)
 *
 * Requests automatically retry with backoff on Notion's rate limit (HTTP 429,
 * approx 3 req/s per integration) and on transient 5xx responses.
 *
 * Auth: NOTION_TOKEN (the internal integration token).
 *
 * Note: Notion's public API cannot create or configure database *views*
 * (grouping, default filters). That is a platform limitation, not fixable here;
 * the default-view setup still has to be done once by hand in Notion.
 *
 * Usage:
 *   node scripts/notion.mjs resolve-workspace        # rebuild the id cache from the pinned Hub
 *   node scripts/notion.mjs resolve-db --name "Workout Log"
 *   node scripts/notion.mjs query-recent --db "Workout Log" --focus Chest --limit 3
 *   node scripts/notion.mjs exercise-inventory       # all distinct logged exercise headings
 *   node scripts/notion.mjs exercise-library --action show
 *   node scripts/notion.mjs exercise-library --action replace --md "..."
 *   node scripts/notion.mjs weekly-plan --action save --week 2026-10-11 --md "..."
 *   node scripts/notion.mjs weekly-plan --action show --week 2026-10-11
 *   node scripts/notion.mjs lookup --db "Food Library" --field Name --contains "maggi"
 *   node scripts/notion.mjs log --db "Workout Log" \
 *        --set "Session=Push A" --set "Focus=Chest, Shoulders, Triceps" --set "Date=2026-06-23" \
 *        --set "RPE=8" --set "Exercises=Bench 5x5 @60kg; OHP 3x8 @40kg"
 *     # Optional --body writes the page body in the SAME command (no id-capture
 *     # step), e.g. --body "## Bench\n- 60kg x 5 x 5". Use --body-file for a file.
 *   node scripts/notion.mjs update --db "Workout Log" --page <id> \
 *        --set "Calories (kcal)=+=450" --body "## Lunch\n- chicken and rice"
 *   node scripts/notion.mjs append --page <pageId> --md "# Heading\n> [!note] callout\n---\n- a\n- b"
 *   node scripts/notion.mjs append --page <pageId> --file plan.md
 *   node scripts/notion.mjs sync-dashboard --now 2026-06-30
 *   node scripts/notion.mjs sum-day --db "Meal Log" [--date 2026-06-30]
 *   node scripts/notion.mjs log-meal --date 2026-10-16 --set "Meal Type=Lunch" \
 *        --set "Calories (kcal)=450" --set "Protein (g)=25" --set "Source=Text" --body "- Meal details"
 *   node scripts/notion.mjs find-row --db "Meal Log" --date 2026-06-30
 *   node scripts/notion.mjs read-blocks --page <pageId>
 *   node scripts/notion.mjs archive --page <pageId>
 *   node scripts/notion.mjs update --page <rowId> --set "Calories (kcal)=+=450"
 *
 * Add --dry-run to `log` to validate and print the parsed row without writing it.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalExerciseName } from "./exercise-aliases.mjs";
import { findDashboardOverview } from "./notion-dashboard-layout.mjs";

const TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = process.env.NOTION_VERSION ?? "2022-06-28";
const API = "https://api.notion.com/v1";
const CACHE_FILE = path.resolve(process.cwd(), "data", "notion-ids.json");

// Retry tuning for rate limits (429) and transient 5xx responses.
const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── arg parsing (supports repeated --set) ──────────────────────────────────
function parseArgs(argv) {
  const args = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (key === "set") args.set.push(val);
    else args[key] = val;
  }
  return args;
}

async function notion(pathname, method, body, { version = NOTION_VERSION } = {}) {
  if (!TOKEN) throw new Error("NOTION_TOKEN is not set. Notion is not configured.");

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": version,
        ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      redirect: "error",
    });

    // Rate limits are safe to retry. A 5xx is retried only for reads: a write
    // may have committed even when its response was lost, so replaying it can
    // create duplicate pages or blocks.
    // Notion sets Retry-After (seconds) on a 429; otherwise use exponential
    // backoff capped at 8s. Give up after MAX_RETRIES and fall through to the
    // normal error handling below.
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
    if (!res.ok) {
      throw new Error(`Notion ${method} ${pathname} -> ${res.status}: ${json.message ?? ""}`);
    }
    return json;
  }
}

// ─── id cache ────────────────────────────────────────────────────────────────
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  // Atomic write: a crash mid-write must not truncate the cache to invalid JSON
  // (which readCache would silently swallow as {}, losing every resolved id and
  // causing duplicate databases on the next setup). Write to a temp file and
  // rename, which is atomic on the same filesystem.
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

// ─── Hub scoping ─────────────────────────────────────────────────────────────
// Notion ids compare equal with or without dashes and regardless of case.
const normId = (id) => (id ?? "").replace(/-/g, "").toLowerCase();

// The pinned Hub (root) page. Workspace objects stay within this page's tree, so
// scoping name resolution to that tree means a shared integration that
// can see *other* Notion spaces (e.g. a demo workspace) can never resolve to a
// stranger's database of the same name. Explicit environment or config pins take
// precedence over the id cache. config/notion-hub.json is a gitignored local
// pin, copied from its .example, that survives restarts where the data/ cache starts empty.
const HUB_PIN_FILE = path.resolve(process.cwd(), "config", "notion-hub.json");
function hubId() {
  const cache = readCache();
  let pinned;
  try {
    pinned = JSON.parse(fs.readFileSync(HUB_PIN_FILE, "utf8")).hubPageId;
  } catch {
    /* no pin file; env or cache must carry it */
  }
  return normId(process.env.NOTION_PARENT_PAGE_ID ?? pinned ?? cache.__hub ?? "");
}

/** Paginated list of a block's (or page's) children. */
async function listChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await notion(`/blocks/${blockId}/children${qs}`);
    out.push(...(res.results ?? []));
    if (res.has_more && !res.next_cursor)
      throw new Error("Notion child pagination is incomplete: next_cursor is missing.");
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Query every database result page while preserving the supplied filter/sorts. */
async function queryAllRows(databaseId, body = {}) {
  const rows = [];
  let cursor;
  do {
    const res = await notion(`/databases/${databaseId}/query`, "POST", {
      ...body,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...(res.results ?? []));
    if (res.has_more && !res.next_cursor)
      throw new Error("Notion database pagination is incomplete: next_cursor is missing.");
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/** Follow page ancestors so moving a source into Resources preserves Hub isolation. */
async function pageIsWithinHub(pageId, hub) {
  const seen = new Set();
  let id = pageId;
  while (id && seen.size < 20) {
    if (normId(id) === normId(hub)) return true;
    if (seen.has(normId(id))) return false;
    seen.add(normId(id));
    const page = await notion(`/pages/${id}`);
    if (page.archived || page.in_trash) return false;
    id = page.parent?.page_id;
  }
  return false;
}

/** Only layout folders are traversed; training rows and imported programs are not scanned. */
async function workspaceDatabases(hub) {
  const pages = [hub];
  const seen = new Set();
  const databases = [];
  const folders =
    /^(?:workspace resources|resources|food & knowledge|workout log|meal log|knowledge base)$/i;
  while (pages.length) {
    const parent = pages.shift();
    if (seen.has(normId(parent))) continue;
    seen.add(normId(parent));
    for (const block of await listChildren(parent)) {
      if (block.type === "child_database") {
        databases.push({ id: block.id, name: block.child_database?.title ?? "" });
      } else if (block.type === "child_page" && folders.test(block.child_page?.title ?? "")) {
        pages.push(block.id);
      }
    }
  }
  return databases;
}

// ─── blocks → markdown (for read-blocks / migration) ────────────────────────

function richTextToMd(rich) {
  if (!rich?.length) return "";
  return rich
    .map((r) => {
      let t = r.plain_text ?? "";
      const a = r.annotations ?? {};
      if (a.code) t = `\`${t}\``;
      if (a.bold) t = `**${t}**`;
      if (a.italic) t = `_${t}_`;
      if (a.strikethrough) t = `~~${t}~~`;
      if (r.href) t = `[${t}](${r.href})`;
      return t;
    })
    .join("");
}

async function blocksToMarkdown(blockId, depth = 0) {
  const children = await listChildren(blockId);
  const lines = [];
  for (const b of children) {
    const indent = "  ".repeat(depth);
    const type = b.type;
    const content = b[type]?.rich_text;
    const text = richTextToMd(content);
    switch (type) {
      case "paragraph":
        lines.push(`${indent}${text}`);
        break;
      case "heading_1":
        lines.push(`${indent}# ${text}`);
        break;
      case "heading_2":
        lines.push(`${indent}## ${text}`);
        break;
      case "heading_3":
        lines.push(`${indent}### ${text}`);
        break;
      case "bulleted_list_item":
        lines.push(`${indent}- ${text}`);
        if (b.has_children) lines.push(await blocksToMarkdown(b.id, depth + 1));
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${text}`);
        if (b.has_children) lines.push(await blocksToMarkdown(b.id, depth + 1));
        break;
      case "to_do":
        lines.push(`${indent}- [${b.to_do?.checked ? "x" : " "}] ${text}`);
        break;
      case "toggle":
        lines.push(`${indent}<details><summary>${text}</summary>`);
        if (b.has_children) lines.push(await blocksToMarkdown(b.id, depth + 1));
        lines.push(`${indent}</details>`);
        break;
      case "callout":
        lines.push(`${indent}> [!note] ${text}`);
        if (b.has_children) lines.push(await blocksToMarkdown(b.id, depth + 1));
        break;
      case "code":
        lines.push(`${indent}\`\`\`${b.code?.language ?? ""}`);
        lines.push(`${indent}${text}`);
        lines.push(`${indent}\`\`\``);
        break;
      case "divider":
        lines.push(`${indent}---`);
        break;
      case "quote":
        lines.push(`${indent}> ${text}`);
        break;
      case "table":
        if (b.has_children) {
          const rows = await listChildren(b.id);
          for (const row of rows) {
            const cells = (row.table_row?.cells ?? []).map(richTextToMd);
            lines.push(`${indent}| ${cells.join(" | ")} |`);
          }
        }
        break;
      case "column_list":
      case "column":
        if (b.has_children) lines.push(await blocksToMarkdown(b.id, depth));
        break;
      default:
        if (text) lines.push(`${indent}${text}`);
        break;
    }
  }
  return lines.join("\n");
}

/** Accept a raw id or a database name; resolve names via cache, then by walking
 *  the pinned Hub's children. The Hub walk is the primary fallback because every
 *  workspace database hangs directly off the Hub and block-children listing is
 *  strongly consistent; Notion's /search API is eventually-consistent and often
 *  returns nothing for integration tokens (a fresh deployment with an empty
 *  data/ cache would then wrongly conclude the workspace is empty). Search is
 *  only used when no Hub is pinned at all. */
async function resolveDbId(dbRef) {
  if (!dbRef) throw new Error("--db is required (id or database name)");
  // A 32-hex (optionally dashed) string is already an id.
  if (/^[0-9a-f]{32}$/i.test(dbRef.replace(/-/g, ""))) return dbRef;

  const cache = readCache();
  if (cache[dbRef]) {
    // Validate the cached id still resolves. If the database was deleted and
    // recreated in Notion, the cached id is stale (404s); drop it and re-resolve
    // by name below, so the cache self-heals rather than needing a manual clear.
    // Also confirm it still lives under the pinned Hub: a database moved out of
    // the workspace must not keep being written to via a stale cache entry.
    try {
      const db = await notion(`/databases/${cache[dbRef]}`);
      const hub = hubId();
      if (
        db.archived ||
        db.in_trash ||
        (hub && !(await pageIsWithinHub(db.parent?.page_id, hub)))
      ) {
        throw new Error(`cached "${dbRef}" no longer lives under the Hub`);
      }
      return cache[dbRef];
    } catch {
      delete cache[dbRef];
      writeCache(cache);
    }
  }

  const hub = hubId();
  let candidates;
  if (hub) {
    // Enumerate the Hub's managed resource folders. A child_database block's
    // id is the database id, including after the compact layout moves it.
    candidates = await workspaceDatabases(hub);
  } else {
    const found = await notion("/search", "POST", {
      query: dbRef,
      filter: { value: "database", property: "object" },
    });
    candidates = (found.results ?? []).map((r) => ({
      id: r.id,
      name: (r.title ?? []).map((t) => t.plain_text).join(""),
    }));
  }

  const exact = candidates.filter((r) => r.name.toLowerCase() === dbRef.toLowerCase());

  // Refuse to guess when the name is ambiguous within the Hub: picking one would
  // risk showing the wrong workspace's data. Fail loud so the user repins/cleans.
  if (exact.length > 1) {
    throw new Error(
      `Ambiguous: ${exact.length} databases named "${dbRef}" under the Hub. Run scripts/setup-workspace.mjs to repin ids, or unshare the duplicate in Notion.`,
    );
  }

  // Only ever fall back to a lone candidate when there is NO Hub pin at all
  // (single-space integration); with a Hub set, an exact title match is required.
  const match = exact[0] ?? (!hub && candidates.length === 1 ? candidates[0] : undefined);
  if (!match) {
    throw new Error(
      hub
        ? `No database named "${dbRef}" found under the pinned Hub. Run setup-workspace.mjs, or confirm the integration is shared with the Hub page.`
        : `No unambiguous database matching "${dbRef}". Set NOTION_PARENT_PAGE_ID (the Hub page id) so resolution can be scoped to your workspace.`,
    );
  }
  cache[dbRef] = match.id;
  writeCache(cache);
  return match.id;
}

/**
 * Resolve the Dashboard page and its tile columns, self-healing from the
 * pinned Hub when the cache is empty (fresh deployment) or stale (rebuilt page).
 * Mirrors captureTileColumns in setup-workspace.mjs: the column_list rows and
 * their child columns match the builder's TILE_ROWS layout exactly.
 */
const TILE_ROWS = [
  ["nextSession", "progressionGuide"],
  ["thisWeek", "nutrition", "bodyStats"],
  ["goals", "activeProgram"],
  ["quickCommands", "messageCoach"],
];

async function resolveDashboard() {
  // Re-read the Hub and column membership before writing private summaries.
  // A valid cached block ID alone cannot prove it still belongs to this workspace.
  const hub = hubId();
  if (!hub) {
    throw new Error(
      "No Dashboard cached and no Hub pinned. Set NOTION_PARENT_PAGE_ID or config/notion-hub.json, or run setup-workspace.mjs.",
    );
  }
  const page = (await listChildren(hub)).find(
    (b) => b.type === "child_page" && b.child_page?.title === "Dashboard",
  );
  if (!page) {
    throw new Error("No Dashboard page found under the Hub. Run setup-workspace.mjs to build it.");
  }
  const children = await listChildren(page.id);
  const overview = findDashboardOverview(children);
  // The warm display path is read-only locally, so background rendering cannot
  // overwrite database IDs resolved by a meal command in another process.
  if (overview)
    return { pageId: page.id, layout: "overview", overviewBlockId: overview.id, columns: {} };
  const lists = children.filter((b) => b.type === "column_list");
  const columns = { listId: lists[0]?.id };
  for (let r = 0; r < lists.length && r < TILE_ROWS.length; r++) {
    const ids = (await listChildren(lists[r].id)).map((c) => c.id);
    TILE_ROWS[r].forEach((name, i) => {
      if (ids[i]) columns[name] = ids[i];
    });
  }
  const dash = { pageId: page.id, columns };
  const cache = readCache();
  cache.__dashboard = dash;
  writeCache(cache);
  return dash;
}

// ─── property value coercion based on the db schema ──────────────────────────
function buildPropertyValue(type, raw) {
  switch (type) {
    case "title":
      return { title: [{ text: { content: raw } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: raw } }] };
    case "number":
      return { number: Number(raw) };
    case "select":
      return { select: { name: raw } };
    case "status":
      return { status: { name: raw } };
    case "multi_select":
      return { multi_select: raw.split(",").map((name) => ({ name: name.trim() })) };
    case "date": {
      // Single day ("2026-09-06") or week span ("2026-08-30..2026-09-05").
      // Spans render as multi-day bars in Notion calendar views; every date
      // filter in this repo matches on the start, so lookups are unaffected.
      const m = /^\s*(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?\s*$/.exec(raw);
      if (!m)
        throw new Error(`Expects a date YYYY-MM-DD or span YYYY-MM-DD..YYYY-MM-DD, got "${raw}".`);
      return m[2] ? { date: { start: m[1], end: m[2] } } : { date: { start: m[1] } };
    }
    case "checkbox":
      return { checkbox: /^(true|yes|1)$/i.test(raw) };
    case "url":
      return { url: raw };
    default:
      // Fall back to rich_text so we never silently drop data.
      return { rich_text: [{ text: { content: raw } }] };
  }
}

/** The allowed option names for a select/multi_select/status property, else null. */
function optionNames(def) {
  if (def.type === "select") return (def.select?.options ?? []).map((o) => o.name);
  if (def.type === "status") return (def.status?.options ?? []).map((o) => o.name);
  if (def.type === "multi_select") return (def.multi_select?.options ?? []).map((o) => o.name);
  return null;
}

/**
 * Validate a --set value against the live schema before it is written, so a
 * miscategorised or out-of-range value fails locally with the valid options
 * (the same self-correcting pattern as the unknown-property check) instead of
 * silently creating a stray select option or logging an impossible number.
 * Pure (no I/O) so it is unit-testable; throws on the first problem.
 */
function validateValue(name, def, value) {
  const allowed = optionNames(def);
  if (allowed) {
    const given = def.type === "multi_select" ? value.split(",").map((v) => v.trim()) : [value];
    for (const v of given) {
      if (v && !allowed.includes(v)) {
        throw new Error(
          `"${v}" is not a valid option for "${name}". Allowed: ${allowed.join(", ")}`,
        );
      }
    }
  }
  if (def.type === "number") {
    const n = Number(value);
    if (value !== "" && Number.isNaN(n)) {
      throw new Error(`Property "${name}" expects a number, got "${value}".`);
    }
    // RPE is a fixed 1-10 scale; reject impossible values rather than logging them.
    if (/\brpe\b/i.test(name) && (n < 1 || n > 10)) {
      throw new Error(`"${name}" must be between 1 and 10, got ${value}.`);
    }
  }
}

/**
 * Resolve a relation value to related page ids. Accepts a raw page id, or a row
 * title looked up in the related database (the title property's id is always
 * "title", so the filter works regardless of the property's display name).
 */
async function resolveRelationIds(def, value) {
  const ref = value.trim();
  if (!ref) return [];
  if (/^[0-9a-f]{32}$/i.test(ref.replace(/-/g, ""))) return [{ id: ref }];
  const relDb = def.relation?.database_id;
  if (!relDb) throw new Error("Relation property has no related database id.");
  const res = await notion(`/databases/${relDb}/query`, "POST", {
    filter: { property: "title", title: { equals: ref } },
    page_size: 2,
  });
  const rows = res.results ?? [];
  if (rows.length === 0) {
    // Self-correcting error: list the real row titles so the caller can retry
    // with an exact match (same pattern as the unknown-property message).
    const all = await notion(`/databases/${relDb}/query`, "POST", { page_size: 25 });
    const titles = (all.results ?? [])
      .map((p) => {
        const t = Object.values(p.properties ?? {}).find((v) => v.type === "title");
        return (t?.title ?? []).map((x) => x.plain_text).join("");
      })
      .filter(Boolean);
    throw new Error(
      `No row titled "${ref}" in the related database. Have: ${titles.join(", ") || "(no rows)"}`,
    );
  }
  if (rows.length > 1)
    throw new Error(`Ambiguous: multiple rows titled "${ref}" in the related database.`);
  return [{ id: rows[0].id }];
}

function calendarWeekName(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey ?? "")) return null;
  const date = new Date(`${dayKey}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dayKey) return null;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - date.getUTCDay() + 1);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4, 12));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 864e5));
  return `Week ${week}`;
}

async function ensureCalendarWeekOption(dbId, propertyName, weekName, def, dryRun) {
  const options = def.select?.options ?? [];
  if (options.some((option) => option.name === weekName) || dryRun) return true;
  try {
    await notion(`/databases/${dbId}`, "PATCH", {
      properties: {
        [propertyName]: {
          ...(def.description ? { description: def.description } : {}),
          select: {
            options: [...options.map(({ id }) => ({ id })), { name: weekName, color: "default" }],
          },
        },
      },
    });
    options.push({ name: weekName, color: "default" });
  } catch (error) {
    console.error(`Could not add ${weekName} to the Workout Log Week options: ${error.message}`);
    return false;
  }
  return true;
}

async function buildProperties(
  dbId,
  sets,
  { fallbackDate, dryRun = false, schema: knownSchema } = {},
) {
  const schema = knownSchema ?? (await notion(`/databases/${dbId}`)).properties ?? {};
  const props = {};
  const dateProp = findProp(schema, (_name, def) => def.type === "date");
  const weekProp = findProp(
    schema,
    (name, def) => name.toLowerCase() === "week" && def.type === "select",
  );
  const dateValue = sets.find(
    (pair) => pair.slice(0, pair.indexOf("=")).trim().toLowerCase() === dateProp?.toLowerCase(),
  );
  const dateKey = dateValue?.slice(dateValue.indexOf("=") + 1).trim() || fallbackDate;
  let weekName = dateKey && weekProp ? calendarWeekName(dateKey) : null;
  if (
    weekName &&
    !(await ensureCalendarWeekOption(dbId, weekProp, weekName, schema[weekProp], dryRun))
  ) {
    weekName = null;
  }

  for (const pair of sets) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new Error(`--set must be "Name=value", got "${pair}"`);
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1);
    const def = schema[name];
    if (!def)
      throw new Error(
        `Property "${name}" not found in database. Have: ${Object.keys(schema).join(", ")}`,
      );
    if (weekName && name === weekProp) continue;
    if (def.type === "relation") {
      props[name] = { relation: await resolveRelationIds(def, value) };
      continue;
    }
    validateValue(name, def, value);
    props[name] = buildPropertyValue(def.type, value);
  }
  if (weekName) props[weekProp] = buildPropertyValue("select", weekName);
  return props;
}

// ─── markdown -> Notion blocks ───────────────────────────────────────────────

// Inline markdown spans, in priority order. Code is first so its contents are
// taken literally; bold (** / __) is matched before italic (* / _) so "**x**"
// is not mistaken for two italics. Spans are non-nesting, which covers the
// common cases (bold/italic/code/link inside a line) without a full parser.
const INLINE_PATTERNS = [
  { re: /`([^`]+)`/, annotations: { code: true } },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, link: true },
  { re: /\*\*([^*]+)\*\*/, annotations: { bold: true } },
  { re: /__([^_]+)__/, annotations: { bold: true } },
  { re: /\*([^*]+)\*/, annotations: { italic: true } },
  { re: /_([^_]+)_/, annotations: { italic: true } },
];

const plain = (content) => ({ type: "text", text: { content } });

/**
 * Parse a line of markdown into Notion rich_text objects, rendering inline
 * **bold**, _italic_, `code`, and [links](url) as annotations rather than
 * leaking literal asterisks/backticks into the page. Returns [] for empty input.
 */
function parseInline(text) {
  if (!text) return [];
  const out = [];
  let rest = text;

  while (rest.length) {
    // Find the earliest-matching span across all patterns.
    let best = null;
    for (const pat of INLINE_PATTERNS) {
      const m = pat.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { pat, m };
    }
    if (!best) {
      out.push(plain(rest));
      break;
    }
    const { pat, m } = best;
    if (m.index > 0) out.push(plain(rest.slice(0, m.index)));
    if (pat.link) {
      out.push({ type: "text", text: { content: m[1], link: { url: m[2] } } });
    } else {
      out.push({ type: "text", text: { content: m[1] }, annotations: pat.annotations });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// Block-level rich text. Always returns at least one node so a block is never
// created with empty rich_text where Notion expects content.
function rt(text) {
  const parsed = parseInline(text);
  return parsed.length ? parsed : [plain(text ?? "")];
}

// The Notion "color" values valid on a callout/text block. Anything outside this
// set is rejected so a typo silently degrades to "default" instead of erroring.
const NOTION_COLORS = new Set([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
]);

/** Canonical, fixed background for each named Dashboard tile, so colors never
 * drift between refreshes. The render functions and setup-workspace.mjs both
 * use these, and refresh-tile re-applies them. Keep the two files in sync. */
const TILE_COLORS = {
  nextSession: "purple_background",
  thisWeek: "gray_background",
  goals: "brown_background",
  bodyStats: "red_background",
  nutrition: "green_background",
  activeProgram: "yellow_background",
  quickCommands: "default",
};

/** Validate a Notion color, returning "default" for missing/unknown values. */
function normalizeColor(color) {
  const c = (color ?? "").trim();
  return NOTION_COLORS.has(c) ? c : "default";
}

/** Minimal but useful converter: headings, callouts, dividers, lists, tables, paragraphs. */
function markdownToBlocks(md) {
  const lines = md.replace(/\\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    // Column layout. Syntax:
    //   ::: columns
    //   <markdown for column 1>
    //   |||
    //   <markdown for column 2>
    //   :::
    // Columns are separated by a line of "|||" and the block ends at ":::".
    if (trimmed === "::: columns" || trimmed === ":::columns") {
      i++;
      const colSources = [[]];
      while (i < lines.length && lines[i].trim() !== ":::") {
        if (lines[i].trim() === "|||") colSources.push([]);
        else colSources[colSources.length - 1].push(lines[i]);
        i++;
      }
      i++; // skip closing ":::"
      // Notion requires at least two columns; recurse to build each column's blocks.
      const columns = colSources
        .map((src) => markdownToBlocks(src.join("\n")))
        .filter((children) => children.length > 0);
      if (columns.length >= 2) {
        blocks.push({
          object: "block",
          type: "column_list",
          column_list: {
            children: columns.map((children) => ({
              object: "block",
              type: "column",
              column: { children },
            })),
          },
        });
      } else if (columns.length === 1) {
        // Degrade gracefully to a plain stack rather than failing.
        blocks.push(...columns[0]);
      }
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    // Callout: "> [!note] text", "> [icon] text", "> [icon|color] text", or plain "> text".
    // The optional "|color" after the icon sets the callout background (e.g.
    // "> [📅|gray_background] **This Week**"); unknown colors fall back to default.
    const callout = trimmed.match(/^>\s*(?:\[!?([^\]]+)\]\s*)?(.*)$/);
    if (callout) {
      const [iconPart, colorPart] = (callout[1] ?? "").split("|").map((s) => s.trim());
      const emoji = /\p{Emoji}/u.test(iconPart ?? "") ? iconPart : "💡";
      const color = normalizeColor(colorPart);
      blocks.push({
        object: "block",
        type: "callout",
        callout: {
          rich_text: rt(callout[2] ?? ""),
          icon: { type: "emoji", emoji },
          color,
        },
      });
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const type = `heading_${level}`;
      blocks.push({ object: "block", type, [type]: { rich_text: rt(heading[2]) } });
      i++;
      continue;
    }

    // Table: consecutive "| a | b |" lines (a separator row like |---|---| is skipped)
    if (/^\|.*\|$/.test(trimmed)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) rows.push(cells);
        i++;
      }
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        blocks.push({
          object: "block",
          type: "table",
          table: {
            table_width: width,
            has_column_header: true,
            has_row_header: false,
            children: rows.map((r) => ({
              object: "block",
              type: "table_row",
              table_row: {
                cells: Array.from({ length: width }, (_, c) => rt(r[c] ?? "")),
              },
            })),
          },
        });
      }
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rt(bullet[1]) },
      });
      i++;
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: rt(numbered[1]) },
      });
      i++;
      continue;
    }

    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rt(trimmed) } });
    i++;
  }
  return blocks;
}

// ─── reading rows + dashboard rendering ──────────────────────────────────────

/** Read a Notion property value object into a plain string/number. */
function readProp(v) {
  if (!v) return "";
  if (v.type === "title") return (v.title ?? []).map((t) => t.plain_text).join("");
  if (v.type === "rich_text") return (v.rich_text ?? []).map((t) => t.plain_text).join("");
  if (v.type === "select") return v.select?.name ?? "";
  if (v.type === "status") return v.status?.name ?? "";
  if (v.type === "multi_select") return (v.multi_select ?? []).map((s) => s.name).join(", ");
  if (v.type === "number") return v.number ?? "";
  if (v.type === "date") return v.date?.start ?? "";
  return "";
}

/** Find a property name by a predicate over (lowercased name, definition). */
function findProp(schema, pred) {
  return Object.keys(schema).find((k) => pred(k.toLowerCase(), schema[k]));
}

/**
 * Resolve a search field against the schema (exact, then case-insensitive,
 * else the title property) and build the matching Notion filter. Pure:
 * unit-tested. Powers `lookup`, which is how meal logging finds repeat foods.
 */
function buildTextFilter(schema, field, text) {
  const keys = Object.keys(schema ?? {});
  const key =
    keys.find((k) => k === field) ??
    keys.find((k) => k.toLowerCase() === String(field ?? "").toLowerCase()) ??
    keys.find((k) => schema[k]?.type === "title");
  if (!key) throw new Error(`No searchable field for "${field}".`);
  const type = schema[key]?.type;
  if (type === "title") return { key, filter: { property: key, title: { contains: text } } };
  if (type === "rich_text")
    return { key, filter: { property: key, rich_text: { contains: text } } };
  if (type === "select") return { key, filter: { property: key, select: { equals: text } } };
  if (type === "multi_select")
    return { key, filter: { property: key, multi_select: { contains: text } } };
  throw new Error(`Cannot text-search ${type} property "${key}".`);
}

/**
 * Find rows by text: `lookup --db "Food Library" --field Name
 * --contains "maggi" [--limit 5]`. Prints title, numbers, and serving so the
 * coach can reuse exact values instead of estimating.
 */
async function cmdLookup(args) {
  const dbId = await resolveDbId(args.db);
  const limit = Number.parseInt(args.limit ?? "5", 10);
  const db = await notion(`/databases/${dbId}`);
  const schema = db.properties ?? {};
  const { filter, sorts, label } = buildLookupQuery(schema, {
    field: args.field,
    contains: args.contains,
  });
  const res = await notion(`/databases/${dbId}/query`, "POST", {
    ...(filter ? { filter } : {}),
    ...(sorts ? { sorts } : {}),
    page_size: limit,
  });
  if (!res.results?.length) {
    console.log(`No rows in ${args.db} (${label}).`);
    return;
  }
  const titleProp = Object.keys(schema).find((k) => schema[k].type === "title");
  const numProps = Object.keys(schema).filter((k) => schema[k].type === "number");
  const selProps = Object.keys(schema).filter(
    (k) => schema[k].type === "select" || schema[k].type === "status",
  );
  const servingProp = Object.keys(schema).find((k) => k.toLowerCase().includes("serving"));
  for (const page of res.results) {
    const p = page.properties ?? {};
    const title = readProp(titleProp ? p[titleProp] : null);
    const nums = numProps
      .map((n) => {
        const v = readProp(p[n]);
        return v === "" ? null : `${n.replace(/ \(.*\)/, "")}=${v}`;
      })
      .filter(Boolean)
      .join(", ");
    const sels = selProps
      .map((n) => {
        const v = readProp(p[n]);
        return v === "" ? null : `${n}=${v}`;
      })
      .filter(Boolean)
      .join(", ");
    const serving = servingProp && readProp(p[servingProp]) ? ` (${readProp(p[servingProp])})` : "";
    console.log(`- ${title}${serving}${nums ? ` | ${nums}` : ""}${sels ? ` | ${sels}` : ""}`);
  }
}

/**
 * Build the query half of `lookup`: filtered search when --contains is given,
 * list-all (A-Z by title) when omitted. Pure, unit-tested.
 */
function buildLookupQuery(schema, { field, contains }) {
  const titleProp = Object.keys(schema ?? {}).find((k) => schema[k].type === "title");
  if (contains) {
    const { key, filter } = buildTextFilter(schema, field, contains);
    return { filter, sorts: undefined, label: `where ${key} matches "${contains}"` };
  }
  return {
    filter: undefined,
    sorts: titleProp ? [{ property: titleProp, direction: "ascending" }] : undefined,
    label: "no filter (list-all)",
  };
}

const isoDate = (d) => d.toISOString().slice(0, 10);

/** Monday 00:00 UTC of the week containing d. UTC-based so it is deterministic
 *  regardless of server timezone (the caller can pass --now from the chat header). */
function startOfWeekUTC(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const mondayOffset = (x.getUTCDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0
  x.setUTCDate(x.getUTCDate() - mondayOffset);
  return x;
}

/** Sunday 00:00 UTC starting the Sun-Sat training week containing d. */
function startOfWeekSundayUTC(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - x.getUTCDay()); // Sun=0 -> 0, Sat=6 -> -6
  return x;
}

// Pure tile renderers: take plain extracted rows and return tile markdown. The
// numbers come straight from Notion queries (never the model), which is what
// keeps the Dashboard honest. Exported for unit tests.
function renderThisWeekTile(sessions) {
  const lines = [`> [📅|${TILE_COLORS.thisWeek}] **This Week**`];
  // Legacy weekly rows carry their day count; daily rows count as one.
  const trained = sessions.reduce((a, s) => a + (s.days ?? 1), 0);
  if (!sessions.length) {
    lines.push("- No sessions logged yet this week.");
  } else {
    lines.push(`- ${trained} session${trained === 1 ? "" : "s"} logged this week`);
    const last = sessions[0];
    const focus = last.focus ? ` (${last.focus})` : "";
    lines.push(`- Last: ${[last.date, last.name].filter(Boolean).join(" ")}${focus}`);
  }
  return lines.join("\n");
}

/** Latest recorded work plus the exact current-week plan state; never invent a session. */
function renderNextSessionTile({ session = null, planTitle = null, unavailable = false } = {}) {
  const lines = [`> [➡️|${TILE_COLORS.nextSession}] **Next Session**`];
  if (unavailable) {
    lines.push("- Workout history could not be refreshed, so no previous sets are shown.");
    lines.push("- Check the Workout Log before planning from these records.");
    return lines.join("\n");
  }

  if (planTitle) lines.push(`- Saved plan: ${planTitle}`);
  else lines.push("- No weekly plan is saved for this week yet. Use /plan to create one.");

  if (!session) {
    lines.push("- No completed or partial workout with readable sets is in the recent log.");
  } else {
    lines.push(`- Most recently logged: ${session.label}`);
    for (const lift of session.lifts.slice(0, 4)) {
      const result = Number.isFinite(lift.load)
        ? `${lift.load}kg × ${lift.reps}`
        : `${lift.reps} reps`;
      lines.push(`- ${lift.name}: ${result}`);
    }
  }

  lines.push(
    "- Ask /today for the next session; it checks your log, saved plan, recovery, and equipment.",
  );
  return lines.join("\n");
}

function renderGoalsTile(goals) {
  const lines = [`> [🎯|${TILE_COLORS.goals}] **Goals**`];
  const active = goals.filter((g) => g.status !== "Achieved" && g.status !== "Paused");
  const show = (active.length ? active : goals).slice(0, 5);
  if (!show.length) {
    lines.push("- No goals set yet.");
  } else {
    for (const g of show) {
      const hasNums = g.current !== "" && g.current != null && g.target !== "" && g.target != null;
      lines.push(`- ${g.goal}${hasNums ? `: ${g.current} / ${g.target}` : ""}`);
    }
  }
  return lines.join("\n");
}

function renderBodyStatsTile(latest) {
  const lines = [`> [⚖️|${TILE_COLORS.bodyStats}] **Body Stats**`];
  if (!latest) {
    lines.push("- No check-ins logged yet.");
  } else {
    const parts = [];
    if (latest.bodyweight !== "" && latest.bodyweight != null) parts.push(`${latest.bodyweight}kg`);
    if (latest.waist !== "" && latest.waist != null) parts.push(`waist ${latest.waist}cm`);
    lines.push(`- ${[latest.date, parts.join(", ")].filter(Boolean).join(": ")}`);
  }
  return lines.join("\n");
}

/**
 * Parse the user's daily nutrition targets out of PERSONAL.md markdown. Looks
 * for lines mentioning "daily calorie target" or "daily protein target" (case
 * insensitive, optional unit suffixes) and takes the first number on the line,
 * e.g. "- Daily calorie target (kcal): 2000". Missing lines yield null so the
 * tile simply omits that comparison instead of inventing a target.
 */
function parseTargetsFromMarkdown(md) {
  const targets = { calories: null, protein: null };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.toLowerCase();
    const num = raw.match(/(\d+(?:\.\d+)?)/);
    if (!num) continue;
    if (targets.calories == null && /daily\s+calorie\s+target/.test(line)) {
      targets.calories = Number(num[1]);
    } else if (targets.protein == null && /daily\s+protein\s+target/.test(line)) {
      targets.protein = Number(num[1]);
    }
  }
  return targets;
}

/** Read the targets file (gitignored PERSONAL.md at the repo root); never throws. */
function readPersonalTargets() {
  try {
    const file = path.resolve(process.cwd(), "PERSONAL.md");
    return parseTargetsFromMarkdown(fs.readFileSync(file, "utf8"));
  } catch {
    return { calories: null, protein: null };
  }
}

/**
 * Render the Nutrition tile from today's Meal Log rows plus the user's daily
 * targets. Like the other tiles, every number comes straight from the query
 * result (or the user's own stated target), never hand-written.
 */
function renderNutritionTile(meals, targets = {}) {
  const lines = [`> [🍽️|${TILE_COLORS.nutrition}] **Nutrition**`];
  if (!meals.length) {
    lines.push("- No meals logged yet today.");
    return lines.join("\n");
  }
  const sum = (key) =>
    Math.round(meals.reduce((total, m) => total + (Number.isFinite(m[key]) ? m[key] : 0), 0));
  const pct = (value, target) => (target > 0 ? ` (${Math.round((value / target) * 100)}%)` : "");
  lines.push(`- Meals logged today: ${meals.length}`);
  const kcal = sum("kcal");
  const protein = sum("protein");
  const kcalTarget = Number.isFinite(targets.calories) ? targets.calories : null;
  const proteinTarget = Number.isFinite(targets.protein) ? targets.protein : null;
  lines.push(
    `- Calories: ${kcal}${kcalTarget ? ` / ${kcalTarget} kcal${pct(kcal, kcalTarget)}` : ""}`,
  );
  lines.push(
    `- Protein: ${protein}g${proteinTarget ? ` / ${proteinTarget}g${pct(protein, proteinTarget)}` : ""}`,
  );
  return lines.join("\n");
}

const WEEKLY_PLAN_HISTORY = "Plan history";
const weeklyPlanText = (block) =>
  (block[block.type]?.rich_text ?? [])
    .map((part) => part.plain_text ?? part.text?.content ?? "")
    .join("");

/** Only complete, helper-owned entries are active plans or reset targets. */
function weeklyPlanEntryWeek(block) {
  if (block.type !== "callout") return null;
  return (
    /^Weekly Plan - (\d{4}-\d{2}-\d{2}) · Saved \d{4}-\d{2}-\d{2}T/.exec(
      weeklyPlanText(block),
    )?.[1] ?? null
  );
}

function validatePlanWeek(week) {
  const date = new Date(`${week}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(week ?? "") ||
    !Number.isFinite(date.getTime()) ||
    isoDate(date) !== week ||
    date.getUTCDay() !== 0
  ) {
    throw new Error("--week must be the training week's Sunday in YYYY-MM-DD format.");
  }
  return week;
}

async function weeklyPlanParents() {
  const hub = hubId();
  if (!hub) return [];
  const parents = [hub];
  const kb = readCache().__knowledgeBase;
  if (kb && normId(kb) !== normId(hub)) {
    try {
      if (await pageIsWithinHub(kb, hub)) parents.push(kb);
    } catch (err) {
      if (!/ -> 404:/.test(err.message)) throw err;
    }
  }
  return parents;
}

/** Resolve one persistent plan page, retaining old dated pages as readable history. */
async function getWeeklyPlanPageId(create = false) {
  const cache = readCache();
  const hub = hubId();
  const parentIds = await weeklyPlanParents();
  const pinned = cache.__workspacePages?.weeklyPlan ?? cache.__weeklyPlan;
  if (pinned) {
    try {
      const page = await notion(`/pages/${pinned}`, "GET");
      const title =
        Object.values(page.properties ?? {}).find((property) => property.title)?.title ?? [];
      const name = title.map((part) => part.plain_text ?? part.text?.content ?? "").join("");
      if (
        name === "Weekly Plan" &&
        !page.archived &&
        !page.in_trash &&
        hub &&
        (await pageIsWithinHub(page.parent?.page_id, hub))
      ) {
        return pinned;
      }
    } catch (err) {
      if (!/ -> 404:/.test(err.message)) throw err;
    }
  }
  let pageId;
  for (const parent of parentIds) {
    const pages = (await listChildren(parent)).filter(
      (block) => block.type === "child_page" && block.child_page?.title === "Weekly Plan",
    );
    if (pages.length > 1)
      throw new Error(
        "Multiple Weekly Plan pages found; choose one in the workspace cache before saving.",
      );
    if (pages.length && (await pageIsWithinHub(pages[0].id, hub))) {
      pageId = pages[0].id;
      break;
    }
  }
  if (!pageId && create) {
    if (!hub)
      throw new Error("The Notion Hub is not cached. Run resolve-workspace or /setup first.");
    const page = await notion("/pages", "POST", {
      parent: { page_id: hub },
      icon: { type: "emoji", emoji: "📅" },
      properties: { title: { title: [plain("Weekly Plan")] } },
      children: markdownToBlocks(
        `Your newest saved plan appears first below. Earlier plans remain available here.\n\n## ${WEEKLY_PLAN_HISTORY}`,
      ),
    });
    pageId = page.id;
  }
  if (pageId) {
    cache.__weeklyPlan = pageId;
    cache.__workspacePages = { ...cache.__workspacePages, weeklyPlan: pageId };
    writeCache(cache);
  }
  return pageId ?? null;
}

async function findLegacyWeeklyPlan(week) {
  const hub = hubId();
  for (const parent of await weeklyPlanParents()) {
    const page = (await listChildren(parent)).find(
      (block) => block.type === "child_page" && block.child_page?.title === `Weekly Plan - ${week}`,
    );
    if (page && (await pageIsWithinHub(page.id, hub))) return page.id;
  }
  return null;
}

/** Save an open, dated callout at the top; never replace or delete prior plans. */
async function cmdWeeklyPlan(args) {
  const action = args.action ?? "show";
  if (action !== "save" && action !== "show")
    throw new Error("Use weekly-plan --action show or --action save.");
  const week = args.week == null && action === "show" ? null : validatePlanWeek(args.week);
  const md =
    action === "save"
      ? args.file
        ? fs.readFileSync(args.file, "utf8")
        : String(args.md ?? "")
      : "";
  const blocks = action === "save" ? markdownToBlocks(md) : [];
  if (action === "save" && !blocks.length)
    throw new Error("The weekly plan cannot be empty. Pass --md or --file.");
  const pageId = await getWeeklyPlanPageId(action === "save");
  const children = pageId ? await listChildren(pageId) : [];
  if (action === "show") {
    const entry = children.find(
      (block) => weeklyPlanEntryWeek(block) && (!week || weeklyPlanEntryWeek(block) === week),
    );
    if (entry) {
      console.log(
        `Weekly Plan page: ${pageId}\n## ${weeklyPlanText(entry)}\n${await blocksToMarkdown(entry.id)}`,
      );
      return;
    }
    const legacy = week ? await findLegacyWeeklyPlan(week) : null;
    console.log(
      legacy
        ? `Legacy weekly plan: ${legacy}\n${await blocksToMarkdown(legacy)}`
        : "No saved plan found for this week.",
    );
    return;
  }
  const anchor = children.find(
    (block) => block.type === "heading_2" && weeklyPlanText(block) === WEEKLY_PLAN_HISTORY,
  );
  if (!anchor)
    throw new Error(
      'Weekly Plan is missing its "Plan history" heading. Run /setup before saving; existing content was kept.',
    );
  const savedAt = new Date().toISOString();
  const result = await notion(`/blocks/${pageId}/children`, "PATCH", {
    after: anchor.id,
    children: [
      {
        object: "block",
        type: "callout",
        callout: {
          rich_text: rt(`Weekly Plan - ${week} · Saving (incomplete) ${savedAt}`),
          icon: { type: "emoji", emoji: "📅" },
        },
      },
    ],
  });
  const entryId = result.results?.[0]?.id;
  if (!entryId)
    throw new Error("Notion did not return the plan entry ID; check the page before retrying.");
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${entryId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  await notion(`/blocks/${entryId}`, "PATCH", {
    callout: { rich_text: rt(`Weekly Plan - ${week} · Saved ${savedAt}`) },
  });
  console.log(
    `Saved Weekly Plan - ${week} at the top of Weekly Plan page ${pageId}. Earlier plans were kept.`,
  );
}

async function findCurrentWeeklyPlanTitle(now) {
  const week = isoDate(startOfWeekSundayUTC(now));
  const pageId = await getWeeklyPlanPageId();
  if (pageId && (await listChildren(pageId)).some((block) => weeklyPlanEntryWeek(block) === week)) {
    return `Weekly Plan - ${week}`;
  }
  return (await findLegacyWeeklyPlan(week)) ? `Weekly Plan - ${week}` : null;
}

/**
 * Replace a column's children with fresh content, append-then-delete: write the
 * new blocks first, then delete the previously-existing ones. A failure mid-append
 * leaves the old tile intact (brief duplication) rather than wiping it to empty.
 * Returns the number of blocks written.
 */
async function replaceTileContent(columnId, md, forceColor) {
  const blocks = markdownToBlocks(md);
  // Lock the tile's header callout to its canonical color so it never drifts,
  // regardless of what color (if any) the source markdown specified.
  if (forceColor) {
    const header = blocks.find((b) => b.type === "callout");
    if (header) header.callout.color = normalizeColor(forceColor);
  }
  await replaceManagedBlocks(columnId, blocks);
  return blocks.length;
}

async function replaceManagedBlocks(containerId, blocks) {
  const oldIds = (await listChildren(containerId)).map((b) => b.id);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(
      `/blocks/${containerId}/children`,
      "PATCH",
      { children: blocks.slice(i, i + 100) },
      { version: "2026-03-11" },
    );
  }
  for (const id of oldIds) await notion(`/blocks/${id}`, "DELETE");
}

function dashboardDate(args) {
  const date =
    args.now ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.TIMEZONE ?? "Etc/UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    throw new Error("Dashboard needs a valid YYYY-MM-DD date.");
  return date;
}

/** Read each source once; this warm path never writes the shared ID cache. */
async function dashboardModel(date) {
  const cache = readCache();
  const resourceId = cache.__resources ?? cache.__workspacePages?.resources;
  if (!resourceId || !(await pageIsWithinHub(resourceId, hubId())))
    throw new Error("Workspace resources are not verified under the pinned Hub. Run /setup first.");
  const model = { date, weekStart: isoDate(startOfWeekSundayUTC(new Date(date))) };
  const failures = [];
  const number = (prop) =>
    prop?.type === "number" && Number.isFinite(prop.number) ? prop.number : null;
  const value = (row, schema, test) => readProp(row.properties?.[findProp(schema, test)]);
  const numeric = (row, schema, text) =>
    number(row.properties?.[findProp(schema, (n, d) => d.type === "number" && n.includes(text))]);
  for (const name of ["Workout Log", "Meal Log", "Body Stats", "Goals", "Programs"]) {
    try {
      const id = cache[name];
      if (!id) throw new Error("Source ID missing; run /setup first.");
      const db = await notion(`/databases/${id}`);
      if (normId(db.parent?.page_id) !== normId(resourceId))
        throw new Error("Source database moved outside verified workspace resources.");
      const schema = db.properties ?? {};
      const dateProp = findProp(schema, (_n, d) => d.type === "date");
      const query = {};
      if (["Workout Log", "Meal Log", "Body Stats"].includes(name)) {
        if (!dateProp) throw new Error("Source has no Date property.");
        query.filter = {
          property: dateProp,
          date: name === "Meal Log" ? { equals: date } : { on_or_before: date },
        };
        query.sorts = [{ property: dateProp, direction: "descending" }];
        if (name === "Workout Log")
          query.filter = {
            and: [
              query.filter,
              {
                property: dateProp,
                date: { on_or_after: isoDate(new Date(new Date(date).getTime() - 84 * 86400000)) },
              },
            ],
          };
      }
      const rows = await queryAllRows(id, query);
      if (name === "Workout Log") {
        model.workouts = [];
        for (const row of rows) {
          const workout = {
            date: String(readProp(row.properties?.[dateProp])).slice(0, 10),
            duration: numeric(row, schema, "duration"),
            sessions: numeric(row, schema, "session"),
            focus: value(row, schema, (n) => n.includes("focus")),
            status: value(row, schema, (n) => n.includes("status")),
          };
          if (row.properties?.[dateProp]?.date?.end || workout.sessions > 1) {
            const { extractSessionDates } = await import("./publish-heatmap.mjs");
            const dates = extractSessionDates(await blocksToMarkdown(row.id), workout.date);
            if (!dates.length)
              throw new Error(
                "A legacy weekly row needs dated session headings before it can be charted accurately.",
              );
            model.workouts.push(
              ...dates.map((sessionDate) => ({
                ...workout,
                date: sessionDate,
                sessions: 1,
                duration: null,
              })),
            );
          } else model.workouts.push(workout);
        }
      }
      if (name === "Body Stats")
        model.bodyStats = rows.map((row) => ({
          date: String(readProp(row.properties?.[dateProp])).slice(0, 10),
          weight: numeric(row, schema, "bodyweight"),
        }));
      if (name === "Meal Log") {
        const { summarizeNutrition } = await import("./notion-nutrition.mjs");
        model.meals = rows.map((row) => ({
          name: value(row, schema, (_n, d) => d.type === "title") || "Daily record",
          kcal: numeric(row, schema, "calorie"),
          protein: numeric(row, schema, "protein"),
        }));
        model.nutrition = summarizeNutrition(date, model.meals, readPersonalTargets());
        model.dailyPageId = rows.length === 1 ? rows[0].id : undefined;
        if (rows.length === 1) {
          const body = await listChildren(rows[0].id);
          const names = body.filter((b) => b.type === "bulleted_list_item").map(weeklyPlanText);
          const occasions = body.filter((b) => b.type === "heading_2").map(weeklyPlanText);
          if (names.length) {
            model.meals[0].occasion = occasions.length === 1 ? occasions[0] : "Daily record";
            model.meals[0].name = names.join(" · ");
          }
        }
      }
      if (name === "Goals")
        model.goals = rows
          .map((row) => ({
            title: value(row, schema, (_n, d) => d.type === "title"),
            current: numeric(row, schema, "current"),
            target: numeric(row, schema, "target value"),
            status: value(row, schema, (n) => n === "status"),
          }))
          .filter((row) => !/^(achieved|completed|cancelled|canceled|archived)$/i.test(row.status));
      if (name === "Programs") {
        const active = rows.find((row) =>
          /^active$/i.test(value(row, schema, (n) => n === "status")),
        );
        model.program = active
          ? { name: value(active, schema, (_n, d) => d.type === "title") }
          : null;
      }
    } catch (error) {
      failures.push(name);
      console.error(`${name} overview unavailable: ${error.message}`);
      if (name === "Meal Log") {
        model.nutrition = undefined;
        model.meals = undefined;
      }
      if (name === "Workout Log") model.workouts = undefined;
    }
  }
  try {
    const md = fs.readFileSync(path.resolve("PERSONAL.md"), "utf8");
    const match = md.match(
      /(?:training\s+(?:days|sessions)\s+per\s+week|weekly\s+(?:training|session)\s+target)\s*[:=]\s*(\d+)\b/i,
    );
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 14)
      model.trainingTarget = Number(match[1]);
  } catch {
    /* A missing training target stays unset. */
  }
  return { model, failures };
}

/** Update only this generated display; never traverse or rewrite the source logs. */
async function updateOverviewImage(containerId, image, text, record) {
  const children = await listChildren(containerId);
  const current = children.find((b) => b.type === "image");
  if (current) {
    const { type: _type, ...update } = image;
    await notion(`/blocks/${current.id}`, "PATCH", { image: update }, { version: "2026-03-11" });
  } else
    await notion(
      `/blocks/${containerId}/children`,
      "PATCH",
      { children: [{ type: "image", image }] },
      { version: "2026-03-11" },
    );
  const paragraph = children.find((b) => b.type === "paragraph");
  if (paragraph)
    await notion(`/blocks/${paragraph.id}`, "PATCH", { paragraph: { rich_text: rt(text) } });
  else
    await notion(`/blocks/${containerId}/children`, "PATCH", {
      children: [{ type: "paragraph", paragraph: { rich_text: rt(text) } }],
    });
  if (record) {
    const link = children.find(
      (b) =>
        b.type === "paragraph" &&
        /^(Open \d{4}-\d{2}-\d{2}'s meal record|Daily summary · \d{4}-\d{2}-\d{2})$/.test(
          weeklyPlanText(b),
        ),
    );
    const rich_text = [
      {
        type: "text",
        text: {
          content: record.pageId
            ? `Open ${record.date}'s meal record`
            : `Daily summary · ${record.date}`,
          ...(record.pageId
            ? { link: { url: `https://www.notion.so/${normId(record.pageId)}` } }
            : {}),
        },
      },
    ];
    if (link) await notion(`/blocks/${link.id}`, "PATCH", { paragraph: { rich_text } });
  }
}

async function refreshOverview(args, dashboard) {
  const started = Date.now();
  const { model, failures } = await dashboardModel(dashboardDate(args));
  const { renderDashboardPng, dashboardCaption } = await import("./notion-dashboard.mjs");
  const { uploadPngImage, uploadNutritionImage, nutritionCaption } = await import(
    "./notion-nutrition.mjs"
  );
  const renderStarted = Date.now();
  const png = await renderDashboardPng(model);
  const renderMs = Date.now() - renderStarted;
  const caption = dashboardCaption(model);
  const uploadId = await uploadPngImage(notion, png, "fitness-overview.png");
  await updateOverviewImage(
    dashboard.overviewBlockId,
    { type: "file_upload", file_upload: { id: uploadId }, caption: rt(caption) },
    caption,
  );
  if (model.nutrition) {
    const cache = readCache();
    const mealPage = cache.__workspacePages?.meals ?? cache.__mealLogPage;
    if (!mealPage || !(await pageIsWithinHub(mealPage, hubId())))
      throw new Error("Meal summary page is outside the pinned workspace.");
    const summary = (await listChildren(mealPage)).find(
      (b) => b.type === "callout" && weeklyPlanText(b) === "Daily nutrition",
    );
    if (!summary)
      throw new Error("Meal Log is missing its Daily nutrition summary. Run /setup first.");
    const nutritionUpload = await uploadNutritionImage(notion, model.nutrition);
    await updateOverviewImage(
      summary.id,
      {
        type: "file_upload",
        file_upload: { id: nutritionUpload },
        caption: rt(nutritionCaption(model.nutrition)),
      },
      model.nutrition.incomplete
        ? "Some saved nutrition values are missing. The Dashboard and this page use the same available daily totals."
        : "The Dashboard and this page use the same daily totals. Recorded intake is an estimate; missing logs do not mean you ate nothing.",
      { date: model.date, pageId: model.dailyPageId },
    );
  }
  console.log(
    JSON.stringify({
      refreshed: "Dashboard and Meal Log",
      date: model.date,
      renderMs,
      durationMs: Date.now() - started,
      unavailable: failures,
    }),
  );
  if (failures.length)
    throw new Error(`Dashboard refreshed with unavailable sources: ${failures.join(", ")}.`);
}

/** Both summaries are calculated once from the same day; graphs are uploaded only to Notion. */
async function cmdSyncNutrition(args, providedColumns) {
  let columns = providedColumns;
  if (!columns) {
    const dashboard = await resolveDashboard();
    if (dashboard.layout === "overview") return refreshOverview(args, dashboard);
    columns = dashboard.columns;
  }
  const date =
    args.now ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.TIMEZONE ?? "Etc/UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const mId = await resolveDbId("Meal Log");
  const schema = (await notion(`/databases/${mId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  if (!dateProp)
    throw new Error("Meal Log has no Date property; refusing an undated nutrition total.");
  const kcalProp = findProp(schema, (n) => n.includes("calorie"));
  const proteinProp = findProp(schema, (n) => n.includes("protein"));
  const rows = await queryAllRows(mId, { filter: { property: dateProp, date: { equals: date } } });
  const number = (prop) =>
    prop?.type === "number" && Number.isFinite(prop.number) ? prop.number : Number.NaN;
  const meals = rows.map((pg) => ({
    kcal: number(pg.properties?.[kcalProp]),
    protein: number(pg.properties?.[proteinProp]),
  }));
  const targets = readPersonalTargets();
  const { summarizeNutrition, uploadNutritionImage, nutritionBlocks } = await import(
    "./notion-nutrition.mjs"
  );
  const summary = summarizeNutrition(date, meals, targets);
  const cols = columns ?? (await resolveDashboard()).columns ?? {};
  const cache = readCache();
  const mealPage = cache.__workspacePages?.meals ?? cache.__mealLogPage;
  let summaryBlock;
  if (mealPage && (await pageIsWithinHub(mealPage, hubId()))) {
    summaryBlock = (await listChildren(mealPage)).find(
      (b) =>
        b.type === "callout" &&
        (b.callout.rich_text ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("") ===
          "Daily nutrition",
    );
  }
  let uploadId;
  try {
    uploadId = await uploadNutritionImage(notion, summary);
  } catch (error) {
    console.error(`Nutrition image unavailable; showing recorded totals as text: ${error.message}`);
  }
  const brief = uploadId
    ? nutritionBlocks(summary, uploadId)
    : markdownToBlocks(`**${date}**\n${renderNutritionTile(meals, targets)}`);
  if (cols.nutrition) {
    await replaceManagedBlocks(cols.nutrition, [
      {
        type: "callout",
        callout: {
          rich_text: [
            { type: "text", text: { content: "Daily nutrition" }, annotations: { bold: true } },
          ],
          icon: { type: "emoji", emoji: "🍽️" },
          color: TILE_COLORS.nutrition,
        },
      },
      ...brief,
    ]);
  }
  if (summaryBlock) {
    await replaceManagedBlocks(
      summaryBlock.id,
      uploadId
        ? nutritionBlocks(summary, uploadId, {
            detailed: true,
            dailyPageId: rows.length === 1 ? rows[0].id : undefined,
          })
        : brief,
    );
  }
  console.log(
    `Synced daily nutrition for ${date}${summaryBlock ? " on Dashboard and Meal Log" : " on Dashboard; run compact workspace setup to add the Meal Log summary"}.`,
  );
}

// ─── commands ────────────────────────────────────────────────────────────────
async function cmdResolveDb(args) {
  const id = await resolveDbId(args.name ?? args.db);
  console.log(id);
}

async function cmdQueryRecent(args) {
  const dbId = await resolveDbId(args.db);
  const limit = Number.parseInt(args.limit ?? "3", 10);
  const db = await notion(`/databases/${dbId}`);
  const schema = db.properties ?? {};
  const dateProp = Object.keys(schema).find((k) => schema[k].type === "date");
  const body = { page_size: limit };
  if (dateProp) body.sorts = [{ property: dateProp, direction: "descending" }];
  if (args.focus) {
    // Match the filter shape to the real property type: the Workout Log's
    // Focus is a multi_select (select { equals } silently matches nothing).
    const focusKey = Object.keys(schema).find((k) => k.toLowerCase() === "focus") ?? "Focus";
    const focusType = schema[focusKey]?.type;
    if (focusType === "multi_select") {
      body.filter = { property: focusKey, multi_select: { contains: args.focus } };
    } else if (focusType === "status") {
      body.filter = { property: focusKey, status: { equals: args.focus } };
    } else {
      body.filter = { property: focusKey, select: { equals: args.focus } };
    }
  }

  const res = await notion(`/databases/${dbId}/query`, "POST", body);
  if (!res.results?.length) {
    console.log("No matching rows.");
    return;
  }

  // Resolve property names from the actual schema so this adapts to any database
  // (e.g. "RPE (1-10)" vs "RPE"), rather than assuming fixed names.
  const titleProp = Object.keys(schema).find((k) => schema[k].type === "title");
  const byName = (needle) => Object.keys(schema).find((k) => k.toLowerCase().includes(needle));
  const focusProp = byName("focus");
  const rpeProp = byName("rpe");
  const exProp = byName("exercise");

  let p;
  const get = (name) => readProp(name ? p[name] : null);
  for (const page of res.results) {
    p = page.properties ?? {};
    const parts = [get(dateProp), get(titleProp)];
    if (focusProp) parts.push(`Focus: ${get(focusProp)}`);
    if (rpeProp) parts.push(`RPE: ${get(rpeProp)}`);
    console.log(`- ${parts.filter(Boolean).join(" | ")}`);
    if (exProp && get(exProp)) console.log(`    ${get(exProp)}`);
  }
}

/** Inventory all distinct logged exercise headings for first-time library population. */
async function cmdExerciseInventory() {
  const dbId = await resolveDbId("Workout Log");
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  const statusProp = findProp(schema, (n) => n.toLowerCase() === "status");
  const rows = await queryAllRows(dbId, {
    ...(dateProp ? { sorts: [{ property: dateProp, direction: "descending" }] } : {}),
  });
  const eligibleRows = rows.filter((row) => {
    const status = String(readProp(row.properties?.[statusProp]) ?? "").toLowerCase();
    return status !== "skipped";
  });
  const inventory = new Map();
  const latestDate = eligibleRows.reduce((latest, row) => {
    const value = dateProp ? row.properties?.[dateProp]?.date?.start : undefined;
    const date = typeof value === "string" ? value.slice(0, 10) : null;
    return date && (!latest || date > latest) ? date : latest;
  }, null);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, eligibleRows.length) }, async () => {
    while (nextIndex < eligibleRows.length) {
      const row = eligibleRows[nextIndex++];
      const dateValue = dateProp ? row.properties?.[dateProp]?.date?.start : undefined;
      const day = typeof dateValue === "string" ? dateValue.slice(0, 10) : null;
      const seenOnRow = new Set();
      const blocks = await listChildren(row.id);
      for (const block of blocks) {
        if (block.type !== "heading_3") continue;
        const name = (block.heading_3?.rich_text ?? [])
          .map((part) => part.plain_text ?? part.text?.content ?? "")
          .join("")
          .trim();
        if (!name) continue;
        const canonical = canonicalExerciseName(name);
        const key = canonical.toLocaleLowerCase();
        if (seenOnRow.has(key)) continue;
        seenOnRow.add(key);
        const item = inventory.get(key) ?? { name: canonical, daysLogged: 0, lastDate: null };
        item.daysLogged++;
        if (day && (!item.lastDate || day > item.lastDate)) item.lastDate = day;
        inventory.set(key, item);
      }
    }
  });
  await Promise.all(workers);
  const exercises = [...inventory.values()].sort(
    (a, b) => b.daysLogged - a.daysLogged || a.name.localeCompare(b.name),
  );
  console.log(JSON.stringify({ rowsScanned: eligibleRows.length, latestDate, exercises }, null, 2));
}

async function getExerciseLibraryPageId() {
  const cache = readCache();
  if (cache.__exerciseLibrary) return cache.__exerciseLibrary;
  const parentId = cache.__knowledgeBase;
  if (!parentId) {
    throw new Error("Exercise Library is not cached. Run notion.mjs resolve-workspace first.");
  }
  const children = await listChildren(parentId);
  const page = children.find(
    (block) => block.type === "child_page" && block.child_page?.title === "Exercise Library",
  );
  if (!page) throw new Error("Exercise Library is missing. Run setup-workspace.mjs first.");
  cache.__exerciseLibrary = page.id;
  writeCache(cache);
  return page.id;
}

/** One meal write plus checked daily totals, without a dashboard rebuild on the reply path. */
async function cmdLogMeal(args) {
  const date = args.date;
  const parsedDate = new Date(`${date}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
    !Number.isFinite(parsedDate.getTime()) ||
    isoDate(parsedDate) !== date
  ) {
    throw new Error("log-meal requires --date YYYY-MM-DD from the Telegram date context.");
  }
  if (args.db && args.db !== "Meal Log") throw new Error("log-meal only writes to Meal Log.");
  const md = args["body-file"] ? fs.readFileSync(args["body-file"], "utf8") : (args.body ?? "");
  if (typeof md !== "string" || !md.trim())
    throw new Error("log-meal requires a nonempty --body or --body-file.");
  let mealBlocks = markdownToBlocks(normalizeDailyDayHeadings(md, date));
  if (!mealBlocks.length) throw new Error("The meal body cannot be empty.");

  const dbId = await resolveDbId("Meal Log");
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, def) => def.type === "date");
  const titleProp = findProp(schema, (_n, def) => def.type === "title");
  const calories = findProp(
    schema,
    (name, def) => def.type === "number" && name.includes("calorie"),
  );
  const protein = findProp(
    schema,
    (name, def) => def.type === "number" && name.includes("protein"),
  );
  const occasionProp = findProp(schema, (name) => name === "meal type");
  const sourceProp = findProp(schema, (name) => name === "source");
  if (![dateProp, titleProp, calories, protein, occasionProp, sourceProp].every(Boolean)) {
    throw new Error("Meal Log schema is incomplete; run /setup before saving a meal.");
  }
  const sets = args.set ?? [];
  const values = new Map();
  for (const pair of sets) {
    if (typeof pair !== "string" || !pair.includes("="))
      throw new Error('--set must be "Name=value".');
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1);
    const def = schema[name];
    if (!def)
      throw new Error(`Property "${name}" not found. Have: ${Object.keys(schema).join(", ")}`);
    if (values.has(name)) throw new Error(`Duplicate meal property: ${name}.`);
    if (def.type === "title" || def.type === "date")
      throw new Error(
        "log-meal owns the daily title/date; use --date and omit title/date --set values.",
      );
    validateValue(name, def, value);
    if (
      def.type === "number" &&
      (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)
    ) {
      throw new Error(`"${name}" needs a finite, nonnegative per-meal number, without += or >=.`);
    }
    values.set(name, value);
  }
  const missing = [calories, protein, occasionProp, sourceProp].filter(
    (name) => !values.has(name) || !values.get(name).trim(),
  );
  if (missing.length) throw new Error(`Missing meal values: ${missing.join(", ")}.`);
  const occasion = values.get(occasionProp);
  const order = ["Breakfast", "Lunch", "Tea", "Dinner", "Supper"];
  const blockText = (block) =>
    (block[block.type]?.rich_text ?? [])
      .map((part) => part.plain_text ?? part.text?.content ?? "")
      .join("");
  if (mealBlocks[0].type === "heading_2" && blockText(mealBlocks[0]) === occasion)
    mealBlocks = mealBlocks.slice(1);
  if (
    !mealBlocks.length ||
    mealBlocks.some((block) => block.type === "heading_2" && order.includes(blockText(block)))
  ) {
    throw new Error("The body must contain meal details for only the supplied Meal Type.");
  }
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    parsedDate,
  );
  const title = `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(2, 4)} (${weekday})`;
  const createSets = [`${titleProp}=${title}`, `${dateProp}=${date}`, ...sets];
  if (args["dry-run"]) {
    const properties = await buildProperties(dbId, createSets, { schema, dryRun: true });
    console.log(`Dry run: meal input validated, nothing written. ${JSON.stringify(properties)}`);
    return { dryRun: true };
  }
  const rows = await queryAllRows(dbId, { filter: { property: dateProp, date: { equals: date } } });
  if (rows.length > 1)
    throw new Error(
      `Meal Log has multiple daily rows for ${date}; nothing was written. Resolve the duplicate rows before logging another meal.`,
    );
  const row = rows[0];
  if (
    row &&
    (row.properties?.[dateProp]?.date?.end ||
      row.properties?.[dateProp]?.date?.start?.slice(0, 10) !== date)
  ) {
    throw new Error("The matching Meal Log row is not a single daily date; nothing was written.");
  }
  const previous = row ? await listChildren(row.id) : [];
  const isOccasion = (block) => block.type === "heading_2" && order.includes(blockText(block));
  const existing = previous.findLastIndex(
    (block) => isOccasion(block) && blockText(block) === occasion,
  );
  let insertAt =
    existing < 0
      ? previous.findIndex(
          (block) => isOccasion(block) && order.indexOf(blockText(block)) > order.indexOf(occasion),
        )
      : previous.findIndex((block, index) => index > existing && isOccasion(block));
  if (insertAt < 0) insertAt = previous.length;
  if (existing < 0)
    mealBlocks.unshift({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: rt(occasion) },
    });
  let afterId = insertAt > 0 ? previous[insertAt - 1].id : null;
  let savedId;
  try {
    savedId = row
      ? await cmdUpdate(
          {
            page: row.id,
            set: sets.map((pair) => {
              const at = pair.indexOf("=");
              const name = pair.slice(0, at).trim();
              const value = pair.slice(at + 1);
              if (schema[name].type === "number") return `${name}=+=${value}`;
              if (name.toLowerCase() === "notes" && schema[name].type === "rich_text") {
                const previousNote = readProp(row.properties?.[name]);
                return `${name}=${previousNote ? `${previousNote}\n` : ""}${value}`;
              }
              return pair;
            }),
          },
          { page: row, schema },
        )
      : await cmdLog({ db: "Meal Log", set: createSets }, { dbId, schema });
    for (let i = 0; i < mealBlocks.length; i += 100) {
      const prepend = previous.length > 0 && insertAt === 0 && i === 0;
      const result = await notion(
        `/blocks/${savedId}/children`,
        "PATCH",
        {
          children: mealBlocks.slice(i, i + 100),
          ...(afterId ? { after: afterId } : prepend ? { position: { type: "start" } } : {}),
        },
        prepend ? { version: "2026-03-11" } : undefined,
      );
      afterId = result.results?.at(-1)?.id;
      if (!afterId && i + 100 < mealBlocks.length)
        throw new Error("Notion returned no last block ID for the remaining meal details.");
    }
    const summary = await cmdSumDay({ db: "Meal Log", date }, { dbId, schema, quiet: true });
    if (summary.rows !== 1) throw new Error("The saved daily row could not be uniquely verified.");
    const result = { pageId: savedId, ...summary };
    console.log(`Meal saved: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    throw new Error(
      savedId
        ? `Meal row ${savedId} was saved, but its details or daily totals could not be completed. Check the existing row before trying again; do not log the meal twice. ${error.message}`
        : `The meal write could not be verified and may have committed. Check ${date} in Meal Log before trying again; do not automatically retry. ${error.message}`,
    );
  }
}

/** Read or replace only the canonical Exercise Library note, keeping its target fixed. */
async function cmdExerciseLibrary(args) {
  const pageId = await getExerciseLibraryPageId();
  const action = args.action ?? "show";
  if (action === "show") {
    const md = await blocksToMarkdown(pageId);
    console.log(`Exercise Library page: ${pageId}\n${md || "(empty body)"}`);
    return;
  }
  if (action !== "replace") {
    throw new Error('Use exercise-library --action show, or --action replace --md "...".');
  }
  const md = args.file ? fs.readFileSync(args.file, "utf8") : String(args.md ?? "");
  if (!md.trim()) throw new Error("Exercise Library replacement content cannot be empty.");
  const groups = ["Chest", "Biceps", "Triceps", "Back", "Legs", "Shoulders"];
  const missing = groups.filter((group) => !new RegExp(`^##\\s+${group}\\s*$`, "m").test(md));
  if (missing.length) {
    throw new Error(`Exercise Library must retain these groups: ${missing.join(", ")}.`);
  }

  const oldIds = (await listChildren(pageId)).map((block) => block.id);
  const blocks = markdownToBlocks(md);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${pageId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  for (const id of oldIds) await notion(`/blocks/${id}`, "DELETE");
  console.log(`Replaced Exercise Library with ${blocks.length} blocks.`);
}

async function cmdLog(args, { dbId: knownDbId, schema } = {}) {
  const dbId = knownDbId ?? (await resolveDbId(args.db));
  // A row with no values is worse than no row: it pollutes the log and every
  // dashboard total derived from it. Refuse loudly rather than writing hollow
  // rows (this also catches shell-quoting mangling of --set arguments).
  const sets = (args.set ?? []).filter((s) => typeof s === "string" && s.trim());
  if (!sets.length) {
    throw new Error(
      'Nothing to log: no usable --set values were received. Expected e.g. log --db "Meal Log" --set "Meal=Chicken rice bowl" --set "Calories (kcal)=500". ' +
        "On Windows shells, double-quote each --set value; single quotes are not honoured.",
    );
  }
  const properties = await buildProperties(dbId, sets, {
    dryRun: Boolean(args["dry-run"]),
    schema,
  });
  // --dry-run validates and prints the parsed row without writing, so the coach
  // can read it back before committing (supports the "confirm before logging" flow).
  if (args["dry-run"]) {
    console.log("Dry run, nothing written. Parsed properties:");
    console.log(JSON.stringify(properties, null, 2));
    return;
  }
  const page = await notion("/pages", "POST", { parent: { database_id: dbId }, properties });
  if (args.body || args["body-file"]) {
    let md = args["body-file"] ? fs.readFileSync(args["body-file"], "utf8") : args.body;
    const date = Object.values(properties).find((value) => value.date?.start && !value.date.end)
      ?.date?.start;
    if (date) md = normalizeDailyDayHeadings(md, date);
    await appendBlocks(page.id, md);
    console.log(`Logged row ${page.id} with body (${chunkCount(md)} block(s))`);
  } else {
    console.log(`Logged row ${page.id}`);
  }
  return page.id;
}

/**
 * Parse an operator prefix off a --set value. Plain values are plain sets;
 * "+=N" adds N to the current number and ">=N" keeps the larger of the two.
 * This is what lets one Notion row accumulate a whole day of meals or sets
 * without the model doing arithmetic on live data.
 */
function parseValueOp(value) {
  if (value.startsWith("+=")) return { op: "add", value: value.slice(2) };
  if (value.startsWith(">=")) return { op: "max", value: value.slice(2) };
  return { op: "set", value };
}

/** Find the row whose Date property equals --date; prints its id and title. */
async function cmdFindRow(args) {
  const dbId = await resolveDbId(args.db);
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  const titleProp = findProp(schema, (_n, d) => d.type === "title");
  if (!dateProp || !args.date) throw new Error("--db and --date YYYY-MM-DD are required");
  const res = await notion(`/databases/${dbId}/query`, "POST", {
    filter: { property: dateProp, date: { equals: args.date } },
    page_size: 5,
  });
  const row = res.results?.[0];
  if (!row) {
    console.log(`No row for ${args.date}.`);
    return;
  }
  console.log(row.id);
  console.log(`Title: ${readProp(row.properties?.[titleProp])}`);
  // Daily-row merges need the current Focus union and per-day session count.
  const focusProp = findProp(
    schema,
    (n, d) => n.includes("focus") && (d.type === "multi_select" || d.type === "select"),
  );
  if (focusProp) console.log(`Focus: ${readProp(row.properties?.[focusProp])}`);
  const sessProp = findProp(schema, (n, d) => n.includes("session") && d.type === "number");
  if (sessProp) console.log(`Sessions: ${readProp(row.properties?.[sessProp])}`);
}

/** Read the body blocks of a page and print them as markdown. */
async function cmdReadBlocks(args) {
  if (!args.page) throw new Error("--page <pageId> is required");
  const md = await blocksToMarkdown(args.page);
  console.log(md || "(empty body)");
}

/** Soft-delete a Notion page (recoverable from trash for 30 days). */
async function cmdArchive(args) {
  if (!args.page) throw new Error("--page <pageId> is required");
  await notion(`/pages/${args.page}`, "PATCH", {
    archived: true,
    in_trash: true,
  });
  console.log(`Archived ${args.page}`);
}

/**
 * Update properties on an existing row (upsert flow: find-row first, then
 * update). Supports operator values: "Prop==X" sets, "Prop=+=N" adds N to the
 * current number, "Prop=>=N" raises to N only if N is larger. Everything else
 * goes through the same coercion and validation as `log`.
 */
async function cmdUpdate(args, { page: knownPage, schema: knownSchema } = {}) {
  if (!args.page) throw new Error("--page <rowPageId> is required");
  const sets = (args.set ?? []).filter((s) => typeof s === "string" && s.trim());
  if (!sets.length) {
    throw new Error(
      'Nothing to update: no usable --set values were received. Example: update --page <id> --set "Calories (kcal)=+=450". ' +
        "On Windows shells, double-quote each --set value.",
    );
  }
  const page = knownPage ?? (await notion(`/pages/${args.page}`));
  const dbId = page.parent?.database_id;
  if (!dbId) throw new Error("--page must be a database row (it has no database parent).");
  const schema = knownSchema ?? (await notion(`/databases/${dbId}`)).properties ?? {};

  const finalPairs = [];
  for (const pair of sets) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new Error(`--set must be "Name=value", got "${pair}"`);
    const name = pair.slice(0, idx).trim();
    const { op, value } = parseValueOp(pair.slice(idx + 1));
    if (op === "set") {
      finalPairs.push(`${name}=${value}`);
      continue;
    }
    const def = schema[name];
    if (!def)
      throw new Error(`Property "${name}" not found. Have: ${Object.keys(schema).join(", ")}`);
    if (def.type !== "number") {
      throw new Error(`Operator +=/>= only works on number properties; "${name}" is ${def.type}.`);
    }
    const current = Number(readProp(page.properties?.[name])) || 0;
    const operand = Number(value);
    if (!Number.isFinite(operand))
      throw new Error(`"${name}=(${op})${value}" needs a numeric operand.`);
    const target = op === "add" ? current + operand : Math.max(current, operand);
    finalPairs.push(`${name}=${target}`);
  }

  const dateProp = findProp(schema, (_name, def) => def.type === "date");
  const savedDate = page.properties?.[dateProp]?.date?.start?.slice(0, 10);
  const properties = await buildProperties(dbId, finalPairs, { fallbackDate: savedDate, schema });
  await notion(`/pages/${args.page}`, "PATCH", { properties });
  if (args.body || args["body-file"]) {
    let md = args["body-file"] ? fs.readFileSync(args["body-file"], "utf8") : args.body;
    const dateProp = findProp(schema, (_name, def) => def.type === "date");
    const date = page.properties?.[dateProp]?.date;
    if (date?.start && !date.end) md = normalizeDailyDayHeadings(md, date.start);
    const blocks = await appendBlocks(args.page, md);
    console.log(`Updated row ${args.page} (+${blocks} body block(s))`);
  } else {
    console.log(`Updated row ${args.page}`);
  }
  return args.page;
}

async function cmdAppend(args) {
  if (!args.page) throw new Error("--page <blockOrPageId> is required");
  const md = args.file ? fs.readFileSync(args.file, "utf8") : (args.md ?? "");
  if (!md.trim()) throw new Error("Nothing to append: pass --md or --file");
  const blocks = await appendBlocks(args.page, md);
  console.log(`Appended ${blocks} block(s) to ${args.page}`);
}

/**
 * Append markdown to a page/block, chunking children at 100 per request (Notion
 * caps children per request). Reuses `markdownToBlocks` so literal `\n`
 * sequences (what survives a shell argument) are converted to real newlines.
 * Returns the number of blocks appended.
 */
async function appendBlocks(pageId, md) {
  const blocks = markdownToBlocks(md);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${pageId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  return blocks.length;
}

function normalizeDailyDayHeadings(md, dayKey) {
  const date = new Date(`${dayKey.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return md;
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  return String(md)
    .split(/\r?\n/)
    .map((line) => {
      const heading =
        /^(\s*#{1,3}\s+)([A-Za-z]{3,9})(\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b.*)$/.exec(line);
      if (
        heading &&
        Number(heading[4]) === day &&
        Number(heading[5]) === month &&
        (!heading[6] ||
          Number(heading[6].length === 2 ? `20${heading[6]}` : heading[6]) ===
            date.getUTCFullYear())
      ) {
        return `${heading[1]}${weekday}${heading[3]}`;
      }
      const topup = /^(\s*\*\*Top-up\s+)([A-Za-z]{3,9})(\s+(\d{1,2})\/(\d{1,2})\*\*)$/.exec(line);
      if (topup && Number(topup[4]) === day && Number(topup[5]) === month) {
        return `${topup[1]}${weekday}${topup[3]}`;
      }
      return line;
    })
    .join("\n");
}

/** Count the blocks markdownToBlocks would emit, without doing any I/O. */
function chunkCount(md) {
  return markdownToBlocks(md).length;
}

/**
 * Sum the numeric properties of every row on a given date (defaults to today),
 * e.g. `sum-day --db "Meal Log"` prints per-row names and totals for Calories
 * and Protein. Deterministic on purpose: the totals the coach reports in chat
 * come from this query, not from model arithmetic over rows.
 */
async function cmdSumDay(args, { dbId: knownDbId, schema: knownSchema, quiet = false } = {}) {
  const dbId = knownDbId ?? (await resolveDbId(args.db));
  const date = args.date ?? isoDate(new Date());
  const schema = knownSchema ?? (await notion(`/databases/${dbId}`)).properties ?? {};
  const titleProp = findProp(schema, (_n, d) => d.type === "title");
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  const numProps = Object.keys(schema).filter((k) => schema[k].type === "number");
  if (!dateProp) throw new Error(`"${args.db}" has no date property to filter by.`);
  if (!numProps.length) throw new Error(`"${args.db}" has no numeric properties to sum.`);

  const rows = await queryAllRows(dbId, {
    filter: { property: dateProp, date: { equals: date } },
  });
  if (!quiet) console.log(`Rows on ${date}: ${rows.length}`);
  for (const pg of rows) {
    const name = readProp(pg.properties?.[titleProp]);
    if (name && !quiet) console.log(`- ${name}`);
  }
  const parts = [];
  const totals = {};
  for (const prop of numProps) {
    const total = rows.reduce((sum, pg) => {
      const value = Number(readProp(pg.properties?.[prop]));
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    totals[prop] = total;
    parts.push(`${prop}=${Math.round(total)}`);
  }
  if (!quiet) console.log(parts.length ? `Totals: ${parts.join(", ")}` : "Totals: none");
  return { date, rows: rows.length, totals };
}

/**
 * Refresh a Dashboard tile: replace all of a column's children with fresh content.
 * Never edit blocks in place (their ids shift); always replace the whole tile.
 * Target the column by --column <id> or by --tile <name>, which is resolved
 * from the cached Dashboard column ids.
 */
async function cmdRefreshTile(args) {
  const dashboard = await resolveDashboard();
  if (dashboard.layout === "overview")
    throw new Error(
      "The overview is generated from saved records. Use sync-dashboard instead of editing a tile.",
    );
  if (args.column && !Object.values(dashboard.columns).includes(args.column))
    throw new Error("Column is not a verified Dashboard tile.");
  let columnId = args.column;
  if (!columnId && args.tile) {
    let cols = (await resolveDashboard()).columns ?? {};
    // An older cache may not contain the requested tile; re-capture from the
    // live page before giving up.
    if (!cols[args.tile]) cols = (await resolveDashboard(true)).columns ?? {};
    columnId = cols[args.tile];
    if (!columnId) {
      throw new Error(
        `No column found for tile "${args.tile}" on the Dashboard. Known tiles: ${TILE_ROWS.flat().join(", ")}. Run setup-workspace.mjs, or pass --column <id>.`,
      );
    }
  }
  if (!columnId) throw new Error("Pass --tile <name> or --column <id>");
  const md = args.file ? fs.readFileSync(args.file, "utf8") : (args.md ?? "");
  if (!md.trim()) throw new Error("Nothing to write: pass --md or --file");

  const written = await replaceTileContent(columnId, md, TILE_COLORS[args.tile]);
  console.log(`Refreshed tile ${args.tile ?? columnId} with ${written} block(s)`);
}

/**
 * Rebuild the data-derived Dashboard tiles (This Week, Goals, Body Stats, and
 * Nutrition) directly from the databases, so they are
 * always consistent with the data and never carry hand-written (fabricated)
 * numbers. The agent calls this once after any data change instead of
 * hand-building each tile. --now <YYYY-MM-DD> sets "this week"/"today" from the
 * chat header date (defaults to the system date).
 */
async function cmdSyncDashboard(args) {
  const dashboard = await resolveDashboard();
  if (dashboard.layout === "overview") return refreshOverview(args, dashboard);
  const cols = dashboard.columns ?? {};
  if (!cols.thisWeek && !cols.goals && !cols.bodyStats) {
    throw new Error("Dashboard has no tile columns. Run setup-workspace.mjs first.");
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now must be an ISO date, got "${args.now}"`);
  const failures = [];

  // Keep the primary card grounded in the current week's saved plan and the
  // latest actual session. On a read failure, replace it with an honest error
  // state instead of leaving a stale prior session visible.
  if (cols.nextSession) {
    let content;
    try {
      const [{ fetchWorkoutHistory, latestLoggedSession }, planTitle] = await Promise.all([
        import("./progression.mjs"),
        findCurrentWeeklyPlanTitle(now),
      ]);
      const history = await fetchWorkoutHistory({ limit: 3 });
      content = renderNextSessionTile({ session: latestLoggedSession(history), planTitle });
    } catch (err) {
      console.error(`Next Session context unavailable: ${err.message}`);
      content = renderNextSessionTile({ unavailable: true });
    }
    await replaceTileContent(cols.nextSession, content, TILE_COLORS.nextSession);
  }

  // This Week: count training days from daily rows; legacy weekly rows retain
  // their Sessions day count until the historical split is complete.
  if (cols.thisWeek) {
    const wlId = await resolveDbId("Workout Log");
    const schema = (await notion(`/databases/${wlId}`)).properties ?? {};
    const dateProp = findProp(schema, (_n, d) => d.type === "date");
    const titleProp = findProp(schema, (_n, d) => d.type === "title");
    const focusProp = findProp(schema, (n) => n.includes("focus"));
    const sessProp = findProp(schema, (n, d) => n.includes("session") && d.type === "number");
    const body = {};
    if (dateProp) {
      body.filter = {
        property: dateProp,
        date: { on_or_after: isoDate(startOfWeekSundayUTC(now)) },
      };
      body.sorts = [{ property: dateProp, direction: "descending" }];
    }
    const rows = await queryAllRows(wlId, body);
    const sessions = rows.map((pg) => ({
      date: readProp(pg.properties?.[dateProp]),
      name: readProp(pg.properties?.[titleProp]),
      focus: focusProp ? readProp(pg.properties?.[focusProp]) : "",
      days: sessProp ? Number(readProp(pg.properties?.[sessProp]) || 1) : 1,
    }));
    await replaceTileContent(cols.thisWeek, renderThisWeekTile(sessions), TILE_COLORS.thisWeek);
  }

  // Goals: active goals with current/target progress.
  if (cols.goals) {
    const gId = await resolveDbId("Goals");
    const schema = (await notion(`/databases/${gId}`)).properties ?? {};
    const titleProp = findProp(schema, (_n, d) => d.type === "title");
    const statusProp = findProp(schema, (n) => n.includes("status"));
    const curProp = findProp(schema, (n, d) => n.includes("current") && d.type === "number");
    const tgtProp = findProp(schema, (n, d) => n.includes("target") && d.type === "number");
    const rows = await queryAllRows(gId);
    const goals = rows.map((pg) => ({
      goal: readProp(pg.properties?.[titleProp]),
      status: statusProp ? readProp(pg.properties?.[statusProp]) : "",
      current: curProp ? readProp(pg.properties?.[curProp]) : "",
      target: tgtProp ? readProp(pg.properties?.[tgtProp]) : "",
    }));
    await replaceTileContent(cols.goals, renderGoalsTile(goals), TILE_COLORS.goals);
  }

  // Body Stats: the latest check-in.
  if (cols.bodyStats) {
    const bId = await resolveDbId("Body Stats");
    const schema = (await notion(`/databases/${bId}`)).properties ?? {};
    const dateProp = findProp(schema, (_n, d) => d.type === "date");
    const bwProp = findProp(schema, (n) => n.includes("bodyweight"));
    const waistProp = findProp(schema, (n) => n.includes("waist"));
    const body = { page_size: 1 };
    if (dateProp) body.sorts = [{ property: dateProp, direction: "descending" }];
    const res = await notion(`/databases/${bId}/query`, "POST", body);
    const row = res.results?.[0];
    const latest = row
      ? {
          date: readProp(row.properties?.[dateProp]),
          bodyweight: bwProp ? readProp(row.properties?.[bwProp]) : "",
          waist: waistProp ? readProp(row.properties?.[waistProp]) : "",
        }
      : null;
    await replaceTileContent(cols.bodyStats, renderBodyStatsTile(latest), TILE_COLORS.bodyStats);
  }

  // Nutrition: today's meals versus the daily targets from PERSONAL.md. A
  // workspace built before the Meal Log existed must not break the whole sync,
  // so a failure here degrades to skipping the tile (with a printed warning).
  if (cols.nutrition) {
    try {
      await cmdSyncNutrition(args, cols);
    } catch (err) {
      console.error(`Nutrition tile skipped (${err.message}). Has the Meal Log been set up?`);
      failures.push("daily nutrition");
    }
  }

  if (failures.length)
    throw new Error(
      `Dashboard refresh incomplete: ${failures.join(", ")}. Previous dated summaries may remain.`,
    );
  console.log(
    "Synced Dashboard tiles (Next Session, This Week, Goals, Body Stats, Nutrition) from Notion.",
  );
}

/**
 * Create a child page under a parent page (used to organise the knowledge base:
 * one subpage per imported training program). Optional markdown body and emoji.
 * Prints the new page id.
 */
async function cmdCreatePage(args) {
  const weeklyPlan = /^Weekly Plan - (\d{4}-\d{2}-\d{2})$/.exec(args.title ?? "");
  if (weeklyPlan) {
    return cmdWeeklyPlan({
      ...args,
      action: "save",
      week: weeklyPlan[1],
      file: args.file ?? args["body-file"],
    });
  }
  const title = String(args.title ?? "").trim();
  const weeklyPlanTitle =
    /^weekly\s+plans?\b/i.test(title) ||
    /^(?:week\s+of|plan\s+for\s+week)\s+\d/i.test(title) ||
    /\bplan\s*[-:–—]?\s*week\s*\d{1,2}\b/i.test(title);
  if (weeklyPlanTitle && !/\b(?:reference|library|benchmark|imported)\b/i.test(title)) {
    throw new Error(
      "Weekly plans belong in the persistent Weekly Plan page. Use weekly-plan --action save --week <Sunday YYYY-MM-DD> --md <plan> instead of create-page.",
    );
  }
  // --parent-name resolves a cached page key (e.g. __knowledgeBase) so callers
  // never need shell id-capture ($(), grep) to find the parent: that pattern
  // fails on Windows cmd.exe. Prefer it over --parent whenever the parent is
  // a well-known workspace page.
  if (!args.parent && args["parent-name"]) {
    const cache = readCache();
    const hit = cache[args["parent-name"]] ?? cache[`__${args["parent-name"]}`];
    if (!hit) {
      throw new Error(
        `--parent-name "${args["parent-name"]}" is not in the id cache. Run resolve-workspace first.`,
      );
    }
    args.parent = hit;
  }
  if (!args.parent) throw new Error("--parent <pageId> (or --parent-name <key>) is required");
  if (!args.title) throw new Error("--title is required");
  const body = {
    parent: { page_id: args.parent },
    properties: { title: { title: [{ text: { content: args.title } }] } },
  };
  if (args.icon) body.icon = { type: "emoji", emoji: args.icon };
  const page = await notion("/pages", "POST", body);

  const md = args.file ? fs.readFileSync(args.file, "utf8") : (args.md ?? "");
  if (md.trim()) {
    const blocks = markdownToBlocks(md);
    for (let i = 0; i < blocks.length; i += 100) {
      await notion(`/blocks/${page.id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
    }
  }
  console.log(page.id);
}

/**
 * Repopulate the whole id cache deterministically from the pinned Hub in a few
 * API calls: every child database by exact title, the Knowledge Base, the
 * Training Calendar, and the Dashboard with its tile columns. This is the
 * fresh-session bootstrap for deployments where the gitignored data/ dir starts
 * empty: it never touches the unreliable /search API and never creates anything
 * (unlike setup-workspace.mjs).
 */
async function cmdResolveWorkspace() {
  const hub = hubId();
  if (!hub) {
    throw new Error(
      'No Hub pinned. Set NOTION_PARENT_PAGE_ID or config/notion-hub.json ({"hubPageId": "..."}).',
    );
  }
  const { discoverWorkspace, selectWorkspaceDatabase, WORKSPACE_PAGES } = await import(
    "./notion-layout.mjs"
  );
  const discovery = await discoverWorkspace(
    (endpoint, method) => notion(`/${endpoint}`, method),
    hub,
  );
  const cache = readCache();
  cache.__hub = hub;
  const pageId = (title, preferred) => {
    const matches = discovery.pages.filter((page) => page.title === title);
    const pinned = matches.find((page) => normId(page.id) === normId(preferred));
    if (pinned) return pinned.id;
    if (matches.length > 1)
      throw new Error(`Several pages named ${title} exist; workspace recovery will not guess.`);
    return matches[0]?.id;
  };
  const pages = {};
  for (const page of WORKSPACE_PAGES) {
    const id = pageId(page.title, cache.__workspacePages?.[page.key]);
    if (id) pages[page.key] = id;
  }
  const resources =
    pageId("Workspace Resources", cache.__resources) ?? pageId("Resources", cache.__resources);
  if (resources) pages.resources = resources;
  cache.__workspacePages = pages;
  for (const [key, id] of Object.entries({
    __knowledgeBase: pageId("Knowledge Base", cache.__knowledgeBase),
    __trainingCalendar: pageId("Training Calendar", cache.__trainingCalendar),
    __exerciseLibrary: pageId("Exercise Library", cache.__exerciseLibrary),
    __weeklyPlan: pages.weeklyPlan,
    __foodKnowledge: pages.foodKnowledge,
    __resources: pages.resources,
    __mealLogPage: pages.meals,
  })) {
    if (id) cache[key] = id;
    else delete cache[key];
  }
  const dbs = [];
  for (const title of [
    "Programs",
    "Goals",
    "Body Stats",
    "Workout Log",
    "Meal Log",
    "Food Library",
  ]) {
    const id = selectWorkspaceDatabase(discovery, title, cache, hub);
    if (id) {
      cache[title] = id;
      dbs.push(title);
    } else delete cache[title];
  }
  Reflect.deleteProperty(cache, "__nutritionSummary");
  if (pages.meals) {
    const summary = (await listChildren(pages.meals)).find(
      (block) => block.type === "callout" && weeklyPlanText(block) === "Daily nutrition",
    );
    if (summary) cache.__nutritionSummary = { pageId: pages.meals, blockId: summary.id };
  }
  writeCache(cache);
  let dashboard = "not found";
  try {
    dashboard = (await resolveDashboard(true)).pageId;
  } catch {
    /* no Dashboard page yet; setup-workspace.mjs builds it */
  }
  console.log(`Hub: ${hub}`);
  console.log(`Databases: ${dbs.join(", ") || "none"}`);
  console.log(`Knowledge Base: ${cache.__knowledgeBase ?? "not found"}`);
  console.log(`Exercise Library: ${cache.__exerciseLibrary ?? "not found"}`);
  console.log(`Training Calendar: ${cache.__trainingCalendar ?? "not found"}`);
  console.log(`Dashboard: ${dashboard}`);
  console.log("Ids cached to data/notion-ids.json");
}

const COMMANDS = {
  "resolve-db": cmdResolveDb,
  "resolve-workspace": cmdResolveWorkspace,
  "query-recent": cmdQueryRecent,
  log: cmdLog,
  "log-meal": cmdLogMeal,
  "find-row": cmdFindRow,
  "read-blocks": cmdReadBlocks,
  archive: cmdArchive,
  update: cmdUpdate,
  append: cmdAppend,
  "refresh-tile": cmdRefreshTile,
  "sync-dashboard": cmdSyncDashboard,
  "sync-nutrition": cmdSyncNutrition,
  "sum-day": cmdSumDay,
  "create-page": cmdCreatePage,
  lookup: cmdLookup,
  "exercise-inventory": cmdExerciseInventory,
  "exercise-library": cmdExerciseLibrary,
  "weekly-plan": cmdWeeklyPlan,
};

async function main() {
  if (!TOKEN) {
    console.error("NOTION_TOKEN is not set. Notion is not configured.");
    process.exitCode = 1;
    return;
  }
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command "${command}". Use one of: ${Object.keys(COMMANDS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  await fn(parseArgs(rest));
}

// Run only when invoked directly (node scripts/notion.mjs ...), so the pure
// helpers above can be imported by the test suite without executing a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export {
  parseInline,
  markdownToBlocks,
  blocksToMarkdown,
  richTextToMd,
  buildPropertyValue,
  validateValue,
  optionNames,
  parseValueOp,
  readProp,
  startOfWeekUTC,
  startOfWeekSundayUTC,
  isoDate,
  findProp,
  resolveDbId,
  notion,
  buildTextFilter,
  buildLookupQuery,
  renderThisWeekTile,
  renderNextSessionTile,
  renderGoalsTile,
  renderBodyStatsTile,
  parseTargetsFromMarkdown,
  renderNutritionTile,
  cmdWeeklyPlan,
  cmdCreatePage,
  cmdLogMeal,
  findCurrentWeeklyPlanTitle,
  weeklyPlanEntryWeek,
  cmdSyncNutrition,
  cmdSyncDashboard,
  cmdRefreshTile,
  dashboardModel,
  pageIsWithinHub,
  workspaceDatabases,
  cmdResolveWorkspace,
};
