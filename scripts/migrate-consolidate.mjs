#!/usr/bin/env node
/**
 * One-off migration: consolidate Notion log rows so each calendar date has
 * exactly one row (matching the v2.5.0 one-row-per-day semantics).
 *
 * Usage:
 *   node scripts/migrate-consolidate.mjs --dry-run        # preview only
 *   node scripts/migrate-consolidate.mjs                   # execute
 *   node scripts/migrate-consolidate.mjs --db "Meal Log"   # only one DB
 */
import {
  blocksToMarkdown,
  buildPropertyValue,
  findProp,
  notion,
  readProp,
  resolveDbId,
} from "./notion.mjs";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Query ALL rows from a database (handles pagination). */
async function queryAllRows(dbId) {
  const rows = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await notion(`/databases/${dbId}/query`, "POST", {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/** Read all body blocks of a page as markdown. */
async function getPageMarkdown(pageId) {
  return blocksToMarkdown(pageId);
}

/** Append markdown content to a page. */
async function appendMarkdown(pageId, md) {
  if (!md.trim()) return;
  // Use the same inline import to call notion directly
  const { markdownToBlocks } = await import("./notion.mjs");
  const blocks = markdownToBlocks(md);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${pageId}/children`, "PATCH", {
      children: blocks.slice(i, i + 100),
    });
  }
}

/** Soft-delete a page. */
async function archivePage(pageId) {
  await notion(`/pages/${pageId}`, "PATCH", { archived: true, in_trash: true });
}

/** Get the date string from a row's date property. */
function getRowDate(row, dateProp) {
  const raw = row.properties?.[dateProp]?.date;
  if (!raw?.start) return null;
  return raw.start.slice(0, 10); // YYYY-MM-DD
}

/** Get numeric value from a property. */
function numVal(row, prop) {
  const v = Number(readProp(row.properties?.[prop]));
  return Number.isFinite(v) ? v : 0;
}

/** Get a multi-select value as an array. */
function multiSelect(row, prop) {
  const raw = row.properties?.[prop];
  if (!raw?.multi_select) return [];
  return raw.multi_select.map((o) => o.name);
}

/** Set a multi-select property value. */
function setMultiSelect(names) {
  return { multi_select: names.map((n) => ({ name: n })) };
}

// ─── consolidation logic ─────────────────────────────────────────────────────

/**
 * Merge a group of rows sharing the same date into one primary row.
 * Returns { primary, archived, mergedBody } for reporting.
 */
async function consolidateRows(rows, schema, dryRun) {
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  const titleProp = findProp(schema, (_n, d) => d.type === "title");
  const numProps = Object.keys(schema).filter((k) => schema[k].type === "number");
  const multiProps = Object.keys(schema).filter((k) => schema[k].type === "multi_select");

  if (rows.length <= 1) return null;

  // Sort by date (earliest first), then by creation time (oldest first)
  rows.sort((a, b) => {
    const da = getRowDate(a, dateProp) ?? "9999";
    const db = getRowDate(b, dateProp) ?? "9999";
    if (da !== db) return da.localeCompare(db);
    return (a.created_time ?? "").localeCompare(b.created_time ?? "");
  });

  const primary = rows[0];
  const duplicates = rows.slice(1);
  const primaryDate = getRowDate(primary, dateProp);
  const primaryTitle = readProp(primary.properties?.[titleProp]);

  const merged = {
    date: primaryDate,
    primaryId: primary.id,
    primaryTitle,
    duplicates: [],
    mergedNumbers: {},
    numericOperations: {},
    mergedMultiSelect: {},
  };

  // Collect all body content from duplicates
  const extraBodies = [];
  for (const dup of duplicates) {
    const dupTitle = readProp(dup.properties?.[titleProp]);
    const dupBody = await getPageMarkdown(dup.id);
    extraBodies.push({ title: dupTitle, body: dupBody, id: dup.id });

    merged.duplicates.push({
      id: dup.id,
      title: dupTitle,
      body: dupBody.slice(0, 200),
    });
  }

  // Use field semantics instead of summing every numeric field. Unknown numeric
  // properties keep the primary value until a domain-specific rule is defined.
  for (const prop of numProps) {
    const normalized = prop.toLowerCase();
    const values = rows.map((row) => numVal(row, prop)).filter(Number.isFinite);
    let operation = "preserve-primary";
    let value = numVal(primary, prop);
    if (/top\s*set/.test(normalized)) {
      operation = "max";
      value = Math.max(...values, 0);
    } else if (/\brpe\b|effort/.test(normalized)) {
      operation = "average";
      value = values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
    } else if (/volume|duration|calor|protein|carb|fat|session/.test(normalized)) {
      operation = "sum";
      value = values.reduce((sum, n) => sum + n, 0);
    }
    merged.numericOperations[prop] = operation;
    merged.mergedNumbers[prop] =
      operation === "average" ? Math.round(value * 10) / 10 : Math.round(value);
  }

  // Merge multi-select properties (union)
  for (const prop of multiProps) {
    const allNames = new Set();
    for (const r of rows) {
      for (const n of multiSelect(r, prop)) allNames.add(n);
    }
    merged.mergedMultiSelect[prop] = [...allNames];
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would merge ${duplicates.length} duplicate(s) into ${primary.id}`);
    console.log(`    Primary: "${primaryTitle}" (${primaryDate})`);
    for (const d of merged.duplicates) {
      console.log(`    Archive: "${d.title}" (${d.id})`);
    }
    console.log(`    Numeric rules: ${JSON.stringify(merged.numericOperations)}`);
    console.log(`    Numeric rules: ${JSON.stringify(merged.numericOperations)}`);
    console.log(`    Numbers: ${JSON.stringify(merged.mergedNumbers)}`);
    return merged;
  }

  // Build update pairs for numeric properties
  const updatePairs = [];
  for (const prop of numProps) {
    const total = merged.mergedNumbers[prop];
    if (total > 0) updatePairs.push(`${prop}=${total}`);
  }

  // Update primary row properties
  if (updatePairs.length) {
    const properties = {};
    for (const pair of updatePairs) {
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1);
      const def = schema[name];
      if (def) properties[name] = buildPropertyValue(def.type, value);
    }
    if (Object.keys(properties).length) {
      await notion(`/pages/${primary.id}`, "PATCH", { properties });
    }
  }

  // Update multi-select properties (union)
  for (const prop of multiProps) {
    const names = merged.mergedMultiSelect[prop];
    if (names.length) {
      const def = schema[prop];
      if (def?.type === "multi_select") {
        await notion(`/pages/${primary.id}`, "PATCH", {
          properties: { [prop]: setMultiSelect(names) },
        });
      }
    }
  }

  // Append body content from duplicates
  const combinedExtra = extraBodies
    .filter((e) => e.body.trim())
    .map((e) => `---\n**From: ${e.title}**\n${e.body}`)
    .join("\n\n");
  if (combinedExtra.trim()) {
    await appendMarkdown(primary.id, combinedExtra);
  }

  // Archive duplicates
  for (const dup of duplicates) {
    await archivePage(dup.id);
    console.log(`  Archived ${dup.id} ("${readProp(dup.properties?.[titleProp])}")`);
  }

  console.log(`  Merged ${duplicates.length} duplicate(s) into ${primary.id} ("${primaryTitle}")`);
  return merged;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dbFilter = args.includes("--db") ? args[args.indexOf("--db") + 1] : null;

  if (dryRun) console.log("=== DRY RUN (no changes will be made) ===\n");

  const databases = [];
  if (!dbFilter || dbFilter === "Workout Log") databases.push("Workout Log");
  if (!dbFilter || dbFilter === "Meal Log") databases.push("Meal Log");

  for (const dbName of databases) {
    console.log(`\n--- ${dbName} ---`);
    const dbId = await resolveDbId(dbName);
    const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
    const dateProp = findProp(schema, (_n, d) => d.type === "date");

    if (!dateProp) {
      console.log(`  No date property found in ${dbName}, skipping.`);
      continue;
    }

    const rows = await queryAllRows(dbId);
    console.log(`  Total rows: ${rows.length}`);

    // Group by date
    const groups = new Map();
    for (const row of rows) {
      const date = getRowDate(row, dateProp);
      if (!date) continue;
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(row);
    }

    // Find dates with duplicates
    const dupDates = [...groups.entries()].filter(([, r]) => r.length > 1);
    console.log(`  Dates with duplicates: ${dupDates.length}`);

    if (!dupDates.length) {
      console.log("  Nothing to consolidate.");
      continue;
    }

    let mergedCount = 0;
    for (const [date, dateRows] of dupDates) {
      console.log(`\n  ${date} (${dateRows.length} rows):`);
      const result = await consolidateRows(dateRows, schema, dryRun);
      if (result) mergedCount++;
    }

    console.log(`\n  ${dryRun ? "Would merge" : "Merged"}: ${mergedCount} date(s)`);
  }

  console.log(dryRun ? "\n=== DRY RUN complete ===" : "\n=== Migration complete ===");
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exitCode = 1;
});
