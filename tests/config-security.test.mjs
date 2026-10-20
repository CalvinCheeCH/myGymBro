import assert from "node:assert/strict";
import { test } from "node:test";

let instance = 0;
async function loadConfig(options = {}) {
  process.env.TELEGRAM_BOT_TOKEN = "test-token-not-a-credential";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-auth-not-a-credential";
  process.env.ALLOWED_TELEGRAM_IDS = options.ids ?? "42";
  process.env.OWNER_CHAT_ID = options.owner ?? "";
  process.env.MODE = options.mode ?? "polling";
  process.env.PUBLIC_BASE_URL = options.url ?? "https://bot.example.invalid";
  process.env.CRON_SECRET = options.cronSecret ?? "test-cron-secret-with-at-least-32-characters";
  if (options.personalData === undefined)
    Reflect.deleteProperty(process.env, "RUN_LOG_PERSONAL_DATA");
  else process.env.RUN_LOG_PERSONAL_DATA = options.personalData;
  return import(`../dist/config.js?security-test=${++instance}`);
}

test("startup rejects an empty, nonnumeric, nonpositive or unsafe Telegram allowlist", async () => {
  for (const ids of ["", ", ", "0", "-1", "invalid", "42,invalid", "9007199254740993"]) {
    const { checkClaudeAuth } = await loadConfig({ ids });
    assert.throws(
      checkClaudeAuth,
      /ALLOWED_TELEGRAM_IDS must contain at least one positive numeric/,
    );
  }
});

test("startup accepts a numeric allowlist and an optional owner on that list", async () => {
  const single = await loadConfig();
  assert.doesNotThrow(single.checkClaudeAuth);
  const multiple = await loadConfig({ ids: "42, 99", owner: "99" });
  assert.deepEqual(multiple.config.allowedUserIds, ["42", "99"]);
  assert.doesNotThrow(multiple.checkClaudeAuth);
});

test("owner configuration cannot bypass the allowlist and errors omit its value", async () => {
  for (const owner of ["0", "-1", "private-owner-sentinel", "99", "9007199254740993"]) {
    const { checkClaudeAuth } = await loadConfig({ owner });
    assert.throws(checkClaudeAuth, (error) => {
      assert.match(error.message, /OWNER_CHAT_ID must be a positive numeric ID included/);
      assert.equal(error.message.includes(owner), false);
      return true;
    });
  }
});

test("webhook startup rejects a missing or short scheduler secret without exposing it", async () => {
  for (const cronSecret of ["", " ".repeat(32), "private-secret-sentinel", "x".repeat(31)]) {
    const { checkClaudeAuth } = await loadConfig({ mode: "webhook", cronSecret });
    assert.throws(checkClaudeAuth, (error) => {
      assert.match(error.message, /CRON_SECRET of at least 32 characters/);
      if (cronSecret.trim()) assert.equal(error.message.includes(cronSecret), false);
      return true;
    });
  }
  const allowed = await loadConfig({ mode: "webhook" });
  assert.doesNotThrow(allowed.checkClaudeAuth);
});

test("run log personal data requires explicit opt-in and is off by default", async () => {
  for (const personalData of [undefined, "false", "TRUE", "1"]) {
    const { config } = await loadConfig({ personalData });
    assert.equal(config.runLogPersonalData, false);
  }
  const { config } = await loadConfig({ personalData: "true" });
  assert.equal(config.runLogPersonalData, true);
});

test("the coach can read its instructions but cannot read internal development notes", async () => {
  const { executeCoachTool } = await import("../dist/agent/tooling.js");
  const instructions = await executeCoachTool("read_file", { path: "CLAUDE.md" }, "42");
  assert.equal(typeof instructions.content, "string");
  for (const path of ["PRD.md", "CODE_REVIEW.md"]) {
    const result = await executeCoachTool("read_file", { path }, "42");
    assert.equal(result.error, "That project path is not available to the coach.");
  }
});

test("Gemini interactive deadlines have safe defaults and reject invalid timer ranges", async () => {
  const names = ["GEMINI_REQUEST_TIMEOUT_MS", "GEMINI_RESPONSE_TIMEOUT_MS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) Reflect.deleteProperty(process.env, name);
    const defaults = await loadConfig();
    assert.equal(defaults.config.geminiRequestTimeoutMs, 20_000);
    assert.equal(defaults.config.geminiResponseTimeoutMs, 60_000);
    process.env.GEMINI_REQUEST_TIMEOUT_MS = "1500";
    process.env.GEMINI_RESPONSE_TIMEOUT_MS = "9000";
    const changed = await loadConfig();
    assert.equal(changed.config.geminiRequestTimeoutMs, 1500);
    assert.equal(changed.config.geminiResponseTimeoutMs, 9000);
    for (const name of names) {
      for (const invalid of ["0", "-1", "1.5", "invalid", "2147483648", "9007199254740993"]) {
        process.env[name] = invalid;
        await assert.rejects(loadConfig(), new RegExp(name));
      }
      process.env[name] = "1000";
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = previous[name];
    }
  }
});
