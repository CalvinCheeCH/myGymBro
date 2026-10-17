import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_FILE = path.resolve(process.cwd(), config.googleTokenFile);
const CALENDAR_FILE = path.resolve(process.cwd(), config.googleCalendarFile);

type TokenCache = { refresh_token?: string };
type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string };
  recurrence?: string[];
  recurringEventId?: string;
  extendedProperties?: { private?: Record<string, string> };
};

export type ResetCalendarEvent = {
  id: string;
  title: string;
  startsAt: string;
  tagged: boolean;
};

export type ResetCalendarSnapshot = {
  configured: boolean;
  calendarId: string;
  events: ResetCalendarEvent[];
};

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function refreshToken(): string {
  const cached = readJson(TOKEN_FILE) as TokenCache;
  return config.googleRefreshToken || cached.refresh_token || "";
}

function selectedCalendarId(): string {
  if (config.googleCalendarId) return config.googleCalendarId;
  const cachedId = readJson(CALENDAR_FILE).calendarId;
  return typeof cachedId === "string" && cachedId ? cachedId : "primary";
}

async function accessToken(): Promise<string> {
  const token = refreshToken();
  if (!config.googleClientId || !config.googleClientSecret || !token) {
    throw new Error("Google Calendar is not configured with OAuth credentials.");
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: token,
      grant_type: "refresh_token",
    }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !result.access_token) {
    throw new Error(
      `Google Calendar authentication failed: ${result.error_description ?? result.error ?? response.status}`,
    );
  }
  return result.access_token;
}

async function calendarRequest<T>(access: string, pathname: string, method = "GET"): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${API}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${access}` },
    });
    if (response.status === 204) return {} as T;
    const result = (await response.json().catch(() => ({}))) as T & {
      error?: { message?: string };
    };
    if (response.ok) return result;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new Error(
      `Google Calendar ${method} failed (${response.status}): ${result.error?.message ?? "unknown error"}`,
    );
  }
  throw new Error("Google Calendar request failed after retries.");
}

function isWorkoutPlanCandidate(event: CalendarEvent): boolean {
  // Preserve recurring training schedules. The weekly planner creates individual events.
  if (event.recurrence?.length || event.recurringEventId) return false;
  if (event.extendedProperties?.private?.myGymBroSource === "weekly-plan") return true;

  // Older weekly-plan events predate the source marker. Include likely workout
  // sessions in the preview so the owner can review their titles before confirming.
  const title = event.summary ?? "";
  const details = event.description ?? "";
  const workoutTitle =
    /\b(workout|training|gym|chest|back|legs?|shoulders?|arms?|push|pull|upper|lower|full body)\b/i.test(
      title,
    );
  const prescription =
    /\b\d+\s*[x×]\s*\d+\b|\b\d+(?:\.\d+)?\s*(?:kg|kgs|lb|lbs)\b|\b(?:sets?|reps?|bench|squat|deadlift|row|press|curl|pulldown|pull.?up|lunge|hip thrust)\b/i.test(
      details,
    );
  return workoutTitle && prescription;
}

export async function previewCalendarReset(): Promise<ResetCalendarSnapshot> {
  const calendarId = selectedCalendarId();
  if (!config.googleClientId || !config.googleClientSecret || !refreshToken()) {
    return { configured: false, calendarId, events: [] };
  }

  const access = await accessToken();
  const events: ResetCalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      maxResults: "2500",
      singleEvents: "false",
      showDeleted: "false",
      timeMin: "1970-01-01T00:00:00Z",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const result = await calendarRequest<{
      items?: CalendarEvent[];
      nextPageToken?: string;
    }>(access, `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
    for (const event of result.items ?? []) {
      if (!event.id || !isWorkoutPlanCandidate(event)) continue;
      events.push({
        id: event.id,
        title: event.summary ?? "(untitled workout event)",
        startsAt: event.start?.dateTime ?? event.start?.date ?? "unknown date",
        tagged: event.extendedProperties?.private?.myGymBroSource === "weekly-plan",
      });
    }
    pageToken = result.nextPageToken;
  } while (pageToken);

  return { configured: true, calendarId, events };
}

export async function deleteResetCalendarEvents(snapshot: ResetCalendarSnapshot): Promise<number> {
  if (!snapshot.configured || snapshot.events.length === 0) return 0;
  const access = await accessToken();
  let deleted = 0;
  for (const event of snapshot.events) {
    await calendarRequest(
      access,
      `/calendars/${encodeURIComponent(snapshot.calendarId)}/events/${encodeURIComponent(event.id)}`,
      "DELETE",
    );
    deleted++;
  }
  return deleted;
}
