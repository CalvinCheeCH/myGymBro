#!/usr/bin/env node
/**
 * progression.mjs: deterministic training math for the coach.
 *
 * The LLM coaches; this script does the arithmetic so prescriptions do not drift
 * between sessions. Pure functions are exported for tests and CLI commands wrap
 * them with Notion access:
 *
 *   node scripts/progression.mjs suggest --exercise "Squat" [--rule double|linear] [--json]
 *       Parse recent Workout Log bodies, find the exercise, apply a progression
 *       rule (with stall detection and deload), print next load plus the reason.
 *   node scripts/progression.mjs onerm --exercise "Bench" [--json]
 *       Best estimated 1RM (Epley) from logged sets, reps capped at 12.
 *   node scripts/progression.mjs plates --load 62.5 [--bar 20]
 *       Plate breakdown per side for an Olympic bar.
 *   node scripts/progression.mjs streaks [--weeks 8] [--json]
 *       Consistency squares per week from Workout Log dates.
 *   node scripts/progression.mjs heatmap [--weeks 26]
 *       GitHub-style workout calendar grid (see publish-heatmap.mjs for the
 *       version that writes it to the Notion Training Calendar page.)
 *
 * suggest/onerm/streaks/heatmap need NOTION_TOKEN; plates is offline.
 */

import { pathToFileURL } from "node:url";
import { canonicalExerciseName } from "./exercise-aliases.mjs";
import { findProp, isoDate, notion, readProp, resolveDbId, startOfWeekUTC } from "./notion.mjs";

// ─── pure helpers ────────────────────────────────────────────────────────────

export const round25 = (x) => Math.round(x / 2.5) * 2.5;
export const round05 = (x) => Math.round(x * 2) / 2;

/** Day-section headings in weekly bodies ("Tue 1/9 - Leg Day"): markers, not lifts. */
export const DAY_HEADING = /^[A-Za-z]{3,9}\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/;

/** Logged loads are canonical kg, with pounds rounded to the nearest 0.1kg. */
export function weightInKg(weight, unit = "") {
  return /^lbs?$/i.test(unit) ? Math.round(weight * 0.4536 * 10) / 10 : weight;
}

/** "80kg x 12" style pairs, with optional trailing "x N" sets-count. */
export function parseSetPairs(text) {
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(kg|lbs?)?\s*x\s*(\d+)(?:\s*x\s*(\d+))?/gi;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    const w = weightInKg(Number(m[1]), m[2]);
    out.push({ w, r: Number(m[3]), n: Number(m[4] ?? 1) });
  }
  return out;
}

/**
 * Sets from a session body, one entry per set-group. Two line shapes:
 * legacy one-liners carrying their own name ("Squat 5x5 @80kg"), and
 * heading-carried pairs ("## Squat" then "- 80kg x 12") from the current
 * log-workout body format. Day-section headings ("## Tue 1/9 - Leg Day")
 * only mark the enclosing day; `day` is its text (or null for legacy rows).
 */
export function parseLifts(text) {
  const out = [];
  let current = null;
  let day = null;
  const legacyRe =
    /([A-Za-z][A-Za-z\s\-']{1,38}?)\s+(\d+)\s*[xX]\s*(\d+)(?:\s*@\s*(\d+(?:\.\d+)?)\s*(kg|lbs?)?)?/gi;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) {
      const name = h[1].trim().replace(/\s+/g, " ");
      if (DAY_HEADING.test(name)) {
        day = name;
        current = null;
      } else {
        current = name;
      }
      continue;
    }
    let foundLegacy = false;
    // Pair bullets ("- 80kg x 12") start with a digit: the legacy pattern
    // would misread "kg x" as an exercise name, so it only runs on
    // letter-start lines ("Squat 5x5 @80kg").
    const stripped = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!/^\d/.test(stripped)) {
      for (const m of line.matchAll(legacyRe)) {
        const name = m[1].trim().replace(/\s+/g, " ");
        const sets = Number(m[2]);
        const reps = Number(m[3]);
        const load = m[4] !== undefined ? weightInKg(Number(m[4]), m[5]) : null;
        if (!name || !Number.isFinite(sets) || !Number.isFinite(reps)) continue;
        out.push({ name: canonicalExerciseName(name), sets, reps, load, day });
        foundLegacy = true;
      }
    }
    if (foundLegacy || !current) continue;
    for (const p of parseSetPairs(stripped)) {
      out.push({ name: canonicalExerciseName(current), sets: p.n, reps: p.r, load: p.w, day });
    }
  }
  return out;
}

/** True when the logged exercise name contains the needle (case insensitive). */
export function matchesExercise(liftName, needle) {
  return liftName.toLowerCase().includes(needle.toLowerCase());
}

/** Epley estimate, rounded to 0.5kg. Reps beyond cap return null (too noisy). */
export function estimate1RM(load, reps, { cap = 12 } = {}) {
  if (!Number.isFinite(load) || !Number.isFinite(reps)) return null;
  if (reps <= 0 || reps > cap) return null;
  return round05(load * (1 + reps / 30));
}

/** Best Epley estimate across parsed sets, with provenance of the winning set. */
export function bestEpley(sets, options = {}) {
  let best = null;
  for (const s of sets) {
    const est = estimate1RM(s.load, s.reps, options);
    if (est != null && (best === null || est > best.estimate)) {
      best = { estimate: est, load: s.load, reps: s.reps, date: s.date ?? null };
    }
  }
  return best;
}

/** Linear progression: hit the rep target, add the increment; otherwise hold. */
export function nextLinear(sessions, { targetReps = 5, increment = 2.5 } = {}) {
  const last = sessions.at(-1);
  if (!last) return null;
  if (last.reps >= targetReps) {
    return {
      action: "increase",
      load: round25(last.load + increment),
      reason:
        `Last time ${last.load}kg x${last.reps} reached the ${targetReps}-rep target, ` +
        `so linear adds ${increment}kg.`,
    };
  }
  return {
    action: "hold",
    load: last.load,
    reason: `Last time ${last.load}kg only got ${last.reps} of ${targetReps} reps, so linear holds the load until you make the target.`,
  };
}

/** Double progression through a rep range: fill the range at this load, then add. */
export function nextDouble(sessions, { repMin = 5, repMax = 8, increment = 2.5 } = {}) {
  const last = sessions.at(-1);
  if (!last) return null;
  if (last.reps >= repMax) {
    return {
      action: "increase",
      load: round25(last.load + increment),
      reason:
        `Top set hit ${last.reps} reps at ${last.load}kg, the top of the ` +
        `${repMin}-${repMax} range on every set, so add ${increment}kg.`,
    };
  }
  if (last.reps >= repMin) {
    return {
      action: "hold",
      load: last.load,
      reason:
        `${last.reps} reps sits inside the ${repMin}-${repMax} range at ${last.load}kg. ` +
        `Hold the load and climb to ${repMax} before adding weight.`,
    };
  }
  return {
    action: "hold",
    load: last.load,
    reason:
      `Only ${last.reps} reps at ${last.load}kg, below the ${repMin}-${repMax} range. ` +
      `Repeat the load and rebuild to ${repMin} first.`,
  };
}

/** Same load held for `window` consecutive sessions means stalled. */
export function detectStall(sessions, { window = 3 } = {}) {
  if (sessions.length < window) return null;
  const lastN = sessions.slice(-window);
  const loads = new Set(lastN.map((s) => s.load));
  return loads.size === 1 ? { load: lastN[0].load, sessions: window } : null;
}

/** Deload: 10 percent off, snapped back onto plate math. */
export function deloadLoad(load) {
  return round25(load * 0.9);
}

/** Standard Olympic plate loading, greedy largest first, reported per side. */
export function calculatePlates(
  load,
  { bar = 20, available = [25, 20, 15, 10, 5, 2.5, 1.25] } = {},
) {
  const sideTarget = (load - bar) / 2;
  if (!Number.isFinite(sideTarget)) return { ok: false, error: "Load must be a number." };
  if (sideTarget < 0) {
    return {
      ok: false,
      error: `${load}kg is lighter than the ${bar}kg bar. Use a lighter bar or log it as bodyweight work.`,
    };
  }
  let remaining = Math.round(sideTarget * 100) / 100;
  const perSide = [];
  for (const plate of available) {
    while (remaining >= plate - 1e-9) {
      perSide.push(plate);
      remaining = Math.round((remaining - plate) * 100) / 100;
    }
  }
  const achievable = Math.round((bar + perSide.reduce((a, b) => a + b, 0) * 2) * 100) / 100;
  return {
    ok: true,
    exact: remaining <= 0,
    perSide,
    achievable,
    leftover: remaining,
    note:
      remaining > 0
        ? `No plate combination hits ${load}kg exactly; closest barbell load is ${achievable}kg (${remaining}kg short per side).`
        : null,
  };
}

/**
 * GitHub-style consistency squares, one cell per day, Monday start, most recent
 * week last. Dates are YYYY-MM-DD strings from the Workout Log.
 */
export function renderStreaks(datesISO, { weeks = 8, today = new Date() } = {}) {
  const logged = new Set(datesISO.filter(Boolean));
  const monday = startOfWeekUTC(today);
  const lines = [];
  let total = 0;
  for (let w = weeks - 1; w >= 0; w--) {
    const start = new Date(monday);
    start.setUTCDate(start.getUTCDate() - w * 7);
    const cells = [];
    let count = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + d);
      const key = isoDate(day);
      if (logged.has(key)) {
        cells.push("🟩");
        count++;
      } else {
        cells.push("⬜");
      }
    }
    total += count;
    lines.push(`w/c ${isoDate(start)}: ${cells.join("")} (${count})`);
  }
  lines.push(`Total: ${total} sessions over ${weeks} weeks.`);
  return lines.join("\n");
}

// ─── workout calendar heatmap ────────────────────────────────────────────────
// GitHub-style intensity grid for a Notion page: columns are weeks (Monday
// start, oldest left), rows are Mon..Sun, and each cell is a coloured square
// keyed to how many sessions were logged that day. Rendered as a markdown
// table so `markdownToBlocks` produces a real Notion table block.

export const HEAT_CELLS = ["⬜", "🟩", "🟨", "🟧", "🟥"];

/** Session count -> heatmap square. 0 rest, 1 light, 2 normal, 3 heavy, 4+. */
export function heatCell(count) {
  if (count <= 0) return HEAT_CELLS[0];
  if (count === 1) return HEAT_CELLS[1];
  if (count === 2) return HEAT_CELLS[2];
  if (count === 3) return HEAT_CELLS[3];
  return HEAT_CELLS[4];
}

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ddmm(date) {
  return date.toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "2-digit" });
}

/**
 * Render a GitHub-style workout calendar heatmap. `datesISO` are Workout Log
 * row dates (duplicates count, so two sessions in a day read as a hotter cell).
 * The grid is one row per weekday and one column per week, oldest week first,
 * in a markdown table plus a legend and totals line.
 */
export function renderHeatmapGrid(datesISO, { weeks = 26, today = new Date() } = {}) {
  const counts = new Map();
  for (const d of datesISO.filter(Boolean)) counts.set(d, (counts.get(d) ?? 0) + 1);

  const monday = startOfWeekUTC(today);
  const weekStarts = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = new Date(monday);
    start.setUTCDate(start.getUTCDate() - w * 7);
    weekStarts.push(start);
  }

  const legend = `${HEAT_CELLS[0]} rest   ${HEAT_CELLS[1]} 1   ${HEAT_CELLS[2]} 2   ${HEAT_CELLS[3]} 3   ${HEAT_CELLS[4]} 4+`;
  const header = `| Day | ${weekStarts.map((s) => `w/c ${ddmm(s)}`).join(" | ")} |`;
  const divider = `| --- | ${weekStarts.map(() => "---").join(" | ")} |`;

  const cellsByRow = DAY_ORDER.map((dayLabel, d) => {
    const cells = weekStarts.map((start) => {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + d);
      return heatCell(counts.get(isoDate(day)) ?? 0);
    });
    return `| ${dayLabel} | ${cells.join(" | ")} |`;
  });

  const weekTotals = weekStarts.map((start) => {
    let total = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + d);
      total += counts.get(isoDate(day)) ?? 0;
    }
    return total;
  });
  const totalsRow = `| Total | ${weekTotals.join(" | ")} |`;

  const grandTotal = weekTotals.reduce((a, b) => a + b, 0);
  const summary = `${grandTotal} sessions in the last ${weeks} weeks.`;

  return [legend, "", header, divider, ...cellsByRow, totalsRow, "", summary].join("\n");
}

// ─── Notion access ───────────────────────────────────────────────────────────

/** Recent non-skipped Workout Log rows with their page-body text. */
export async function fetchWorkoutHistory({ limit = 12 } = {}) {
  const sessionLimit = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 12;
  if (sessionLimit === 0) return [];

  const dbId = await resolveDbId("Workout Log");
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  const titleProp = findProp(schema, (_n, d) => d.type === "title");
  const statusProp = findProp(schema, (n) => n.includes("status"));
  const body = {
    page_size: 100,
    sorts: dateProp ? [{ property: dateProp, direction: "descending" }] : [],
  };
  const rows = [];
  let cursor;
  let hasMore = true;
  while (hasMore && rows.length < sessionLimit) {
    const res = await notion(`/databases/${dbId}/query`, "POST", {
      ...body,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const pg of res.results ?? []) {
      const status = String(readProp(pg.properties?.[statusProp]) ?? "").toLowerCase();
      if (status === "skipped") continue;
      rows.push({
        pageId: pg.id,
        date: readProp(pg.properties?.[dateProp]),
        title: readProp(pg.properties?.[titleProp]),
      });
      if (rows.length >= sessionLimit) break;
    }
    hasMore = Boolean(res.has_more);
    if (hasMore) {
      if (!res.next_cursor)
        throw new Error("Workout Log pagination is incomplete: next_cursor is missing.");
      cursor = res.next_cursor;
    }
  }

  // Fetch a few page bodies at a time to reduce latency without flooding Notion.
  const concurrency = 4;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (nextIndex < rows.length) {
      const index = nextIndex++;
      const row = rows[index];
      try {
        const blocks = await notion(`/blocks/${row.pageId}/children`);
        row.body = (blocks.results ?? [])
          .filter((b) =>
            [
              "paragraph",
              "bulleted_list_item",
              "numbered_list_item",
              "quote",
              "heading_1",
              "heading_2",
              "heading_3",
            ].includes(b.type),
          )
          .map((b) => {
            const text = (b[b.type]?.rich_text ?? []).map((t) => t.plain_text).join("");
            // Headings carry the exercise (or day) name that pair bullets below
            // them belong to; without this prefix the names never reach parseLifts.
            if (b.type === "heading_1") return `# ${text}`;
            if (b.type === "heading_2") return `## ${text}`;
            if (b.type === "heading_3") return `### ${text}`;
            return text;
          })
          .join("\n");
      } catch (err) {
        console.error(`Could not read body of "${row.title}" (${row.date}): ${err.message}`);
        row.body = "";
      }
    }
  });
  await Promise.all(workers);

  return rows;
}

/** Group parsed lifts into per-session top sets for one exercise, oldest first. */
export function sessionsForExercise(rows, needle) {
  const sessions = [];
  const allSets = [];
  for (const row of rows) {
    const lifts = parseLifts(row.body ?? "").filter(
      (l) => l.load != null && matchesExercise(l.name, needle),
    );
    if (!lifts.length) continue;
    const top = lifts.reduce((a, b) => ((b.load ?? 0) > (a.load ?? 0) ? b : a));
    sessions.push({
      date: row.date,
      title: row.title,
      load: top.load,
      reps: top.reps,
      sets: top.sets,
    });
    for (const l of lifts) allSets.push({ load: l.load, reps: l.reps, date: row.date });
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { sessions, allSets };
}

/** Every distinct exercise name found in recent bodies, for helpful errors. */
export function distinctNames(rows) {
  const names = new Set();
  for (const row of rows) {
    for (const lift of parseLifts(row.body ?? "")) {
      if (lift.load == null) continue;
      names.add(lift.name);
    }
  }
  return [...names].sort();
}

/** Compact latest logged day for the Dashboard; never turns a plan into a completed set. */
export function latestLoggedSession(rows) {
  for (const row of rows) {
    const lifts = parseLifts(row.body ?? "");
    if (!lifts.length) continue;
    const day = [...lifts].reverse().find((lift) => lift.day)?.day ?? null;
    const sessionLifts = day ? lifts.filter((lift) => lift.day === day) : lifts;
    const latestByExercise = new Map();
    for (const lift of sessionLifts) {
      if (!Number.isFinite(lift.reps)) continue;
      latestByExercise.set(lift.name, {
        name: lift.name,
        load: lift.load,
        reps: lift.reps,
      });
    }
    return {
      label: day ?? [row.date, row.title].filter(Boolean).join(" · "),
      lifts: [...latestByExercise.values()],
    };
  }
  return null;
}

// ─── CLI commands ────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    flags[key] = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
  }
  return flags;
}

function requireToken() {
  if (!process.env.NOTION_TOKEN) {
    console.error("NOTION_TOKEN is not set. This command needs Notion access.");
    process.exit(1);
  }
}

async function cmdSuggest(args) {
  requireToken();
  const exercise = args.exercise;
  if (!exercise) throw new Error('--exercise "<name>" is required');
  const rule = args.rule === "linear" ? "linear" : "double";
  const increment = Number(args.increment ?? 2.5) || 2.5;

  const rows = await fetchWorkoutHistory({ limit: Number(args.sessions ?? 12) || 12 });
  const result = suggestionForExercise(rows, exercise, rule, increment);
  if (args.json) console.log(JSON.stringify(result.data, null, 2));
  else console.log(result.output);
}

async function cmdSuggestBatch(args) {
  requireToken();
  const exercises = String(args.exercises ?? "")
    .split(",")
    .map((exercise) => exercise.trim())
    .filter(Boolean);
  if (!exercises.length) throw new Error('--exercises "<name>,<name>" is required');
  const rule = args.rule === "linear" ? "linear" : "double";
  const increment = Number(args.increment ?? 2.5) || 2.5;
  const rows = await fetchWorkoutHistory({ limit: Number(args.sessions ?? 12) || 12 });
  const results = exercises.map((exercise) =>
    suggestionForExercise(rows, exercise, rule, increment),
  );
  if (args.json)
    console.log(
      JSON.stringify(
        results.map((result) => result.data),
        null,
        2,
      ),
    );
  else console.log(results.map((result) => result.output).join("\n\n"));
}

function suggestionForExercise(rows, exercise, rule, increment) {
  const { sessions, allSets } = sessionsForExercise(rows, exercise);
  if (!sessions.length) {
    const names = distinctNames(rows);
    return {
      data: { exercise, found: false, sessions: [], names },
      output: [
        `No sets found for "${exercise}" in the last ${rows.length} completed sessions.`,
        names.length ? `Logged exercises recently: ${names.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const base =
    rule === "linear" ? nextLinear(sessions, { increment }) : nextDouble(sessions, { increment });
  const stall = detectStall(sessions);
  let result = base;
  if (stall && base && base.action !== "increase") {
    result = {
      action: "deload",
      load: deloadLoad(stall.load),
      reason:
        `${stall.sessions} straight sessions stuck at ${stall.load}kg without progress. ` +
        `Deload 10% to ${deloadLoad(stall.load)}kg, rebuild to the rep target, then resume.`,
    };
  }

  const e1rm = bestEpley(allSets);
  const historyLines = sessions
    .slice(-6)
    .map((s) => `- ${s.date} ${s.title}: ${s.sets}x${s.reps} @${s.load}kg`)
    .join("\n");

  const output = [
    `**${exercise}**, ${rule} progression`,
    `Next: ${result.load}kg (${result.action})`,
    result.reason,
    e1rm
      ? `Best estimated 1RM: ~${e1rm.estimate}kg (from ${e1rm.load}kg x${e1rm.reps}, ${e1rm.date}).`
      : null,
    "",
    "Recent:",
    historyLines,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    data: { exercise, rule, ...result, stall: stall ?? null, e1rm, sessions },
    output,
  };
}

async function cmdOneRm(args) {
  requireToken();
  const exercise = args.exercise;
  if (!exercise) throw new Error('--exercise "<name>" is required');
  const rows = await fetchWorkoutHistory({ limit: Number(args.sessions ?? 12) || 12 });
  const { allSets } = sessionsForExercise(rows, exercise);
  const best = bestEpley(allSets);
  if (!best) {
    console.log(`No usable sets (load with 1-12 reps) found for "${exercise}".`);
    return;
  }
  const line = `Estimated 1RM for **${exercise}**: ~${best.estimate}kg (from ${best.load}kg x${best.reps} on ${best.date}).`;
  if (args.json) console.log(JSON.stringify(best, null, 2));
  else console.log(line);
}

async function cmdPlates(args) {
  const load = Number(args.load);
  if (!Number.isFinite(load)) throw new Error("--load <kg> is required");
  const bar = Number(args.bar ?? 20) || 20;
  const result = calculatePlates(load, { bar });
  if (!result.ok) {
    console.log(result.error);
    process.exitCode = 1;
    return;
  }
  const side = result.perSide.length ? result.perSide.join(" + ") : "empty bar";
  const line = `**${achievableLabel(result)}** Per side: ${side}.`;
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.note ? `${line}\n${result.note}` : line);
}

function achievableLabel(result) {
  return `${result.achievable}kg loaded.`;
}

async function cmdStreaks(args) {
  requireToken();
  const dbId = await resolveDbId("Workout Log");
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  const body = {
    page_size: 100,
    sorts: dateProp ? [{ property: dateProp, direction: "descending" }] : [],
  };
  if (dateProp) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 7 * (Number(args.weeks ?? 8) || 8) - 7);
    body.filter = { property: dateProp, date: { on_or_after: isoDate(since) } };
  }
  const res = await notion(`/databases/${dbId}/query`, "POST", body);
  const dates = (res.results ?? [])
    .map((pg) => readProp(pg.properties?.[dateProp]))
    .filter(Boolean);
  const text = renderStreaks(dates, { weeks: Number(args.weeks ?? 8) || 8 });
  if (args.json) console.log(JSON.stringify({ dates, render: text }, null, 2));
  else console.log(text);
}

async function cmdHeatmap(args) {
  requireToken();
  const dbId = await resolveDbId("Workout Log");
  const schema = (await notion(`/databases/${dbId}`)).properties ?? {};
  const dateProp = findProp(schema, (_n, d) => d.type === "date");
  const weeks = Number(args.weeks ?? 26) || 26;
  const body = { page_size: 100 };
  if (dateProp) {
    const start = startOfWeekUTC(new Date());
    const since = new Date(start);
    since.setUTCDate(since.getUTCDate() - 7 * (weeks - 1));
    body.filter = { property: dateProp, date: { on_or_after: isoDate(since) } };
    body.sorts = [{ property: dateProp, direction: "descending" }];
  }
  const res = await notion(`/databases/${dbId}/query`, "POST", body);
  const dates = (res.results ?? [])
    .map((pg) => readProp(pg.properties?.[dateProp]))
    .filter(Boolean);
  console.log(renderHeatmapGrid(dates, { weeks }));
}

const COMMANDS = {
  suggest: cmdSuggest,
  "suggest-batch": cmdSuggestBatch,
  onerm: cmdOneRm,
  plates: cmdPlates,
  streaks: cmdStreaks,
  heatmap: cmdHeatmap,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command "${command}". Use one of: ${Object.keys(COMMANDS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  await fn(parseFlags(rest));
}

// Run only when invoked directly, so tests can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
