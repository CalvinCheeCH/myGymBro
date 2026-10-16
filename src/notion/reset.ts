import fs from "node:fs";
import path from "node:path";
import {
  type ResetCalendarSnapshot,
  deleteResetCalendarEvents,
  previewCalendarReset,
} from "../calendar/reset.js";
import { config } from "../config.js";

const API = "https://api.notion.com/v1";
const API_VERSION = "2022-06-28";
const DATABASES = ["Workout Log", "Meal Log", "Body Stats", "Goals", "Programs"] as const;
const ID_CACHE = path.resolve(process.cwd(), "data", "notion-ids.json");

type DatabaseName = (typeof DATABASES)[number];
type NotionPage = { id: string };
type NotionBlock = { id: string; type: string; child_page?: { title?: string } };
type WorkspaceIds = Record<string, unknown>;

export type WeeklyPlanPage = { id: string; title: string; parent: string };
export type ResetSnapshot = {
  rows: Record<DatabaseName, NotionPage[]>;
  weeklyPlanPages: WeeklyPlanPage[];
  calendar: ResetCalendarSnapshot;
};
export type ResetPreview = {
  databases: Record<DatabaseName, number>;
  weeklyPlanPages: Array<Pick<WeeklyPlanPage, "title" | "parent">>;
  calendar: ResetCalendarSnapshot;
};

function workspaceIds(): WorkspaceIds {
  if (!config.notionToken) throw new Error("Notion is not configured.");
  if (!fs.existsSync(ID_CACHE)) {
    throw new Error("Notion workspace IDs are missing. Run /setup before resetting data.");
  }

  const ids = JSON.parse(fs.readFileSync(ID_CACHE, "utf8")) as WorkspaceIds;
  const foodLibraryId = ids["Food Library"];
  if (typeof foodLibraryId !== "string" || !/^[\da-f-]{32,36}$/i.test(foodLibraryId)) {
    throw new Error("Food Library ID is missing or invalid; reset stopped without changes.");
  }

  const targetIds = DATABASES.map((name) => ids[name]);
  if (
    targetIds.some((id) => typeof id !== "string" || !/^[\da-f-]{32,36}$/i.test(id)) ||
    new Set(targetIds).size !== DATABASES.length ||
    targetIds.includes(foodLibraryId)
  ) {
    throw new Error("Reset database IDs are missing, duplicated, or overlap Food Library.");
  }
  return ids;
}

async function notion<T>(pathname: string, method: "GET" | "POST" | "PATCH", body?: unknown) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${API}/${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Notion-Version": API_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as {
      message?: string;
      results?: T[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    if (response.ok) return result;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs =
        response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(
      `Notion ${method} ${pathname} failed (${response.status}): ${result.message ?? "unknown error"}`,
    );
  }
  throw new Error(`Notion ${method} ${pathname} failed after retries.`);
}

async function listRows(databaseId: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const result = await notion<NotionPage>(`databases/${databaseId}/query`, "POST", {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...(result.results ?? []));
    if (!result.has_more) break;
    if (!result.next_cursor) throw new Error("Notion pagination was incomplete; reset stopped.");
    cursor = result.next_cursor;
  } while (cursor);
  return pages;
}

async function currentRows(): Promise<Record<DatabaseName, NotionPage[]>> {
  const ids = workspaceIds();
  const rows = {} as Record<DatabaseName, NotionPage[]>;
  for (const name of DATABASES) rows[name] = await listRows(ids[name] as string);
  return rows;
}

async function listChildren(pageId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const result = await notion<NotionBlock>(
      `blocks/${pageId}/children${cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      "GET",
    );
    blocks.push(...(result.results ?? []));
    if (!result.has_more) break;
    if (!result.next_cursor)
      throw new Error("Notion page pagination was incomplete; reset stopped.");
    cursor = result.next_cursor;
  } while (cursor);
  return blocks;
}

function isDatedWeeklyPlan(title: string): boolean {
  const hasDate =
    /\b20\d{2}\b/.test(title) ||
    /\b\d{1,2}[/-]\d{1,2}\b/.test(title) ||
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i.test(
      title,
    );
  return (
    hasDate &&
    /^(?:weekly\s+plan|week\s+of|plan\s+for\s+week)\b/i.test(title.trim()) &&
    !/\b(?:program|reference|library|benchmark|imported)\b/i.test(title)
  );
}

async function findWeeklyPlanPages(): Promise<WeeklyPlanPage[]> {
  const ids = workspaceIds();
  const hubId = ids.__hub ?? config.notionParentPageId;
  if (typeof hubId !== "string" || !/^[\da-f-]{32,36}$/i.test(hubId)) {
    throw new Error("Notion Hub ID is missing or invalid; reset stopped without changes.");
  }

  const found: WeeklyPlanPage[] = [];
  const seen = new Set<string>();
  const scan = async (parentId: string, parentTitle: string, depth: number): Promise<void> => {
    if (depth > 3 || seen.has(parentId)) return;
    seen.add(parentId);
    for (const block of await listChildren(parentId)) {
      if (block.type !== "child_page" || !block.child_page?.title) continue;
      const title = block.child_page.title.trim();
      if (block.id === ids.__exerciseLibrary || title.toLowerCase() === "exercise library")
        continue;
      if (isDatedWeeklyPlan(title)) {
        found.push({ id: block.id, title, parent: parentTitle });
        continue;
      }
      const isKnownContainer =
        depth === 0 ||
        /^(?:knowledge base|weekly plans?|training plans?|plans?|training calendar)$/i.test(title);
      if (isKnownContainer) await scan(block.id, title, depth + 1);
    }
  };

  await scan(hubId, "Training Hub", 0);
  return found;
}

export async function prepareReset(): Promise<{ preview: ResetPreview; snapshot: ResetSnapshot }> {
  const rows = await currentRows();
  const weeklyPlanPages = await findWeeklyPlanPages();
  const calendar = await previewCalendarReset();
  const snapshot = { rows, weeklyPlanPages, calendar };
  return {
    snapshot,
    preview: {
      databases: Object.fromEntries(DATABASES.map((name) => [name, rows[name].length])) as Record<
        DatabaseName,
        number
      >,
      weeklyPlanPages: weeklyPlanPages.map(({ title, parent }) => ({ title, parent })),
      calendar,
    },
  };
}

export type ResetResult = {
  databases: Record<DatabaseName, number>;
  weeklyPlanPages: number;
  calendarEvents: number;
  calendarConfigured: boolean;
};

/** Archive progress/plans and delete plan events, retaining the schemas and libraries. */
export async function archiveResetData(snapshot: ResetSnapshot): Promise<ResetResult> {
  const counts = {} as Record<DatabaseName, number>;
  let lastArchiveAt = 0;

  for (const name of DATABASES) {
    let archived = 0;
    for (const page of snapshot.rows[name]) {
      // Keep below Notion's average request rate; transient 429s are retried above.
      const waitMs = Math.max(0, 350 - (Date.now() - lastArchiveAt));
      if (lastArchiveAt && waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      await notion(`pages/${page.id}`, "PATCH", { archived: true });
      lastArchiveAt = Date.now();
      archived++;
    }
    counts[name] = archived;
  }

  let archivedPlans = 0;
  for (const page of snapshot.weeklyPlanPages) {
    const waitMs = Math.max(0, 350 - (Date.now() - lastArchiveAt));
    if (lastArchiveAt && waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await notion(`pages/${page.id}`, "PATCH", { archived: true });
    lastArchiveAt = Date.now();
    archivedPlans++;
  }

  const calendarEvents = await deleteResetCalendarEvents(snapshot.calendar);
  return {
    databases: counts,
    weeklyPlanPages: archivedPlans,
    calendarEvents,
    calendarConfigured: snapshot.calendar.configured,
  };
}
