#!/usr/bin/env node
/**
 * cleanup-workspace.mjs: audit the training workspace under the Hub and tidy
 * it up. Read-only by default; pass --apply to actually archive and polish.
 *
 *   node scripts/cleanup-workspace.mjs [--dry-run] [--apply] [--hub <pageId>]
 *
 * Reports:
 *   - child pages with no content blocks (empty), except the protected
 *     workspace pages (never archived, even when empty);
 *   - direct Hub child databases with no rows (listed only, never archived: an empty
 *     Food Library on day one is expected, not junk);
 *   - calendar dates holding more than one row in Workout Log / Meal Log
 *     (one-row-per-day violations: merge with migrate-consolidate.mjs, which
 *     owns the merge and is only suggested, never run from here).
 *
 * With --apply it also archives the empty unprotected pages and stamps the
 * legacy workspace pages with their canonical emoji icons. Archiving in Notion
 * is a soft delete (restorable from Trash for 30 days).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { notion } from "./notion.mjs";

const TOKEN = process.env.NOTION_TOKEN;

function opt(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function pinnedHub() {
  try {
    return JSON.parse(fs.readFileSync("config/notion-hub.json", "utf8")).hubPageId;
  } catch {
    return undefined;
  }
}
const HUB = (opt("hub") ?? process.env.NOTION_PARENT_PAGE_ID ?? pinnedHub() ?? "").replace(
  /-/g,
  "",
);
const APPLY = process.argv.includes("--apply");

const PROTECTED_PAGES = new Set([
  "dashboard",
  "workout log",
  "meal log",
  "weekly plan",
  "food & knowledge",
  "resources",
  "workspace resources",
  "knowledge base",
  "training calendar",
]);
const PAGE_ICONS = { Dashboard: "🏠", "Knowledge Base": "📚", "Training Calendar": "🗓️" };

async function listChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await notion(`/blocks/${blockId}/children${qs}`, "GET");
    out.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function main() {
  if (!TOKEN) throw new Error("NOTION_TOKEN is not set.");
  if (!HUB) throw new Error("No Hub pinned. Set NOTION_PARENT_PAGE_ID or config/notion-hub.json.");
  console.log(
    APPLY
      ? "Cleanup: APPLY mode (archiving + icons)."
      : "Cleanup: dry run (report only, --apply to act).",
  );

  const kids = await listChildren(HUB);
  const pages = kids.filter((b) => b.type === "child_page");
  const dbs = kids.filter((b) => b.type === "child_database");
  console.log(
    "Database audit covers direct Hub databases only; sources nested in Resources or other pages are not checked.",
  );

  // 1. Empty pages (archived only with --apply, never when protected).
  for (const p of pages) {
    const title = p.child_page?.title ?? "(untitled)";
    const blocks = await listChildren(p.id);
    if (blocks.length > 0) {
      console.log(`= page "${title}" has ${blocks.length} block(s), kept.`);
      continue;
    }
    if (PROTECTED_PAGES.has(title.toLowerCase())) {
      console.log(`= page "${title}" is empty but protected, kept.`);
      continue;
    }
    if (APPLY) {
      await notion(`/pages/${p.id}`, "PATCH", { archived: true });
      console.log(`x archived empty page "${title}".`);
    } else {
      console.log(`! page "${title}" is empty, would archive with --apply.`);
    }
  }

  // 2. Empty databases (listed only, never archived).
  for (const d of dbs) {
    const title = d.child_database?.title ?? "(untitled)";
    const res = await notion(`/databases/${d.id}/query`, "POST", { page_size: 1 });
    const empty = (res.results ?? []).length === 0;
    console.log(
      empty
        ? `! database "${title}" has no rows (listed only, never archived).`
        : `= database "${title}" has rows, kept.`,
    );
  }

  // 3. Duplicate same-day rows (reported; migrate-consolidate.mjs merges).
  for (const name of ["Workout Log", "Meal Log"]) {
    const db = dbs.find(
      (b) => (b.child_database?.title ?? "").toLowerCase() === name.toLowerCase(),
    );
    if (!db) continue;
    const schema = (await notion(`/databases/${db.id}`, "GET")).properties ?? {};
    const dateProp = Object.keys(schema).find((k) => schema[k].type === "date");
    if (!dateProp) continue;
    const rows = [];
    let cursor;
    do {
      const qs = cursor ? { start_cursor: cursor } : {};
      const res = await notion(`/databases/${db.id}/query`, "POST", { page_size: 100, ...qs });
      rows.push(...(res.results ?? []));
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    const byDate = new Map();
    for (const r of rows) {
      const day = r.properties?.[dateProp]?.date?.start;
      if (!day) continue;
      byDate.set(day, (byDate.get(day) ?? 0) + 1);
    }
    const dups = [...byDate.entries()].filter(([, n]) => n > 1);
    if (dups.length === 0) {
      console.log(`= "${name}": one row per day, clean.`);
    } else {
      console.log(
        `! "${name}" has ${dups.length} date(s) with duplicate rows (${dups.map(([d]) => d).join(", ")}). Merge with: node scripts/migrate-consolidate.mjs --dry-run --db "${name}"`,
      );
    }
  }

  // 4. Canonical page icons (cosmetic, idempotent).
  for (const [title, emoji] of Object.entries(PAGE_ICONS)) {
    const page = pages.find((b) => b.child_page?.title === title);
    if (!page) continue;
    if (APPLY) {
      await notion(`/pages/${page.id}`, "PATCH", { icon: { type: "emoji", emoji } });
      console.log(`~ page "${title}" icon set to ${emoji}.`);
    } else {
      console.log(`= page "${title}" icon would be set to ${emoji} with --apply.`);
    }
  }
  console.log("Cleanup done.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`cleanup-workspace failed: ${err.message}`);
    process.exitCode = 1;
  });
}
