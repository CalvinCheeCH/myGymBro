import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "calendar-reset-")));
const calendarFile = path.join(fixture, "volume", "google-calendar.json");
fs.mkdirSync(path.dirname(calendarFile));
fs.writeFileSync(calendarFile, JSON.stringify({ calendarId: "training@example.invalid" }));
const config = {
  googleClientId: "synthetic-client",
  googleClientSecret: "synthetic-secret",
  googleRefreshToken: "synthetic-refresh",
  googleTokenFile: path.join(fixture, "missing-token.json"),
  googleCalendarFile: calendarFile,
  googleCalendarId: "",
};
mock.module("../dist/config.js", { namedExports: { config } });
const { previewCalendarReset } = await import("../dist/calendar/reset.js");
after(() => {
  assert.equal(path.dirname(fixture), fs.realpathSync(os.tmpdir()));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("calendar reset uses the persistent selected calendar and honors an explicit id", async (t) => {
  let requestedCalendar;
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "synthetic-access" });
    }
    assert.equal(parsed.origin, "https://www.googleapis.com");
    assert.match(parsed.pathname, /^\/calendar\/v3\/calendars\/[^/]+\/events$/);
    requestedCalendar = decodeURIComponent(parsed.pathname.split("/")[4]);
    return Response.json({ items: [] });
  });
  for (const override of ["", "override@example.invalid"]) {
    config.googleCalendarId = override;
    const expected = override || "training@example.invalid";
    const snapshot = await previewCalendarReset();
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.calendarId, expected);
    assert.equal(requestedCalendar, expected);
  }
});
