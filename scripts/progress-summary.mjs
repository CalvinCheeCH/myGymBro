#!/usr/bin/env node
/** Read-only, chart-free workout facts for the latest 28 days and the preceding 28. */
import { pathToFileURL } from "node:url";
import { blocksToMarkdown, findProp, notion, readProp, resolveDbId } from "./notion.mjs";
import { parseLifts } from "./progression.mjs";
import { addDaysKL, dayKeyKL, parseWeekBody } from "./report-card.mjs";

const ROW_LIMIT = 60;

function validDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(new Date(`${value}T12:00:00Z`).getTime()) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}

function reportDate(value = dayKeyKL(new Date().toISOString())) {
  if (!validDate(value)) throw new Error("--date must be a valid YYYY-MM-DD calendar date.");
  return value;
}

function calendarDate(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validDate(value) ? value : null;
  try {
    const key = dayKeyKL(value);
    return validDate(key) ? key : null;
  } catch {
    return null;
  }
}

function sectionDate(section, row) {
  if (!section.header && (row.weekly || (row.endDate && row.endDate !== row.date))) return null;
  const explicit = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(section.header ?? "");
  const key = explicit
    ? `${explicit[3].length === 2 ? `20${explicit[3]}` : explicit[3]}-${explicit[2].padStart(2, "0")}-${explicit[1].padStart(2, "0")}`
    : section.key;
  return validDate(key) ? key : null;
}

function period(start, end) {
  return { start, end, trainingDays: 0, loggedSets: 0, exercises: [] };
}

/** Rows contain date/endDate calendar keys and the fully read Markdown body, never plans. */
export function buildProgressSummary(rows, { date, partial = false } = {}) {
  const today = reportDate(date);
  const window = period(addDaysKL(today, -27), today);
  const comparison = period(addDaysKL(today, -55), addDaysKL(today, -28));
  const buckets = [window, comparison].map((value) => ({
    value,
    days: new Set(),
    exercises: new Map(),
  }));
  const warnings = new Set();
  if (partial)
    warnings.add(
      "Only the latest 60 matching Workout Log rows were read; totals may be incomplete.",
    );
  for (const row of rows) {
    if (typeof row.body !== "string") throw new Error("Workout details were not completely read.");
    if (!validDate(row.date)) {
      warnings.add("Undated workout records were excluded.");
      continue;
    }
    // Top-ups belong to their named day even when the preceding section was another day.
    const body = row.body.replace(
      /^\*\*Top-up\s+([A-Za-z]{3,9}\s+\d{1,2}\/\d{1,2})\*\*\s*$/gm,
      "## $1",
    );
    const sections = parseWeekBody(body, row.date);
    const dates = new Map(sections.map((section) => [section.header, sectionDate(section, row)]));
    let recognized = false;
    for (const lift of parseLifts(body)) {
      const key = dates.get(lift.day) ?? null;
      if (!key) {
        warnings.add("Workout sets without a reliable session date were excluded.");
        continue;
      }
      const bucket = buckets.find(({ value }) => key >= value.start && key <= value.end);
      if (!bucket) continue;
      if (
        !Number.isInteger(lift.sets) ||
        lift.sets <= 0 ||
        !Number.isInteger(lift.reps) ||
        lift.reps <= 0
      ) {
        warnings.add("Unrecognized set counts or repetitions were excluded.");
        continue;
      }
      recognized = true;
      bucket.days.add(key);
      bucket.value.loggedSets += lift.sets;
      let exercise = bucket.exercises.get(lift.name);
      if (!exercise) {
        exercise = { name: lift.name, loggedSets: 0, bestSet: null };
        bucket.exercises.set(lift.name, exercise);
      }
      exercise.loggedSets += lift.sets;
      if (
        Number.isFinite(lift.load) &&
        lift.load > 0 &&
        (!exercise.bestSet ||
          lift.load > exercise.bestSet.loadKg ||
          (lift.load === exercise.bestSet.loadKg && lift.reps > exercise.bestSet.reps))
      ) {
        exercise.bestSet = { loadKg: lift.load, reps: lift.reps, date: key };
      }
    }
    // A recorded duration can establish an activity day even without weighted sets.
    for (const section of sections) {
      const key = sectionDate(section, row);
      const bucket = key && buckets.find(({ value }) => key >= value.start && key <= value.end);
      if (bucket && Number.isFinite(section.durationMin) && section.durationMin > 0) {
        recognized = true;
        bucket.days.add(key);
      }
    }
    if (!recognized && body.trim() && row.date >= comparison.start && row.date <= today) {
      warnings.add(
        "Some workout text had no recognizable dated sets or duration; training days and set totals may be incomplete.",
      );
    }
  }
  for (const bucket of buckets) {
    bucket.value.trainingDays = bucket.days.size;
    bucket.value.exercises = [...bucket.exercises.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  return { date: today, window, comparison, partial: Boolean(partial), warnings: [...warnings] };
}

/** One bounded database-query sequence, followed by at most four concurrent body reads. */
export async function fetchProgressSummary({ date } = {}) {
  const today = reportDate(date);
  const oldest = addDaysKL(today, -61); // Include weekly rows overlapping the comparison window.
  const dbId = await resolveDbId("Workout Log");
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp =
    findProp(schema, (name, def) => name === "date" && def.type === "date") ??
    findProp(schema, (_name, def) => def.type === "date");
  if (!dateProp) throw new Error("Workout Log needs a date property for a progress summary.");
  const titleProp = findProp(schema, (_name, def) => def.type === "title");
  const statusProp =
    findProp(
      schema,
      (name, def) => name.includes("status") && ["select", "status"].includes(def.type),
    ) ?? findProp(schema, (_name, def) => def.type === "status");
  const filters = [
    { property: dateProp, date: { on_or_after: oldest } },
    { property: dateProp, date: { on_or_before: today } },
  ];
  if (statusProp) {
    const type = schema[statusProp].type;
    // Notion rejects filters naming options that do not exist in the workspace.
    for (const option of schema[statusProp][type]?.options ?? []) {
      if (typeof option.name === "string" && /^(planned|skipped)$/i.test(option.name)) {
        filters.push({ property: statusProp, [type]: { does_not_equal: option.name } });
      }
    }
  }
  const rows = [];
  let scanned = 0;
  let cursor;
  let partial = false;
  const cursors = new Set();
  const pageIds = new Set();
  do {
    const result = await notion(`/databases/${dbId}/query`, "POST", {
      filter: { and: filters },
      sorts: [{ property: dateProp, direction: "descending" }],
      page_size: ROW_LIMIT + 1 - scanned,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    if (!Array.isArray(result.results)) throw new Error("Workout Log returned invalid rows.");
    if (result.has_more && (!result.next_cursor || cursors.has(result.next_cursor))) {
      throw new Error("Workout Log pagination is incomplete.");
    }
    for (const page of result.results) {
      if (scanned === ROW_LIMIT) {
        partial = true;
        break;
      }
      scanned++;
      if (page.archived || page.in_trash) continue;
      if (/^(?:planned|skipped)$/i.test(String(readProp(page.properties?.[statusProp])).trim()))
        continue;
      const dateValue = page.properties?.[dateProp]?.date;
      const key = calendarDate(dateValue?.start);
      // Missing dates are not eligible completed days; no body read is needed.
      if (!key || key < oldest || key > today) continue;
      if (typeof page.id !== "string" || !page.id) throw new Error("Workout row has no page id.");
      if (pageIds.has(page.id)) continue;
      pageIds.add(page.id);
      rows.push({
        pageId: page.id,
        date: key,
        endDate: calendarDate(dateValue?.end),
        weekly: /^Week of\b/i.test(String(readProp(page.properties?.[titleProp]))),
      });
    }
    partial ||= scanned >= ROW_LIMIT && Boolean(result.has_more);
    cursor = result.has_more ? result.next_cursor : undefined;
    if (cursor) cursors.add(cursor);
  } while (cursor && !partial);

  let next = 0;
  let bodyError;
  await Promise.all(
    Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length && !bodyError) {
        const row = rows[next++];
        try {
          row.body = await blocksToMarkdown(row.pageId);
        } catch (error) {
          bodyError ??= error;
        }
      }
    }),
  );
  if (bodyError) throw bodyError;
  return buildProgressSummary(rows, { date: today, partial });
}

/** Failure diagnostics contain no request paths, records, tokens or response bodies. */
export function progressReadErrorCode(error) {
  const status = / -> (400|401|403|404|429|500|502|503|504):/.exec(
    error instanceof Error ? error.message : "",
  )?.[1];
  return status ? `NOTION_${status}` : "READ_FAILED";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--date") {
    console.error("Usage: node scripts/progress-summary.mjs --date YYYY-MM-DD");
    process.exitCode = 1;
  } else {
    fetchProgressSummary({ date: args[1] }).then(
      (summary) => console.log(JSON.stringify(summary)),
      (error) => {
        console.error(`PROGRESS_READ_ERROR ${progressReadErrorCode(error)}`);
        process.exitCode = 1;
      },
    );
  }
}
