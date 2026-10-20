import { execFile } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "../agent/tooling.js";
import { config } from "../config.js";

export type TodayPlan = {
  status: "planned" | "rest" | "missing" | "unavailable";
  date: string;
  text: string;
};
type Session = Pick<TodayPlan, "text"> & { status: "planned" | "rest" | "missing" };
const MISSING: Session = { status: "missing", text: "" };
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY =
  /^(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b\.?/i;

function plain(text: string): string {
  return text
    .replace(/[*_`]/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

/** A stated date takes precedence over its weekday label; conflicting labels are rejected. */
function dayLabel(label: string, date: string): boolean | null {
  const text = plain(label);
  const weekday = DAY.exec(text);
  if (!weekday && !/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/.test(text)) return null;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  const local = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/.exec(text);
  let statedDate: string | undefined = iso?.[1];
  if (!statedDate && local) {
    const year = local[3] ? (local[3].length === 2 ? `20${local[3]}` : local[3]) : date.slice(0, 4);
    statedDate = `${year}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
  }
  const remainder = weekday ? text.slice(weekday[0].length) : "";
  // A combined "Monday / Wednesday" section is not a unique daily session.
  if (/\b(sun|mon|tue|wed|thu|fri|sat)(day|sday|nesday|rsday|urday)?\b/i.test(remainder))
    return false;
  if (statedDate) {
    const parsed = new Date(`${statedDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== statedDate)
      return false;
    if (weekday && DAYS[parsed.getUTCDay()] !== weekday[1].slice(0, 3).toLowerCase()) return false;
    return statedDate === date;
  }
  if (!weekday) return null;

  return weekday[1].slice(0, 3).toLowerCase() === DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function session(text: string, focus: string): Session {
  const rest =
    /^(?:(?:rest|recovery|off)\s+day\b|active\s+recovery\b|no\s+(?:training|workout)\b)|^(?:rest|recovery|off)[.!]?$/i;
  const status = rest.test(plain(focus).split(/\r?\n/, 1)[0].trim()) ? "rest" : "planned";
  const suffix = "\n\n(Saved session shortened; see Weekly Plan for the full details.)";
  return { status, text: text.length > 3000 ? text.slice(0, 3000 - suffix.length) + suffix : text };
}

/** Extract saved content only: a single day section, otherwise a single Day/Date table row. */
export function extractTodaySession(markdown: string, date: string): Session {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return MISSING;
  let fenced = false;
  const lines = markdown.split(/\r?\n/).filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
  const headings = lines.flatMap((line, index) => {
    const match = /^\s*(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    return match ? [{ index, level: match[1].length, label: match[2] }] : [];
  });
  const matches = headings.filter((heading) => dayLabel(heading.label, date) === true);
  if (matches.length > 1) return MISSING;
  if (matches.length === 1) {
    const heading = matches[0];
    const next = headings.find(
      (other) =>
        other.index > heading.index &&
        (other.level <= heading.level || dayLabel(other.label, date) !== null),
    );
    const body = lines
      .slice(heading.index + 1, next?.index)
      .join("\n")
      .trim();
    const focus = plain(heading.label)
      .replace(DAY, "")
      .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, "")
      .replace(/^[\s:;,·()—–-]+/, "")
      .trim();
    if (!focus && !body) return MISSING;
    return session(`${heading.label}${body ? `\n${body}` : ""}`, focus || body);
  }

  const candidates: Session[] = [];
  let headers: string[] | undefined;
  let dayColumns: number[] = [];
  for (const line of lines) {
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      headers = undefined;
      continue;
    }
    const cells = line
      .trim()
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    if (!headers) {
      dayColumns = cells.flatMap((cell, index) =>
        /^(?:day|date|day\s*\/\s*date)$/i.test(plain(cell)) ? [index] : [],
      );
      if (dayColumns.length) headers = cells;
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const labels = dayColumns.map((column) => dayLabel(cells[column] ?? "", date));
    if (!labels.length || labels.some((label) => label !== true)) continue;
    if (cells.length !== headers.length) return MISSING;
    const details = cells.filter((cell, index) => !dayColumns.includes(index) && cell);
    if (!details.length) return MISSING;
    const focusColumn = headers.findIndex((header) =>
      /^(?:focus|session|workout|activity)$/i.test(plain(header)),
    );
    candidates.push(
      session(
        cells.map((cell, index) => `${headers![index]}: ${cell}`).join("\n"),
        focusColumn >= 0 ? cells[focusColumn] : details[0],
      ),
    );
  }
  return candidates.length === 1 ? candidates[0] : MISSING;
}

export async function readTodayPlan(_chatId: string, now = new Date()): Promise<TodayPlan> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const date = ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("-");
  if (!config.notionToken) return { ...MISSING, date };
  const sunday = new Date(`${date}T00:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  try {
    const markdown = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          path.join(PROJECT_ROOT, "scripts", "notion.mjs"),
          "weekly-plan",
          "--action",
          "show",
          "--week",
          sunday.toISOString().slice(0, 10),
        ],
        {
          cwd: PROJECT_ROOT,
          timeout: 6000,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    return { ...extractTodaySession(markdown, date), date };
  } catch {
    return { status: "unavailable", date, text: "" };
  }
}
