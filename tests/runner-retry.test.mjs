import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, mock, test } from "node:test";

// The runner drives the Agent SDK, so the SDK specifier is mocked before the
// compiled runner is imported. Requires --experimental-test-module-mocks (set on
// the npm test script). Config is read at import time, hence the dummy env and
// the temp session file: nothing here should touch the real data/ directory.
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-runner-"));
process.env.SESSION_FILE = path.join(TMP_DIR, "sessions.json");
process.env.RUN_LOG_FILE = path.join(TMP_DIR, "agent-runs.jsonl");

/**
 * Each test installs a script: one entry per expected query() call, describing
 * the messages that call yields and whether it then throws. calls records the
 * options the runner passed, so retry counts and resume are assertable.
 */
let script = [];
const calls = [];

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    createSdkMcpServer: (options) => options,
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    query: (args) => {
      const step = script[calls.length] ?? script[script.length - 1];
      calls.push(args);
      return (async function* () {
        for (const message of step.messages ?? []) yield message;
        if (step.throws) throw step.throws;
      })();
    },
  },
});

const { runAgent } = await import("../dist/agent/runner.js");
const { QUICK_CHOICE_INSTRUCTIONS } = await import("../dist/channel/quick-choices.js");

const initMessage = (sessionId) => ({ type: "system", subtype: "init", session_id: sessionId });
const resultMessage = (text) => ({ type: "result", subtype: "success", result: text });

beforeEach(() => {
  script = [];
  calls.length = 0;
});

test("returns the text carried by the result message", async () => {
  script = [{ messages: [initMessage("sess-1"), resultMessage("Squats today. Go.")] }];

  const response = await runAgent({ userMessage: "what today?", chatId: "chat-result" });

  assert.equal(response.text, "Squats today. Go.");
  assert.equal(response.sessionId, "sess-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.systemPrompt.append.split(QUICK_CHOICE_INSTRUCTIONS).length - 1, 1);
});

test("resumes the stored session on the next message from the same chat", async () => {
  script = [{ messages: [initMessage("sess-resume"), resultMessage("ok")] }];

  await runAgent({ userMessage: "first", chatId: "chat-resume" });
  await runAgent({ userMessage: "second", chatId: "chat-resume" });

  assert.equal(calls[0].options.resume, undefined);
  assert.equal(calls[1].options.resume, "sess-resume");
  for (const call of calls) {
    assert.equal(call.options.systemPrompt.append.split(QUICK_CHOICE_INSTRUCTIONS).length - 1, 1);
  }
});

test("retries a transient failure that happens before the session starts", async () => {
  const transient = new Error("connect ETIMEDOUT 160.79.104.10:443");
  script = [
    { throws: transient },
    { throws: transient },
    { messages: [initMessage("sess-late"), resultMessage("recovered")] },
  ];

  const response = await runAgent({ userMessage: "hi", chatId: "chat-transient" });

  assert.equal(response.text, "recovered");
  // MAX_QUERY_ATTEMPTS is 3: two retries after the initial attempt.
  assert.equal(calls.length, 3);
});

test("gives up after the third attempt and rethrows", async () => {
  script = [{ throws: new Error("fetch failed") }];

  await assert.rejects(runAgent({ userMessage: "hi", chatId: "chat-exhausted" }), /fetch failed/);
  assert.equal(calls.length, 3);
});

test("does not retry once a session exists (avoids duplicate Notion writes)", async () => {
  // The init message means the agent started and may already have run tools that
  // wrote to Notion. Retrying the whole query would replay those writes.
  script = [{ messages: [initMessage("sess-started")], throws: new Error("socket hang up") }];

  await assert.rejects(
    runAgent({ userMessage: "log 5x5 squats at 80kg", chatId: "chat-midflight" }),
    /socket hang up/,
  );
  assert.equal(calls.length, 1);
});

test("does not retry a non-transient failure", async () => {
  script = [{ throws: new Error("spawn claude ENOENT") }];

  await assert.rejects(runAgent({ userMessage: "hi", chatId: "chat-fatal" }), /ENOENT/);
  assert.equal(calls.length, 1);
});

test("reports a usage limit to the user instead of throwing", async () => {
  script = [{ throws: new Error("Claude AI usage limit reached") }];

  const response = await runAgent({ userMessage: "hi", chatId: "chat-limit" });

  assert.match(response.text, /usage limit/i);
  assert.equal(response.sessionId, undefined);
  assert.equal(calls.length, 1);
});

test("clears the session when the usage limit is hit, so the next turn starts fresh", async () => {
  script = [{ messages: [initMessage("sess-doomed"), resultMessage("ok")] }];
  await runAgent({ userMessage: "hi", chatId: "chat-limit-clear" });

  script = [{ throws: new Error("quota exceeded") }];
  calls.length = 0;
  await runAgent({ userMessage: "hi again", chatId: "chat-limit-clear" });

  script = [{ messages: [initMessage("sess-new"), resultMessage("ok")] }];
  calls.length = 0;
  await runAgent({ userMessage: "third", chatId: "chat-limit-clear" });

  assert.equal(calls[0].options.resume, undefined);
});

test("precomputed Claude reviews preserve the session but expose no tools or external MCP servers", async () => {
  script = [
    { messages: [initMessage("review-session"), resultMessage("Keep training consistently.")] },
  ];
  await runAgent({ userMessage: "earlier chat", chatId: "review-claude" });
  const response = await runAgent({
    userMessage: "/progress\nSaved workout facts.",
    chatId: "review-claude",
    toolsEnabled: false,
  });
  assert.equal(response.text, "Keep training consistently.");
  const options = calls.at(-1).options;
  assert.equal(options.resume, "review-session");
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, []);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(options.plugins, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.maxTurns, 1);
  assert.match(options.systemPrompt.append, /read-only coaching review/);
  const deny = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "mcp__other__write" });
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  await runAgent({ userMessage: "normal next question", chatId: "review-claude" });
  assert.ok(calls.at(-1).options.tools.includes("mcp__coach__run_script"));
  assert.equal(calls.at(-1).options.maxTurns, 60);
});

test("precomputed Claude review cannot report a blocked tool request as successful coaching", async () => {
  script = [
    {
      messages: [
        initMessage("review-denied"),
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "mcp__coach__run_script", input: {} }] },
        },
        resultMessage("Saved it."),
      ],
    },
  ];
  const response = await runAgent({
    userMessage: "Saved facts only",
    chatId: "review-claude-denied",
    toolsEnabled: false,
  });
  assert.equal(response.incomplete, true);
  assert.match(response.text, /couldn't finish the coaching review/);
  assert.doesNotMatch(response.text, /Saved it/);
  assert.equal(calls.length, 1);
});

test("Claude usage limits mark precomputed reviews incomplete without changing normal command behavior", async () => {
  script = [{ throws: new Error("Claude AI usage limit reached") }];
  const review = await runAgent({
    userMessage: "Saved workout facts.",
    chatId: "review-usage-limit",
    toolsEnabled: false,
  });
  assert.match(review.text, /usage limit/);
  assert.equal(review.incomplete, true);
  assert.equal(review.sessionId, undefined);
  const normal = await runAgent({
    userMessage: "A normal question.",
    chatId: "normal-usage-limit",
  });
  assert.match(normal.text, /usage limit/);
  assert.equal(normal.incomplete, undefined);
});
