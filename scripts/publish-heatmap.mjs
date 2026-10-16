#!/usr/bin/env node
/**
 * publish-heatmap.mjs: render the workout calendar heatmap from Workout Log
 * rows and write it to the "Training Calendar" page in the workspace (created
 * under Workout Log when available), plus a compact 12-week Dashboard section
 * so the homepage shows training at a glance. Run after a session is logged
 * so the calendar stays current, e.g.:
 *
 *   node scripts/publish-heatmap.mjs [--weeks 26] [--now 2026-08-28]
 *
 * Uses the pure renderer in progression.mjs; this script only does Notion I/O.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverWorkspace } from "./notion-layout.mjs";
import {
  blocksToMarkdown,
  findProp,
  isoDate,
  markdownToBlocks,
  notion,
  pageIsWithinHub,
  readProp,
  resolveDbId,
  startOfWeekUTC,
} from "./notion.mjs";
import { renderHeatmapGrid } from "./progression.mjs";

const CACHE_FILE = path.resolve(process.cwd(), "data", "notion-ids.json");

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeCache(c) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

const normId = (id) => (id ?? "").replace(/-/g, "").toLowerCase();

async function listChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await notion(`/blocks/${blockId}/children${qs}`);
    out.push(...(res.results ?? []));
    if (res.has_more && !res.next_cursor)
      throw new Error("Heatmap page discovery is incomplete: next_cursor is missing.");
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** An explicit Hub pin takes precedence over cached workspace ids. */
function hubId() {
  const cache = readCache();
  let pinned;
  try {
    pinned = JSON.parse(fs.readFileSync("config/notion-hub.json", "utf8")).hubPageId;
  } catch {
    /* no pin file; env or cache must carry it */
  }
  return normId(process.env.NOTION_PARENT_PAGE_ID ?? cache.__hub ?? pinned ?? "");
}

/** Recover a nested calendar before creating one; cached pages must remain in this Hub. */
export async function trainingCalendarPage() {
  const cache = readCache();
  const hub = hubId();
  if (!hub) throw new Error("No Hub pinned. Set NOTION_PARENT_PAGE_ID or config/notion-hub.json.");
  if (cache.__trainingCalendar) {
    try {
      if (await pageIsWithinHub(cache.__trainingCalendar, hub)) return cache.__trainingCalendar;
    } catch {
      /* stale; re-resolve below */
    }
  }
  const { pages } = await discoverWorkspace(
    (pathname, ...args) => notion(`/${pathname}`, ...args),
    hub,
  );
  const workouts = pages.filter(
    (page) => page.title === "Workout Log" && normId(page.parentId) === hub,
  );
  if (workouts.length > 1)
    throw new Error("Several Workout Log pages exist; refusing to guess the calendar location.");
  const workoutPage =
    workouts[0] ??
    pages.find(
      (page) =>
        page.title === "Workout Log" &&
        normId(page.id) === normId(cache.__workspacePages?.workouts),
    );
  const calendars = pages.filter((page) => page.title === "Training Calendar");
  const nested = workoutPage
    ? calendars.filter((page) => normId(page.parentId) === normId(workoutPage.id))
    : [];
  const candidates = nested.length ? nested : calendars;
  if (candidates.length > 1)
    throw new Error("Several Training Calendar pages exist; refusing to guess which to replace.");
  const existing = candidates[0];
  if (existing) {
    cache.__trainingCalendar = existing.id;
    writeCache(cache);
    return existing.id;
  }
  const page = await notion("/pages", "POST", {
    parent: { type: "page_id", page_id: workoutPage?.id ?? hub },
    icon: { type: "emoji", emoji: "🗓️" },
    properties: { title: { title: [{ type: "text", text: { content: "Training Calendar" } }] } },
  });
  cache.__trainingCalendar = page.id;
  writeCache(cache);
  console.log(`+ created Training Calendar page (${page.id})`);
  return page.id;
}

/** Replace the page body: append the new blocks, then delete the old ones. */
async function replacePageBody(pageId, md) {
  const existing = await listChildren(pageId);
  const oldIds = existing.map((b) => b.id);
  const blocks = markdownToBlocks(md);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${pageId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  for (const id of oldIds) await notion(`/blocks/${id}`, "DELETE");
  return blocks.length;
}

const SECTION_TITLE = "Training Calendar";

/**
 * Training dates inside one weekly row body: every `## <Day> <d>/<m>` day
 * section counts (a repeated heading = a second session that day, which burns
 * hotter). The year follows the row's week-start Sunday, with a new-year
 * correction when the week straddles January. Pure, unit-tested.
 */
export function extractSessionDates(md, weekStartKey) {
  const [wy, wm] = weekStartKey.split("-").map(Number);
  const dates = [];
  for (const raw of String(md ?? "").split(/\r?\n/)) {
    const h = /^#{1,3}\s+[A-Za-z]{3,9}\s+(\d{1,2})\/(\d{1,2})\b/.exec(raw.trim());
    if (!h) continue;
    const d = Number(h[1]);
    const m = Number(h[2]);
    if (d < 1 || d > 31 || m < 1 || m > 12) continue;
    let y = wy;
    if (m === 1 && wm === 12) y += 1;
    if (m === 12 && wm === 1) y -= 1;
    dates.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return dates;
}

/** Index of our Dashboard section heading, or -1. Pure, unit-tested. */
export function findSectionIndex(children, title = SECTION_TITLE) {
  return children.findIndex(
    (b) =>
      b.type === "heading_2" &&
      (b.heading_2?.rich_text ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("") ===
        title,
  );
}

/** Dashboard page id, validating cached ancestry before mirroring private data. */
export async function dashboardPage() {
  const cache = readCache();
  const hub = hubId();
  if (!hub) return null;
  const cached = cache.__dashboard?.pageId ?? cache.__dashboard;
  if (typeof cached === "string" && cached) {
    try {
      if (await pageIsWithinHub(cached, hub)) return cached;
    } catch {
      /* stale; re-resolve below */
    }
  }
  const found = (await listChildren(hub)).find(
    (b) => b.type === "child_page" && b.child_page?.title === "Dashboard",
  );
  return found?.id ?? null;
}

/**
 * Mirror a compact heatmap onto the Dashboard as its own section (heading +
 * grid), so the homepage shows training without opening the full page. The
 * section is deleted and re-appended at the end each run: tile columns are
 * never touched (only heading_2/divider/column_list boundaries stop the
 * delete sweep, and our content is paragraphs and a table).
 */
async function syncDashboardSection(gridMd) {
  const dashId = await dashboardPage();
  if (!dashId) {
    console.log("Dashboard page not found; calendar page still updated.");
    return 0;
  }
  const kids = await listChildren(dashId);
  const idx = findSectionIndex(kids);
  if (idx !== -1) {
    let end = idx + 1;
    while (end < kids.length && !["heading_2", "divider", "column_list"].includes(kids[end].type)) {
      end++;
    }
    for (const b of kids.slice(idx, end)) await notion(`/blocks/${b.id}`, "DELETE");
  }
  const blocks = markdownToBlocks(`## ${SECTION_TITLE}\n${gridMd}`);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${dashId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  console.log(`Dashboard section synced (${blocks.length} block(s)).`);
  return blocks.length;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (flag, def) => {
    const i = argv.indexOf(`--${flag}`);
    return i !== -1 ? argv[i + 1] : def;
  };
  const weeks = Number(arg("weeks", "26")) || 26;
  const now = arg("now") ? new Date(arg("now")) : new Date();

  const dbId = await resolveDbId("Workout Log");
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  if (!dateProp) throw new Error("Workout Log has no Date property to build the heatmap from.");

  const monday = startOfWeekUTC(now);
  const since = new Date(monday);
  since.setUTCDate(since.getUTCDate() - 7 * (weeks - 1));

  const body = { page_size: 100, sorts: [{ property: dateProp, direction: "descending" }] };
  body.filter = { property: dateProp, date: { on_or_after: isoDate(since) } };
  const res = await notion(`/databases/${dbId}/query`, "POST", body);
  // Expand legacy weekly section headings; current daily rows use their Date.
  const dates = [];
  for (const pg of res.results ?? []) {
    const rowDate = readProp(pg.properties?.[dateProp]);
    if (!rowDate) continue;
    let md = "";
    try {
      md = await blocksToMarkdown(pg.id);
    } catch (err) {
      console.error(`Could not read body of row ${rowDate}: ${err.message}`);
    }
    const expanded = extractSessionDates(md, rowDate);
    if (expanded.length) dates.push(...expanded);
    else dates.push(rowDate);
  }

  const md = renderHeatmapGrid(dates, { weeks, today: now });
  const pageId = await trainingCalendarPage();
  const written = await replacePageBody(pageId, md);
  console.log(`Heatmap: ${dates.length} session day(s), ${written} block(s) -> ${pageId}`);
  try {
    const compact = renderHeatmapGrid(dates, { weeks: Math.min(12, weeks), today: now });
    await syncDashboardSection(compact);
  } catch (err) {
    // The Dashboard mirror must never fail the calendar write that already
    // succeeded above; the next session publish retries it.
    console.warn(`Dashboard section skipped: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
