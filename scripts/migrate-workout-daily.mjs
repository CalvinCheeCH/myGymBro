#!/usr/bin/env node
/** Split legacy Sun-Sat Workout Log rows into one recoverable row per date. */
import { pathToFileURL } from "node:url";
import { canonicalExerciseName } from "./exercise-aliases.mjs";
import {
  blocksToMarkdown,
  buildPropertyValue,
  findProp,
  markdownToBlocks,
  notion,
  readProp,
  resolveDbId,
} from "./notion.mjs";
import { classifyReportGroups, parseWeekBody } from "./report-card.mjs";

const APPLY = process.argv.includes("--apply");
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function addDays(dayKey, count) {
  const date = new Date(`${dayKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function readPlainTitle(page, titleProp) {
  return (page.properties?.[titleProp]?.title ?? []).map((part) => part.plain_text ?? "").join("");
}

function formatDailyTitle(dayKey) {
  const date = new Date(`${dayKey}T12:00:00Z`);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy} (${LONG_DAYS[date.getUTCDay()]})`;
}

function resolveHeadingDate(heading, weekStart, weekEnd) {
  const match = /^([A-Za-z]{3,9})\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b(.*)$/.exec(heading);
  if (!match) return null;
  const [, , dayText, monthText, yearText, suffix] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const startYear = Number(weekStart.slice(0, 4));
  const years = yearText
    ? [Number(yearText.length === 2 ? `20${yearText}` : yearText)]
    : [startYear - 1, startYear, startYear + 1];
  const candidates = years
    .map((year) => {
      const date = new Date(Date.UTC(year, month - 1, day, 12));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      )
        return null;
      const key = date.toISOString().slice(0, 10);
      return key >= weekStart && key <= weekEnd ? key : null;
    })
    .filter(Boolean);
  if (candidates.length !== 1) {
    throw new Error(
      `Cannot resolve workout heading date "${heading}" inside ${weekStart}..${weekEnd}.`,
    );
  }
  const key = candidates[0];
  const weekday = SHORT_DAYS[new Date(`${key}T12:00:00Z`).getUTCDay()];
  return {
    key,
    title: canonicalExerciseName(suffix.trim().replace(/^[-–—]\s*/, "")) || "Workout",
    heading: `${weekday} ${day}/${month}${suffix}`,
  };
}

function normalizeBodyHeadings(md, weekStart, weekEnd) {
  const sections = [];
  let current = null;
  const preamble = [];
  for (const line of String(md ?? "").split(/\r?\n/)) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    const dated = heading && resolveHeadingDate(heading[2].trim(), weekStart, weekEnd);
    if (dated) {
      current = { key: dated.key, title: dated.title, lines: [`${heading[1]} ${dated.heading}`] };
      sections.push(current);
      continue;
    }
    const normalizedLine = heading
      ? `${heading[1]} ${canonicalExerciseName(heading[2].trim())}`
      : line;
    if (current) current.lines.push(normalizedLine);
    else if (normalizedLine.trim()) preamble.push(normalizedLine);
  }
  if (preamble.length) {
    throw new Error(`Weekly row has content outside dated session sections: ${preamble[0]}`);
  }
  if (!sections.length)
    throw new Error("Weekly row has no dated session sections; it was not changed.");
  return sections;
}

function buildDayPlans(page, schema, md) {
  const dateProp = findProp(schema, (_name, def) => def.type === "date");
  const titleProp = findProp(schema, (_name, def) => def.type === "title");
  const start = page.properties?.[dateProp]?.date?.start?.slice(0, 10);
  if (!start) return null;
  const dateEnd = page.properties?.[dateProp]?.date?.end?.slice(0, 10);
  const oldTitle = readPlainTitle(page, titleProp);
  const end = dateEnd ?? addDays(start, 6);
  const sections = normalizeBodyHeadings(md, start, end);
  const parsed = parseWeekBody(
    sections.map((section) => section.lines.join("\n")).join("\n\n"),
    start,
  );
  const days = new Map();
  for (const section of sections) {
    const day = days.get(section.key) ?? { key: section.key, titles: [], sections: [] };
    if (section.title && !day.titles.includes(section.title)) day.titles.push(section.title);
    day.sections.push(section);
    days.set(section.key, day);
  }
  const uniqueDates = [...days.keys()];
  const sessionCount =
    Number(readProp(page.properties?.[findProp(schema, (name) => /sessions?/i.test(name))])) || 0;
  const oldDuration =
    Number(readProp(page.properties?.[findProp(schema, (name) => /duration/i.test(name))])) || 0;
  const oldStatusProp = findProp(schema, (name) => name.toLowerCase() === "status");
  const status = page.properties?.[oldStatusProp]?.select?.name;
  const programProp = findProp(schema, (_name, def) => def.type === "relation");
  const weekProp = findProp(
    schema,
    (name, def) => name.toLowerCase() === "week" && def.type === "select",
  );
  const rpeProp = findProp(schema, (name) => /rpe/i.test(name));
  const focusProp = findProp(schema, (name) => /focus/i.test(name));
  const volumeProp = findProp(schema, (name) => /volume/i.test(name));
  const topSetProp = findProp(schema, (name) => /top\s*set/i.test(name));
  const durationProp = findProp(schema, (name) => /duration/i.test(name));
  const sessionsProp = findProp(schema, (name) => /sessions?/i.test(name));
  const dayProp = findProp(
    schema,
    (name, def) => name.toLowerCase() === "day" && def.type === "select",
  );
  const statusDef = oldStatusProp ? schema[oldStatusProp] : null;

  return [...days.values()].map((day) => {
    const daySections = parsed.filter((section) => section.key === day.key);
    const body = day.sections.map((section) => section.lines.join("\n").trim()).join("\n\n");
    const exerciseNames = daySections.flatMap((section) =>
      section.exercises.map((exercise) => exercise.exercise),
    );
    const focus = new Set(exerciseNames.flatMap(classifyReportGroups));
    if (
      day.sections.some((section) =>
        /\b(hill run|hill climbs?|cindy|cardio|sprint|run)\b/i.test(section.title),
      )
    ) {
      focus.add("Cardio");
    }
    const stats = daySections.flatMap((section) => section.exercises);
    const dailyDuration = daySections
      .map((section) => section.durationMin ?? 0)
      .reduce((sum, value) => sum + value, 0);
    const inheritedDuration = uniqueDates.length === 1 ? oldDuration : 0;
    const dailySessions =
      uniqueDates.length === 1
        ? Math.max(sessionCount, day.sections.length, 1)
        : day.sections.length;
    const title = formatDailyTitle(day.key);
    const weekday = LONG_DAYS[new Date(`${day.key}T12:00:00Z`).getUTCDay()];
    const properties = {
      [titleProp]: buildPropertyValue("title", title),
      [dateProp]: buildPropertyValue("date", day.key),
    };
    if (dayProp) properties[dayProp] = buildPropertyValue("select", weekday);
    if (focusProp) {
      properties[focusProp] = focus.size
        ? buildPropertyValue("multi_select", [...focus].join(","))
        : { multi_select: [] };
    }
    if (statusDef?.type === "select")
      properties[oldStatusProp] = buildPropertyValue("select", status || "Completed");
    if (volumeProp) {
      const volume = stats.reduce((sum, exercise) => sum + exercise.vol, 0);
      if (volume > 0)
        properties[volumeProp] = buildPropertyValue("number", String(Math.round(volume)));
    }
    if (topSetProp) {
      const top = Math.max(0, ...stats.map((exercise) => exercise.bestW));
      if (top > 0) properties[topSetProp] = buildPropertyValue("number", String(top));
    }
    if (durationProp && (dailyDuration > 0 || inheritedDuration > 0)) {
      properties[durationProp] = buildPropertyValue(
        "number",
        String(dailyDuration || inheritedDuration),
      );
    }
    if (sessionsProp)
      properties[sessionsProp] = buildPropertyValue("number", String(dailySessions));
    if (uniqueDates.length === 1 && rpeProp && page.properties?.[rpeProp]?.number != null) {
      properties[rpeProp] = { number: page.properties[rpeProp].number };
    }
    if (uniqueDates.length === 1 && weekProp && page.properties?.[weekProp]?.select?.name) {
      properties[weekProp] = { select: { name: page.properties[weekProp].select.name } };
    }
    if (programProp && page.properties?.[programProp]?.relation?.length) {
      properties[programProp] = { relation: page.properties[programProp].relation };
    }
    return {
      key: day.key,
      title,
      weekday,
      body,
      properties,
      sections: day.sections.length,
      duration: dailyDuration || inheritedDuration || null,
      source: page,
      sourceTitle: oldTitle,
      unassignedWeeklyDuration: uniqueDates.length > 1 ? oldDuration : 0,
    };
  });
}

function sameMarkdown(a, b) {
  const normalize = (value) =>
    String(value ?? "")
      .trim()
      .replace(/\r/g, "")
      .replace(/\n{2,}/g, "\n");
  return normalize(a) === normalize(b);
}

async function queryAll(dbId) {
  const rows = [];
  let cursor;
  do {
    const result = await notion(`/databases/${dbId}/query`, "POST", {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...(result.results ?? []));
    if (result.has_more && !result.next_cursor)
      throw new Error("Workout Log pagination ended without a cursor.");
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return rows;
}

async function findReusableDailyRow(rows, titleProp, dateProp, plan) {
  const sameDate = rows.filter((row) => {
    if (row.id === plan.source.id) return false;
    const date = row.properties?.[dateProp]?.date;
    return date?.start?.slice(0, 10) === plan.key && !date?.end;
  });
  if (!sameDate.length) return null;
  if (sameDate.length !== 1 || readPlainTitle(sameDate[0], titleProp) !== plan.title) {
    throw new Error(
      `A non-migration Workout Log row already exists on ${plan.key}; kept the weekly source row.`,
    );
  }
  const body = await blocksToMarkdown(sameDate[0].id);
  if (!sameMarkdown(body, plan.body)) {
    throw new Error(
      `Daily row ${plan.key} does not match the migration content; kept the weekly source row.`,
    );
  }
  return sameDate[0];
}

async function createAndVerify(plan, titleProp, dateProp, rows) {
  const existing = await findReusableDailyRow(rows, titleProp, dateProp, plan);
  if (existing) {
    console.log(`= already migrated ${plan.title}`);
    return existing.id;
  }
  const created = await notion("/pages", "POST", {
    parent: { database_id: plan.source.parent.database_id },
    properties: plan.properties,
  });
  const blocks = markdownToBlocks(plan.body);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${created.id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  const [saved, savedBody] = await Promise.all([
    notion(`/pages/${created.id}`),
    blocksToMarkdown(created.id),
  ]);
  const date = saved.properties?.[dateProp]?.date?.start?.slice(0, 10);
  const title = readPlainTitle(saved, titleProp);
  if (date !== plan.key || title !== plan.title || !sameMarkdown(savedBody, plan.body)) {
    throw new Error(
      `Created daily row ${created.id} did not verify; source weekly record was kept.`,
    );
  }
  rows.push(saved);
  console.log(`+ ${plan.title} (${plan.key}) verified`);
  return created.id;
}

async function main() {
  console.log(APPLY ? "Workout Log migration: APPLY mode." : "=== DRY RUN (no changes) ===");
  const dbId = await resolveDbId("Workout Log");
  const db = await notion(`/databases/${dbId}`);
  const schema = db.properties ?? {};
  const dateProp = findProp(schema, (_name, def) => def.type === "date");
  const titleProp = findProp(schema, (_name, def) => def.type === "title");
  const rows = await queryAll(dbId);
  const plansBySource = [];
  for (const page of rows) {
    const date = page.properties?.[dateProp]?.date;
    if (!date?.start) continue;
    const body = await blocksToMarkdown(page.id);
    const normalized = normalizeBodyHeadings(
      body,
      date.start.slice(0, 10),
      date.end?.slice(0, 10) ?? addDays(date.start.slice(0, 10), 6),
    );
    const title = readPlainTitle(page, titleProp);
    const isWeekly = Boolean(date.end) || /^Week of\b/i.test(title) || normalized.length > 1;
    if (!isWeekly) continue;
    const plans = buildDayPlans(page, schema, body);
    plansBySource.push({ page, plans });
  }

  const allPlans = plansBySource.flatMap((entry) => entry.plans);
  console.log(
    `Rows scanned: ${rows.length}; weekly rows to split: ${plansBySource.length}; daily rows planned: ${allPlans.length}`,
  );
  for (const { page, plans } of plansBySource) {
    const sourceTitle = readPlainTitle(page, titleProp);
    const unassigned = Math.max(...plans.map((plan) => plan.unassignedWeeklyDuration), 0);
    console.log(`\n${sourceTitle}:`);
    for (const plan of plans) {
      console.log(
        `  ${plan.title} — ${plan.sections} session section(s), duration ${plan.duration ?? "unknown"} min${APPLY ? "" : " [dry run]"}`,
      );
    }
    if (unassigned > 0)
      console.log(
        `  Existing ${unassigned}-minute weekly total cannot be split reliably; it stays on the archived source row.`,
      );
    if (!APPLY) continue;
    for (const plan of plans) await createAndVerify(plan, titleProp, dateProp, rows);
    await notion(`/pages/${page.id}`, "PATCH", { archived: true, in_trash: true });
    console.log("  Archived weekly source after daily rows verified.");
  }
  console.log(APPLY ? "\nMigration complete." : "\n=== DRY RUN complete ===");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`migrate-workout-daily failed: ${error.message}`);
    process.exitCode = 1;
  });
}
