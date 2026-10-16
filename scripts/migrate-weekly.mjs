#!/usr/bin/env node
import { pathToFileURL } from "node:url";
/**
 * migrate-weekly.mjs: fold pre-v3.0.0 daily Workout Log rows into one row per
 * Sun-Sat week. Each old row becomes a `## <Day> <d>/<m> - <Session>` section
 * (exercises demoted to `###`), properties summed (Volume/Duration),
 * max-kept (Top Set), unioned (Focus), counted (Sessions = days). Old rows
 * are archived (soft delete, restorable); the merge is previewed first.
 *
 *   node scripts/migrate-weekly.mjs [--dry-run] [--apply]
 *
 * Rows already weekly (Date = Sunday with day sections) are left alone.
 * Idempotent: re-running finds nothing to fold.
 */
import { blocksToMarkdown, markdownToBlocks, notion, readProp, resolveDbId } from "./notion.mjs";

const APPLY = process.argv.includes("--apply");

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sundayOf(dayKey) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
function weekTitle(sunday) {
  const end = new Date(`${sunday}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const e = end.toISOString().slice(0, 10);
  const d = (k) => `${Number(k.slice(8))}/${Number(k.slice(5, 7))}`;
  return `Week of ${d(sunday)} - ${d(e)}/${e.slice(0, 4)}`;
}
function dayLabel(dayKey) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${Number(dayKey.slice(8))}/${Number(dayKey.slice(5, 7))}`;
}

async function main() {
  console.log(APPLY ? "Migrate weekly: APPLY mode." : "=== DRY RUN (no changes will be made) ===");
  const dbId = await resolveDbId("Workout Log");

  // notion.mjs notion(pathname, method, body): query needs POST.
  const rows = [];
  {
    let cursor;
    do {
      const res = await notion(
        `/databases/${dbId}/query`,
        "POST",
        cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 },
      );
      rows.push(...(res.results ?? []));
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }
  console.log(`Total rows: ${rows.length}`);

  // Skip rows that are already weekly: Date is a Sunday AND the body opens
  // with a day section.
  const daily = [];
  for (const pg of rows) {
    const date = pg.properties?.Date?.date?.start?.slice(0, 10);
    if (!date) continue;
    let md = "";
    try {
      md = await blocksToMarkdown(pg.id);
    } catch {
      md = "";
    }
    const isWeekly =
      new Date(`${date}T12:00:00Z`).getUTCDay() === 0 &&
      /^#{1,3}\s+[A-Za-z]{3,9}\s+\d{1,2}\/\d{1,2}\b/m.test(md);
    if (isWeekly) {
      console.log(`= weekly already: ${readProp(pg.properties?.Session)} (${date}), skipped.`);
      continue;
    }
    daily.push({ pg, date, md });
  }
  if (!daily.length) {
    console.log("Nothing to fold.");
    return;
  }

  // Group by week-start Sunday.
  const weeks = new Map();
  for (const r of daily) {
    const s = sundayOf(r.date);
    if (!weeks.has(s)) weeks.set(s, []);
    weeks.get(s).push(r);
  }

  for (const [sunday, group] of [...weeks.entries()].sort()) {
    group.sort((a, b) => (a.date < b.date ? -1 : 1));
    const title = weekTitle(sunday);
    let volume = 0;
    let duration = 0;
    let topSet = 0;
    const focus = [];
    let program = null;
    const sections = [];
    for (const r of group) {
      const p = r.pg.properties ?? {};
      volume += p["Volume (kg)"]?.number ?? 0;
      duration += p["Duration (min)"]?.number ?? 0;
      if ((p["Top Set"]?.number ?? 0) > topSet) topSet = p["Top Set"].number;
      for (const o of p.Focus?.multi_select ?? []) {
        if (!focus.includes(o.name)) focus.push(o.name);
      }
      if (!program && (p.Program?.relation ?? []).length) program = p.Program.relation;
      const sessName = (p.Session?.title ?? []).map((t) => t.plain_text).join("") || "Session";
      const body = r.md.trim();
      // Demote exercise headings so they nest under the new day section.
      const demoted = body
        .split("\n")
        .map((line) => {
          const h = /^(#{1,3})\s+(.+)$/.exec(line.trim());
          if (!h) return line;
          if (/^[A-Za-z]{3,9}\s+\d{1,2}\/\d{1,2}\b/.test(h[2].trim())) return line;
          return `${h[1]}# ${h[2]}`;
        })
        .join("\n")
        .trim();
      sections.push(
        `## ${dayLabel(r.date)} - ${sessName}\n${demoted || "- (no breakdown logged)"}`,
      );
    }
    console.log(`\n${title} (${sunday}): folding ${group.length} row(s), ${volume} kg total.`);
    if (!APPLY) {
      console.log(`[DRY RUN] Would create "${title}" with Sessions=${group.length}.`);
      continue;
    }
    const props = {
      parent: { database_id: dbId },
      properties: {
        Session: { title: [{ text: { content: title } }] },
        Date: { date: { start: sunday } },
        Focus: { multi_select: focus.map((name) => ({ name })) },
        Status: { select: { name: "Completed" } },
        "Top Set": { number: topSet },
        "Volume (kg)": { number: volume },
        "Duration (min)": { number: duration },
        Sessions: { number: group.length },
      },
    };
    if (program) props.properties.Program = { relation: program };
    const created = await notion("/pages", "POST", props);
    const blocks = markdownToBlocks(sections.join("\n"));
    for (let i = 0; i < blocks.length; i += 100) {
      await notion(`/blocks/${created.id}/children`, "PATCH", {
        children: blocks.slice(i, i + 100),
      });
    }
    for (const r of group) {
      await notion(`/pages/${r.pg.id}`, "PATCH", { archived: true, in_trash: true });
    }
    console.log(`+ created "${title}" (${created.id}), archived ${group.length} daily row(s).`);
  }
  console.log(APPLY ? "\nMigration complete." : "\n=== DRY RUN complete ===");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`migrate-weekly failed: ${err.message}`);
    process.exitCode = 1;
  });
}
