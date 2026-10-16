/**
 * Report cards: branded workout summaries for Telegram, rendered as PNGs.
 *
 * Weekly cards pair session-duration lines with grouped muscle-set bars.
 * Monthly cards compare average weekly sets across two completed months when
 * both months have workout records; a single month remains a one-series chart.
 *
 * QuickChart renders the charts, and Sharp composes the weekly panels into one
 * image. Only aggregate chart values and labels leave the machine;
 * individual lift names, set details, and Notion credentials do not. If that
 * boundary changes, swap the render step for a local renderer.
 *
 * Only logged data is shown. No sleep, heart rate, water, or readiness
 * metrics: nothing tracks those, and the card never invents them.
 *
 * Auth comes from the environment (NOTION_TOKEN, NOTION_VERSION): the bot's
 * bash tool inherits them, so this just works in chat; locally run it as
 * `node --env-file=.env scripts/report-card.mjs`.
 *
 * Usage:
 *   node scripts/report-card.mjs [--style card] [--period week|day|month]
 *     [--date YYYY-MM-DD] [--week-offset 0] [--out data/report-card.png]
 *   --week-offset -1 renders the previous Sun-Sat week for Sunday's report.
 *
 * Output (agent-friendly):
 *   CARD <absolute png path>
 *   CAPTION <one-line summary>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { canonicalExerciseName } from "./exercise-aliases.mjs";
import { blocksToMarkdown, notion } from "./notion.mjs";
import { DAY_HEADING, parseSetPairs, weightInKg } from "./progression.mjs";

const TOKEN = process.env.NOTION_TOKEN;
const TZ = process.env.TIMEZONE ?? "Etc/UTC";
const CACHE_FILE = path.resolve(process.cwd(), "data", "notion-ids.json");
const CARD_BG = "#F3F4EF";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

export function assertReportOutputPath(output) {
  let current = path.resolve(output);
  while (true) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("Report output paths must not contain symbolic links.");
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function dayKeyKL(iso) {
  // An all-day calendar date has no timezone offset to convert.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Find a property value by exact name, else first case-insensitive contains. */
function prop(page, ...names) {
  const props = page.properties ?? {};
  for (const n of names) {
    if (props[n] != null) return props[n];
  }
  const keys = Object.keys(props);
  for (const n of names) {
    const hit = keys.find((k) => k.toLowerCase().includes(n.toLowerCase()));
    if (hit) return props[hit];
  }
  return null;
}

/** Weekday index (0 = Sunday) of an ISO calendar date (YYYY-MM-DD). */
export function weekdayIdxKL(dayKey) {
  return new Date(`${dayKey}T04:00:00Z`).getUTCDay();
}
export function addDaysKL(dayKey, n) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthStartKL(dayKey, offset = 0) {
  const [year, month] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + offset, 1, 12)).toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const days = [];
  for (let day = start; day <= end; day = addDaysKL(day, 1)) days.push(day);
  return days;
}

function monthTitle(dayKey) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, month: "long", year: "numeric" }).format(
    new Date(`${dayKey}T12:00:00Z`),
  );
}

/**
 * Classify one exercise name for TOP lines, so weekly bests
 * land under the right muscle group even when the session row carries several
 * Focus tags. Compounds checked before generic words ("push down" is Triceps,
 * "push up" is Chest). Returns null when nothing matches; callers fall back
 * to General.
 */
export function classifyExercise(name) {
  const n = ` ${canonicalExerciseName(name).toLowerCase()} `;
  const has = (...words) => words.some((w) => n.includes(w));
  if (has("squat", "lunge", " leg", "legs", "calf", "calves", "hip thrust", "leg press")) {
    return "Legs";
  }
  if (has("tricep", "push down", "pushdown", "extension", " dip", "dips")) return "Triceps";
  if (has("bicep", "curl")) return "Biceps";
  if (has("lateral raise", "overhead", "shoulder", "ohp")) return "Shoulders";
  if (has(" lat", "lat-", "pull", " row", " chin", "deadlift", "shrug", "face pull")) {
    return "Back";
  }
  if (has("bench", "chest", "fly", "flye", "push up", "pushup", "pec", "db press")) {
    return "Chest";
  }
  if (
    has(
      "run",
      "hill",
      "sprint",
      "cycle",
      "cycling",
      "swim",
      "walk",
      "cardio",
      "skip",
      "mma",
      "bjj",
      "roll",
    )
  ) {
    return "Conditioning";
  }
  return null;
}

/** Sunday (week start) on or before the given KL day key. Weeks run Sun-Sat. */
export function sundayStartKL(dayKey) {
  return addDaysKL(dayKey, -weekdayIdxKL(dayKey));
}

/** "Week 2: 30/8/2026 - 5/9/2026", or dateless when the number is unknown. */
export function formatWeekTitle(weekStart, weekNo) {
  const fmtD = (k) => {
    const [y, m, d] = k.split("-").map(Number);
    return `${d}/${m}/${y}`;
  };
  const range = `${fmtD(weekStart)} - ${fmtD(addDaysKL(weekStart, 6))}`;
  return weekNo ? `Week ${weekNo}: ${range}` : `Week of ${range}`;
}

/**
 * Parse a weekly row body into ordered day sections:
 * [{ key (dayKey|null), header, rowId, exercises: [{exercise, bestW, bestR,
 * vol, sets, pairs}] }]. `## <Day> <d>/<m>` headings open sections;
 * `###` (or legacy `##`) names attach exercises; bullets carry pairs;
 * legacy one-liners carry their own names. Day keys resolve against the
 * row's week-start Sunday for new-year edges.
 */
export function parseWeekBody(md, rowKey) {
  const ws = rowKey ? sundayStartKL(rowKey) : null;
  const sections = [];
  let cur = null;
  let curEx = null;
  const ensureSec = (header, key, rowId) => {
    let s = sections.find((x) => x.header === header && x.key === key);
    if (!s) {
      s = { header, key, rowId, byEx: new Map(), durations: [] };
      sections.push(s);
    }
    return s;
  };
  const exOf = (sec, name) => {
    let e = sec.byEx.get(name);
    if (!e) {
      e = { exercise: name, bestW: 0, bestR: 0, vol: 0, sets: 0, pairs: [] };
      sec.byEx.set(name, e);
    }
    return e;
  };
  const addPairs = (sec, name, pairs) => {
    const e = exOf(sec, name);
    for (const p of pairs) {
      e.vol += p.w * p.r * p.n;
      e.sets += p.n;
      for (let s = 0; s < p.n; s++) e.pairs.push({ w: p.w, r: p.r });
      if (p.w > e.bestW || (p.w === e.bestW && p.r > e.bestR)) {
        e.bestW = p.w;
        e.bestR = p.r;
      }
    }
  };
  const legacyRe =
    /([A-Za-z][A-Za-z\s\-']{1,38}?)\s+(\d+)\s*[xX]\s*(\d+)(?:\s*@\s*(\d+(?:\.\d+)?)\s*(kg|lbs?)?)?/gi;
  const resolveDayKey = (heading) => {
    const m = /(\d{1,2})\/(\d{1,2})/.exec(heading);
    if (!m || !ws) return null;
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const [wy, wm] = ws.split("-").map(Number);
    let y = wy;
    if (mo === 1 && wm === 12) y += 1;
    if (mo === 12 && wm === 1) y -= 1;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  for (const raw of String(md ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) {
      const name = h[1].trim().replace(/\s+/g, " ");
      if (DAY_HEADING.test(name)) {
        cur = ensureSec(name, resolveDayKey(name), null);
        curEx = null;
      } else {
        if (!cur) cur = ensureSec(null, rowKey ?? null, null);
        curEx = name;
      }
      continue;
    }
    const duration = /^\*\*Duration:\s*(\d+(?:\.\d+)?)\s*min\*\*$/i.exec(line);
    if (duration) {
      if (!cur) cur = ensureSec(null, rowKey ?? null, null);
      cur.durations.push(Number(duration[1]));
      continue;
    }
    // Same-session top-up marker ("**Top-up Fri 19/9**"): attribute what
    // follows to that day's existing section (or open a plain day section).
    // Never a new ## heading here: heatmap and Sessions must not double-count.
    const topup = /^\*\*Top-up\s+([A-Za-z]{3,9}\s+\d{1,2}\/\d{1,2})\*\*$/.exec(line);
    if (topup) {
      const key = resolveDayKey(topup[1]);
      cur = sections.find((x) => x.key !== null && x.key === key) ?? ensureSec(topup[1], key, null);
      curEx = null;
      continue;
    }
    let foundLegacy = false;
    // Same guard as progression.parseLifts: pair bullets start with a digit,
    // and the legacy pattern would misread "kg x" as an exercise name.
    const stripped = line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!/^\d/.test(stripped)) {
      for (const m of line.matchAll(legacyRe)) {
        const name = m[1].trim().replace(/\s+/g, " ");
        if (!name || !Number.isFinite(Number(m[2])) || !Number.isFinite(Number(m[3]))) continue;
        if (!cur) cur = ensureSec(null, rowKey ?? null, null);
        const e = exOf(cur, name);
        const load = m[4] !== undefined ? weightInKg(Number(m[4]), m[5]) : 0;
        e.sets += Number(m[2]);
        if (load > e.bestW) {
          e.bestW = load;
          e.bestR = Number(m[3]);
        }
        foundLegacy = true;
      }
    }
    if (foundLegacy || !curEx) continue;
    const pairs = parseSetPairs(stripped);
    if (pairs.length) addPairs(cur, curEx, pairs);
  }
  return sections.map((s) => ({
    header: s.header,
    key: s.key,
    rowId: s.rowId,
    durationMin: s.durations.length ? s.durations.reduce((sum, minutes) => sum + minutes, 0) : null,
    exercises: [...s.byEx.values()].map((e) => ({
      exercise: e.exercise,
      bestW: Math.round(e.bestW * 10) / 10,
      bestR: e.bestR,
      vol: Math.round(e.vol),
      sets: e.sets,
      pairs: e.pairs,
    })),
  }));
}

async function querySince(dbId, startISO, endISO) {
  const rows = [];
  let cursor;
  do {
    const res = await notion(`/databases/${dbId}/query`, "POST", {
      filter: {
        property: "Date",
        date: { on_or_after: startISO, on_or_before: endISO },
      },
      sorts: [{ property: "Date", direction: "ascending" }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

async function renderChart(chart, width, height) {
  const params = new URLSearchParams({
    c: JSON.stringify(chart),
    width: String(width),
    height: String(height),
    devicePixelRatio: "1",
    format: "png",
    backgroundColor: CARD_BG,
  });
  const url = `https://quickchart.io/chart?${params.toString()}`;
  const dl = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!dl.ok) throw new Error(`QuickChart -> ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
}

async function renderPng(chart, out, width = 1120, height = 840) {
  const image = await renderChart(chart, width, height);
  assertReportOutputPath(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image);
}

function xmlText(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}

async function renderWeeklyCard({ duration, groups, out, headline, periodLabel, weekNo, days }) {
  const width = 1120;
  const headerHeight = 212;
  const durationHeight = 320;
  const groupsHeight = 470;
  const [durationPng, groupsPng] = await Promise.all([
    renderChart(duration, width, durationHeight),
    renderChart(groups, width, groupsHeight),
  ]);
  const dayStrip = days
    .map((day, index) => {
      const x = 95 + index * 155;
      const color = day.status === "No log" ? "#89938B" : "#658B49";
      const fill = day.status === "Logged" ? "#DDE9D1" : "none";
      const marker = day.status === "Logged" ? "✓" : day.status === "Today" ? "·" : "–";
      return `<text x="${x}" y="164" text-anchor="middle" fill="#526056" font-family="Arial, Helvetica, sans-serif" font-size="12">${xmlText(day.weekday.toUpperCase())}</text><circle cx="${x}" cy="184" r="12" fill="${fill}" stroke="${color}" stroke-width="1.5"${day.status === "Upcoming" ? ' stroke-dasharray="3 3"' : ""}/><text x="${x}" y="189" text-anchor="middle" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="600">${marker}</text><text x="${x}" y="207" text-anchor="middle" fill="#68756A" font-family="Arial, Helvetica, sans-serif" font-size="10">${xmlText(day.status)}</text>`;
    })
    .join("");
  const header = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${headerHeight}"><rect width="100%" height="100%" fill="${CARD_BG}"/><text x="58" y="40" fill="#68756A" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="2.5">MYGYMBRO / WEEKLY REVIEW</text><text x="58" y="96" fill="#26332B" font-family="Arial, Helvetica, sans-serif" font-size="39" font-weight="600">${xmlText(headline)}</text><text x="58" y="128" fill="#526056" font-family="Arial, Helvetica, sans-serif" font-size="17">${xmlText(periodLabel)}</text><rect x="1000" y="27" width="66" height="66" rx="14" fill="#DDE9D1" stroke="#82996B"/><text x="1033" y="66" text-anchor="middle" fill="#405E35" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="600">W${weekNo ?? "—"}</text>${dayStrip}</svg>`,
  );
  const outHeight = headerHeight + durationHeight + groupsHeight;
  assertReportOutputPath(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp({
    create: { width, height: outHeight, channels: 4, background: CARD_BG },
  })
    .composite([
      { input: header, top: 0, left: 0 },
      { input: durationPng, top: headerHeight, left: 0 },
      { input: groupsPng, top: headerHeight + durationHeight, left: 0 },
    ])
    .png()
    .toFile(out);
}

const REPORT_GROUPS = ["Chest", "Back", "Legs", "Shoulders", "Biceps", "Triceps"];

/** Return only confidently identified muscle groups; one compound set may count in several. */
export function classifyReportGroups(exercise) {
  const name = canonicalExerciseName(exercise).toLowerCase().replace(/[-_]+/g, " ");
  const groups = new Set();
  const has = (pattern) => pattern.test(name);

  if (/\b(cindy|hill run|hill climbs?|run|sprint|cycle|swim|cardio)\b/.test(name)) return [];

  if (has(/bench|chest|push ?up|pushup|pec|fly|flye/)) groups.add("Chest");
  if (has(/row|lat pull|pull down|pulldown|pull ?up|pullup|deadlift|dead hang|shrug|kb swing/)) {
    groups.add("Back");
  }
  if (has(/squat|lunge|leg|calf|deadlift|kb swing/)) groups.add("Legs");
  if (has(/shoulder|overhead|ohp|shrug|dead hang|push ?up|pushup|bench|lateral raise/)) {
    groups.add("Shoulders");
  }
  if (has(/bicep|curl|row|lat pull|pull down|pulldown|pull ?up|pullup/)) groups.add("Biceps");
  if (has(/tricep|push ?down|pushdown|bench|push ?up|pushup|dip|overhead|ohp|shoulder press/)) {
    groups.add("Triceps");
  }

  return REPORT_GROUPS.filter((group) => groups.has(group));
}

/** Sum recorded sets by the groups each identified movement trains. */
export function loggedSetsByGroup(sections) {
  const counts = Object.fromEntries(REPORT_GROUPS.map((group) => [group, 0]));
  for (const section of sections ?? []) {
    for (const exercise of section.exercises ?? []) {
      for (const group of classifyReportGroups(exercise.exercise)) {
        counts[group] += exercise.sets ?? 0;
      }
    }
  }
  return counts;
}

export function countLoggedSets(sections) {
  return (sections ?? []).reduce(
    (total, section) =>
      total + (section.exercises ?? []).reduce((sum, exercise) => sum + (exercise.sets ?? 0), 0),
    0,
  );
}

export function loggedDurationByDay(sections, dayKeys) {
  const minutes = Object.fromEntries(dayKeys.map((day) => [day, 0]));
  for (const section of sections ?? []) {
    if (section.key && section.durationMin != null && section.key in minutes) {
      minutes[section.key] = (minutes[section.key] ?? 0) + section.durationMin;
    }
  }
  return dayKeys.map((day) => minutes[day]);
}

/** ISO calendar week number for the selected KL day key. */
export function isoWeekNumber(dayKey) {
  const date = new Date(`${dayKey}T12:00:00Z`);
  const mondayIndex = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayIndex + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4, 12));
  const firstMondayIndex = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstMondayIndex + 3);
  return 1 + Math.round((date - firstThursday) / (7 * 864e5));
}

const WEEKLY_MOTIVATION = [
  "Show up. Build on it.",
  "Small steps. Stronger weeks.",
  "Consistency makes progress.",
  "Train with intent.",
  "One session at a time.",
  "Keep the promise to yourself.",
  "Progress is earned in practice.",
  "A little better, each week.",
  "Strong habits make strong lifts.",
  "Steady work adds up.",
  "Make today's effort count.",
  "Build strength, one rep at a time.",
  "Keep going. Your work is showing.",
  "Good weeks start with showing up.",
  "Practice makes progress.",
  "Stay patient. Keep training.",
];

function weeklyMotivation(weekStart) {
  const anchor = Date.UTC(2020, 0, 5, 12);
  const current = Date.parse(`${weekStart}T12:00:00Z`);
  const index = Math.floor((current - anchor) / (7 * 864e5));
  const slot =
    ((index % WEEKLY_MOTIVATION.length) + WEEKLY_MOTIVATION.length) % WEEKLY_MOTIVATION.length;
  return WEEKLY_MOTIVATION[slot];
}

function reportCardChart({
  period,
  weekTitle,
  dayTitle,
  current,
  previous,
  currentLabel,
  previousLabel,
}) {
  const labels = REPORT_GROUPS;
  const datasets = [
    {
      label: currentLabel,
      data: labels.map((group) => current[group]),
      backgroundColor: "#658B49",
      borderColor: "#658B49",
      borderWidth: 0,
      barPercentage: 0.78,
      categoryPercentage: 0.72,
    },
  ];
  if (period === "week") {
    datasets.push({
      label: previousLabel,
      data: labels.map((group) => previous[group]),
      backgroundColor: "#AAB5A7",
      borderColor: "#AAB5A7",
      borderWidth: 0,
      barPercentage: 0.78,
      categoryPercentage: 0.72,
    });
  }

  const weekRange = weekTitle
    .replace(/^Week(?: \d+)?:?\s*(?:of\s*)?/, "")
    .replace(/\b20\d{2}\b/g, (year) => year.slice(2));
  const title =
    period === "day"
      ? ["MYGYMBRO / DAILY REVIEW", "One day at a time.", dayTitle]
      : ["WORKING SETS BY MUSCLE", `${currentLabel} vs ${previousLabel}`, weekRange];

  return {
    type: "bar",
    data: { labels, datasets },
    options: {
      title: {
        display: true,
        text: title,
        position: "top",
        fontColor: "#26332B",
        fontFamily: "Arial",
        fontSize: 21,
        padding: 22,
      },
      legend: {
        display: true,
        position: "bottom",
        labels: {
          fontColor: "#526056",
          fontSize: 12,
          boxWidth: 10,
          padding: 22,
          fontFamily: "Arial",
        },
      },
      layout: { padding: { top: 18, right: 42, bottom: 14, left: 24 } },
      scales: {
        xAxes: [
          {
            gridLines: { display: false },
            ticks: { fontColor: "#526056", fontSize: 12, padding: 10, fontFamily: "Arial" },
            scaleLabel: {
              display: true,
              labelString: "Working sets · compound movements may count in several groups",
              fontColor: "#68756A",
              fontSize: 11,
              fontFamily: "Arial",
            },
          },
        ],
        yAxes: [
          {
            ticks: {
              beginAtZero: true,
              precision: 0,
              fontColor: "#68756A",
              maxTicksLimit: 5,
              fontFamily: "Arial",
            },
            gridLines: { color: "rgba(54,70,58,0.12)", zeroLineColor: "rgba(54,70,58,0.2)" },
            scaleLabel: {
              display: true,
              labelString: "Sets",
              fontColor: "#68756A",
              fontSize: 11,
              fontFamily: "Arial",
            },
          },
        ],
      },
      tooltips: { enabled: true, mode: "index", intersect: false },
    },
  };
}

function durationLineChart({ dayLabels, minutes }) {
  const maxDuration = Math.max(60, ...minutes.filter(Number.isFinite));
  const max = Math.ceil(maxDuration / 15) * 15;
  return {
    type: "line",
    data: {
      labels: dayLabels,
      datasets: [
        {
          label: "Minutes per session",
          data: minutes,
          borderColor: "#658B49",
          backgroundColor: "rgba(101,139,73,0.14)",
          pointBackgroundColor: "#658B49",
          pointBorderColor: CARD_BG,
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 3,
          fill: true,
          spanGaps: false,
          lineTension: 0.25,
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: ["WORKOUT DURATION", "Total workout minutes by day · missing logs count as 0 min"],
        fontColor: "#26332B",
        fontFamily: "Arial",
        fontSize: 20,
        padding: 15,
      },
      legend: { display: false },
      layout: { padding: { top: 6, right: 40, bottom: 6, left: 24 } },
      scales: {
        xAxes: [
          {
            gridLines: { display: false },
            ticks: { fontColor: "#526056", fontSize: 13, padding: 8, fontFamily: "Arial" },
          },
        ],
        yAxes: [
          {
            ticks: {
              beginAtZero: true,
              max,
              stepSize: Math.max(15, max / 4),
              fontColor: "#68756A",
              fontSize: 11,
              fontFamily: "Arial",
            },
            gridLines: { color: "rgba(54,70,58,0.12)", zeroLineColor: "rgba(54,70,58,0.2)" },
            scaleLabel: {
              display: true,
              labelString: "Minutes",
              fontColor: "#68756A",
              fontSize: 11,
              fontFamily: "Arial",
            },
          },
        ],
      },
      tooltips: { enabled: true, mode: "index", intersect: false },
    },
  };
}

function monthRadarChart({ current, previous, currentLabel, previousLabel, hasPrevious }) {
  const currentScale = REPORT_GROUPS.map(
    (group) => Math.round((current.sets[group] / current.days) * 7 * 10) / 10,
  );
  const previousScale = hasPrevious
    ? REPORT_GROUPS.map((group) => Math.round((previous.sets[group] / previous.days) * 7 * 10) / 10)
    : [];
  const scaleMax = Math.max(
    10,
    Math.ceil(Math.max(...currentScale, ...(hasPrevious ? previousScale : [])) / 5) * 5,
  );
  const datasets = [];
  if (hasPrevious) {
    datasets.push({
      label: previousLabel,
      data: previousScale,
      backgroundColor: "rgba(170,181,167,0.2)",
      borderColor: "#8C998A",
      borderWidth: 2,
      pointBackgroundColor: "#8C998A",
      pointRadius: 3,
    });
  }
  datasets.push({
    label: currentLabel,
    data: currentScale,
    backgroundColor: "rgba(101,139,73,0.18)",
    borderColor: "#658B49",
    borderWidth: 3,
    pointBackgroundColor: "#658B49",
    pointRadius: 4,
  });
  return {
    type: "radar",
    data: { labels: REPORT_GROUPS, datasets },
    options: {
      title: {
        display: true,
        text: [
          "MYGYMBRO / MONTHLY REVIEW",
          "Muscle-group balance",
          "Average working sets per week · compound sets may count in multiple groups",
        ],
        position: "top",
        fontColor: "#26332B",
        fontFamily: "Arial",
        fontSize: 21,
        padding: 22,
      },
      legend: {
        display: true,
        position: "bottom",
        labels: {
          fontColor: "#526056",
          fontSize: 13,
          boxWidth: 10,
          padding: 18,
          fontFamily: "Arial",
        },
      },
      layout: { padding: { top: 20, right: 60, bottom: 22, left: 60 } },
      scale: {
        ticks: {
          beginAtZero: true,
          max: scaleMax,
          stepSize: scaleMax / 4,
          fontColor: "#68756A",
          fontSize: 11,
          fontFamily: "Arial",
          backdropColor: "rgba(243,244,239,0.9)",
        },
        pointLabels: { fontColor: "#526056", fontSize: 13, fontFamily: "Arial" },
        gridLines: { color: "rgba(54,70,58,0.12)" },
        angleLines: { color: "rgba(54,70,58,0.12)" },
      },
      tooltips: { enabled: true, mode: "point" },
    },
  };
}

function reportCardTakeaway({
  period,
  current,
  previous,
  totalSets,
  trainingDays,
  hasPrevious,
  currentLabel,
  previousLabel,
}) {
  const active = REPORT_GROUPS.filter((group) => current[group] > 0);
  if (totalSets === 0) {
    return trainingDays > 0
      ? "Training was logged, but no set totals could be parsed for this chart."
      : "No workout was logged in this period. The chart stays empty until the log has real sets.";
  }

  if (period === "day") {
    if (!active.length) {
      return `${totalSets} logged sets, but none matched a chart group confidently.`;
    }
    const leader = [...active].sort((a, b) => current[b] - current[a])[0];
    return `${totalSets} logged sets. ${leader} was the main focus with ${current[leader]} group-level sets.`;
  }
  if (period === "month") {
    if (!active.length) {
      return `${trainingDays} training day${trainingDays === 1 ? "" : "s"} · ${totalSets} logged sets. No exercise names matched the muscle groups confidently, so no radar values were guessed.`;
    }
    const leader = [...REPORT_GROUPS].sort((a, b) => current[b] - current[a])[0];
    return hasPrevious
      ? `${trainingDays} training day${trainingDays === 1 ? "" : "s"} · ${totalSets} logged sets. ${leader} received the most logged work in ${currentLabel}; the radar compares average weekly sets with ${previousLabel}.`
      : `${trainingDays} training day${trainingDays === 1 ? "" : "s"} · ${totalSets} logged sets. ${leader} received the most logged work. A month-to-month comparison appears when both months have classifiable set data.`;
  }
  if (!active.length) {
    return `${trainingDays} training day${trainingDays === 1 ? "" : "s"} · ${totalSets} logged sets. The exercise names could not be confidently matched to these muscle groups, so no bars were guessed.`;
  }

  const leader = [...REPORT_GROUPS].sort((a, b) => current[b] - current[a])[0];
  const least = [...REPORT_GROUPS].sort((a, b) => current[a] - current[b])[0];
  const delta = current[leader] - previous[leader];
  const comparison = hasPrevious
    ? `${leader} led with ${current[leader]} sets${delta ? `, ${delta > 0 ? "+" : ""}${delta} vs ${previousLabel}` : `, unchanged from ${previousLabel}`}.`
    : `${leader} led with ${current[leader]} sets. There is no previous-week workout data to compare.`;
  return `${trainingDays} training day${trainingDays === 1 ? "" : "s"} · ${totalSets} logged sets. ${comparison} Next focus: give ${least.toLowerCase()} a place in the routine.`;
}

async function main() {
  if (!TOKEN) throw new Error("NOTION_TOKEN is not set.");
  if (arg("style", "card") !== "card") throw new Error("Only --style card is supported.");
  const period = arg("period", "week").toLowerCase();
  if (!["day", "week", "month"].includes(period)) {
    throw new Error('Report card period must be "day", "week", or "month".');
  }
  const out = path.resolve(process.cwd(), arg("out", "data/report-card.png"));

  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  const workoutDb = cache["Workout Log"];
  if (!workoutDb)
    throw new Error("Workout Log id is missing from the cache. Run resolve-workspace first.");

  const today = new Date();
  const todayKey = dayKeyKL(today.toISOString());
  const requestedDate = arg("date", todayKey);
  if (period === "day") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      throw new Error("--date must be a calendar date in YYYY-MM-DD format.");
    }
    const parsedDate = new Date(`${requestedDate}T12:00:00Z`);
    if (
      !Number.isFinite(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== requestedDate
    ) {
      throw new Error(`--date is not a valid calendar date: ${requestedDate}`);
    }
  }
  const weekOffset =
    period === "week" ? Math.min(0, Number.parseInt(arg("week-offset", "0"), 10) || 0) : 0;
  if (period === "day" && process.argv.includes("--week-offset")) {
    throw new Error("Use --date for a daily card; --week-offset is only for weekly cards.");
  }
  const currentWeek = period === "week" && weekOffset === 0;
  const weekStart =
    period === "month"
      ? null
      : addDaysKL(
          sundayStartKL(period === "day" ? requestedDate : todayKey),
          (period === "day" ? 0 : weekOffset) * 7,
        );
  const currentMonthStart = period === "month" ? monthStartKL(todayKey, -1) : null;
  const previousMonthStart = period === "month" ? monthStartKL(todayKey, -2) : null;
  const monthEnd = period === "month" ? addDaysKL(monthStartKL(todayKey), -1) : null;
  const previousMonthEnd = period === "month" ? addDaysKL(currentMonthStart, -1) : null;
  const weekKeys =
    period === "month"
      ? []
      : period === "day"
        ? [requestedDate]
        : Array.from({ length: 7 }, (_, i) => addDaysKL(weekStart, i));
  const lastKeys =
    period === "week" ? Array.from({ length: 7 }, (_, i) => addDaysKL(weekStart, i - 7)) : [];
  const keys =
    period === "month" ? daysBetween(previousMonthStart, monthEnd) : [...lastKeys, ...weekKeys];
  // Include the week containing the first visible date so migrated weekly
  // records remain visible alongside current daily rows.
  const startISO = `${sundayStartKL(keys[0])}T00:00:00`;

  // Day sections from both migrated daily records and any legacy weekly rows.
  const sectionsThis = [];
  const sectionsLast = [];

  const endISO = `${keys[keys.length - 1]}T23:59:59`;
  const pages = await querySince(workoutDb, startISO, endISO);
  const readPage = async (page) => {
    const dateValue = prop(page, "Date")?.date;
    const k = dayKeyKL(dateValue?.start ?? today.toISOString());
    const rowEnd = dateValue?.end ? dayKeyKL(dateValue.end) : k;
    if (rowEnd < keys[0] || k > keys[keys.length - 1]) return [];
    let md;
    try {
      md = await blocksToMarkdown(page.id);
    } catch (err) {
      throw new Error(
        `Cannot build a complete report card because workout details for ${k} could not be read: ${err.message}`,
      );
    }
    const titleProp = Object.keys(page.properties ?? {}).find(
      (pk) => page.properties[pk]?.type === "title",
    );
    const title = titleProp
      ? (page.properties[titleProp].title ?? []).map((t) => t.plain_text).join("")
      : "Session";
    const parsedSections = parseWeekBody(md, k);
    const daySections = parsedSections.filter((section) => {
      if (period === "day") {
        return section.key === requestedDate || (!section.key && k === requestedDate);
      }
      if (period === "month") {
        if (!section.key || (dateValue?.end && !section.header)) return false;
        return section.key >= previousMonthStart && section.key <= monthEnd;
      }
      return true;
    });
    const rowDuration = prop(page, "Duration (min)")?.number;
    if (
      !dateValue?.end &&
      !/^Week of\b/i.test(title) &&
      Number.isFinite(rowDuration) &&
      rowDuration > 0
    ) {
      const dailySection = daySections.find((section) => section.key === k);
      if (dailySection && dailySection.durationMin == null) dailySection.durationMin = rowDuration;
    }
    for (const section of daySections) section.rowTitle = title;
    return daySections.map((section) => ({
      section,
      inWeek:
        period === "month"
          ? section.key >= currentMonthStart
          : period === "day" || weekKeys.includes(section.key ?? k),
    }));
  };
  const sectionsByPage = [];
  for (let i = 0; i < pages.length; i += 3) {
    sectionsByPage.push(...(await Promise.all(pages.slice(i, i + 3).map(readPage))));
  }
  for (const pageSections of sectionsByPage) {
    for (const { section, inWeek } of pageSections) {
      (inWeek ? sectionsThis : sectionsLast).push(section);
    }
  }

  const weekNo = period === "month" ? null : isoWeekNumber(addDaysKL(weekStart, 1));
  const weekTitle = period === "month" ? "" : formatWeekTitle(weekStart, null);
  const dayTitle = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${requestedDate}T12:00:00Z`));
  const comparablePrevious = currentWeek
    ? sectionsLast.filter((section) =>
        lastKeys.slice(0, weekdayIdxKL(todayKey) + 1).includes(section.key),
      )
    : sectionsLast;
  const currentSets = loggedSetsByGroup(sectionsThis);
  const previousSets = loggedSetsByGroup(period === "month" ? sectionsLast : comparablePrevious);
  const totalSets = countLoggedSets(sectionsThis);
  const trainingDays = new Set(
    sectionsThis.map((section) => section.key ?? section.header).filter(Boolean),
  ).size;
  const hasPrevious = Object.values(previousSets).some((count) => count > 0);
  const currentLabel =
    period === "month"
      ? monthTitle(currentMonthStart)
      : period === "day"
        ? "That day"
        : currentWeek
          ? "Week to date"
          : "Selected week";
  const previousLabel =
    period === "month"
      ? monthTitle(previousMonthStart)
      : currentWeek
        ? "last week"
        : "the week before";
  const cardCaption = reportCardTakeaway({
    period,
    current: currentSets,
    previous: previousSets,
    totalSets,
    trainingDays,
    hasPrevious,
    currentLabel,
    previousLabel,
  });
  if (period === "month" && trainingDays === 0) {
    console.log(`NO_REPORT No workouts were logged in ${currentLabel}.`);
    return;
  }
  const chart =
    period === "month"
      ? monthRadarChart({
          current: { sets: currentSets, days: daysBetween(currentMonthStart, monthEnd).length },
          previous: {
            sets: previousSets,
            days: daysBetween(previousMonthStart, previousMonthEnd).length,
          },
          currentLabel,
          previousLabel,
          hasPrevious,
        })
      : reportCardChart({
          period,
          weekTitle,
          dayTitle,
          current: currentSets,
          previous: previousSets,
          currentLabel,
          previousLabel: currentWeek ? "same days last week" : previousLabel,
        });
  const caption =
    period === "day"
      ? `${dayTitle} · ${cardCaption}`
      : period === "month"
        ? `${currentLabel} vs ${hasPrevious ? previousLabel : "no comparable prior month"} · ${cardCaption}`
        : `${weekTitle} · ${cardCaption}`;

  if (period === "week") {
    const dateLabel = (key) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        weekday: "short",
        day: "numeric",
      }).format(new Date(`${key}T12:00:00Z`));
    await renderWeeklyCard({
      duration: durationLineChart({
        dayLabels: weekKeys.map(dateLabel),
        minutes: loggedDurationByDay(sectionsThis, weekKeys).map((minutes, index) =>
          currentWeek && weekKeys[index] > todayKey ? null : minutes,
        ),
      }),
      groups: chart,
      out,
      headline: weeklyMotivation(weekStart),
      periodLabel: weekTitle.replace(/^Week(?: \d+)?:?\s*(?:of\s*)?/, ""),
      weekNo,
      days: weekKeys.map((key) => {
        const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" }).format(
          new Date(`${key}T12:00:00Z`),
        );
        const date = Number(key.slice(-2));
        const logged = sectionsThis.some((section) => section.key === key);
        return {
          weekday: `${weekday} ${date}`,
          status: logged
            ? "Logged"
            : currentWeek && key === todayKey
              ? "Today"
              : currentWeek && key > todayKey
                ? "Upcoming"
                : "No log",
        };
      }),
    });
  } else {
    await renderPng(chart, out);
  }

  const datedDir = path.resolve(process.cwd(), "data", "report-cards");
  const archiveName =
    period === "day"
      ? `${requestedDate}-daily.png`
      : period === "month"
        ? `${currentMonthStart}-monthly.png`
        : `${weekStart}-weekly.png`;
  const archivedOutput = path.join(datedDir, archiveName);
  assertReportOutputPath(archivedOutput);
  fs.mkdirSync(datedDir, { recursive: true });
  fs.copyFileSync(out, archivedOutput);

  const order = [
    "Chest",
    "Back",
    "Legs",
    "Shoulders",
    "Biceps",
    "Triceps",
    "Conditioning",
    "General",
  ];
  const tops = sectionsThis
    .flatMap((section) =>
      section.exercises.map((exercise) => ({
        ...exercise,
        axis: classifyExercise(exercise.exercise) ?? "General",
        exercise: canonicalExerciseName(exercise.exercise),
      })),
    )
    .sort((a, b) => order.indexOf(a.axis) - order.indexOf(b.axis) || b.bestW - a.bestW);
  for (const top of tops) {
    console.log(
      `TOP ${top.axis} | ${top.exercise} | best ${top.bestW}kg x ${top.bestR} | vol ${top.vol.toLocaleString("en-US")}kg`,
    );
  }

  const dayShort = (dayKey) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      weekday: "short",
      day: "numeric",
      month: "numeric",
    }).format(new Date(`${dayKey}T12:00:00Z`));
  const fmtSet = (pair) => `${pair.w}kg x ${pair.r}`;
  console.log("REPORT");
  console.log(
    period === "day"
      ? `*${dayTitle} · training log*`
      : period === "month"
        ? `*${currentLabel} · training log*`
        : `*${weekTitle} · training log*`,
  );
  if (!sectionsThis.length) {
    console.log(
      period === "day"
        ? "No workout was logged on this day."
        : period === "month"
          ? `No workout was logged in ${currentLabel}.`
          : "No workout was logged in this week.",
    );
  }
  for (const section of sectionsThis) {
    console.log(
      `*${section.header ?? `${dayShort(section.key ?? weekStart)} · ${section.rowTitle}`}*`,
    );
    for (const exercise of section.exercises) {
      const topLine = exercise.bestW > 0 ? `(Top set: ${exercise.bestW}kg)` : "(bodyweight)";
      console.log(`* ${exercise.exercise} ${topLine}`);
      for (const pair of exercise.pairs) console.log(fmtSet(pair));
      console.log("");
    }
  }
  console.log(
    `*Totals: ${trainingDays} training day${trainingDays === 1 ? "" : "s"}, ${totalSets} logged sets*`,
  );
  console.log(`CARD ${out}`);
  console.log(`CAPTION ${caption}`);
  console.log(`ARCHIVE ${datedDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`report-card failed: ${err.message}`);
    process.exit(1);
  });
}
