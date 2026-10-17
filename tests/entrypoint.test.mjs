import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bash =
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
const defaults = {
  SESSION_FILE: "/data/sessions.json",
  SCHEDULE_FILE: "/data/schedule.json",
  PERSONAS_FILE: "/data/personas.json",
  CUSTOM_PERSONAS_FILE: "/data/PERSONAS.md",
  RAPID_LEDGER_FILE: "/data/rapid-ledger.json",
  RUN_LOG_FILE: "/data/agent-runs.jsonl",
  GEMINI_HISTORY_FILE: "/data/gemini-history.json",
  OPENAI_HISTORY_FILE: "/data/openai-history.json",
  GOOGLE_TOKEN_FILE: "/data/google-token.json",
  GOOGLE_CALENDAR_FILE: "/data/google-calendar.json",
};

test("shell entrypoints and Git hook retain Linux-compatible line endings", () => {
  for (const name of ["entrypoint.sh", "scripts/deploy-cloudrun.sh", ".githooks/pre-push"]) {
    assert.equal(fs.readFileSync(path.join(root, name)).includes(13), false, name);
  }
});

test("container entrypoint uses persistent defaults and preserves explicit storage overrides", (t) => {
  if (process.platform === "win32" && !fs.existsSync(bash)) {
    t.skip("Git Bash is required to exercise the container entrypoint on Windows");
    return;
  }
  const script = [
    'mkdir() { [[ "$*" == "-p /data /data/.claude" ]]; }',
    "exec() {",
    '  [[ "$*" == "node dist/index.js" ]] || return 1',
    `  printf '%s\\n' ${Object.keys(defaults)
      .map((key) => `"$${key}"`)
      .join(" ")}`,
    "}",
    'source "$1"',
  ].join("\n");
  for (const overrides of [
    {},
    { SESSION_FILE: "/mounted/sessions.json", GOOGLE_CALENDAR_FILE: "/mounted/calendar.json" },
    { GOOGLE_CALENDAR_FILE: "" },
  ]) {
    const env = { ...process.env };
    for (const key of Object.keys(defaults)) delete env[key];
    Object.assign(env, overrides);
    const result = spawnSync(
      bash,
      ["-c", script, "entrypoint-test", path.join(root, "entrypoint.sh")],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(
      result.stdout.trim().split(/\r?\n/),
      Object.entries(defaults).map(([key, value]) => overrides[key] || value),
    );
  }
});
