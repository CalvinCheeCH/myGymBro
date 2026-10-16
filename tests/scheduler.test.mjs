import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

// The scheduler is the only place the agent talks to the user unprompted, so the
// two side effects it owns (runAgent, sendMessage) are mocked and recorded.
// Requires --experimental-test-module-mocks (set on the npm test script).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-scheduler-"));

let scheduleFile = path.join(TMP_DIR, "schedule.json");
let mode = "webhook";
let ownerChatId = "";
let allowedUserIds = ["42", "99"];

mock.module("../dist/config.js", {
  namedExports: {
    config: {
      timezone: "Europe/London",
      get scheduleFile() {
        return scheduleFile;
      },
      get mode() {
        return mode;
      },
      get ownerChatId() {
        return ownerChatId;
      },
      get allowedUserIds() {
        return allowedUserIds;
      },
    },
  },
});

const agentCalls = [];
const sent = [];
let agentBehaviour = () => ({ text: "session ready" });

mock.module("../dist/agent/runner.js", {
  namedExports: {
    runAgent: async (opts) => {
      agentCalls.push(opts);
      return agentBehaviour(opts);
    },
  },
});

mock.module("../dist/channel/notify.js", {
  namedExports: {
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
  },
});

let instance = 0;
async function loadScheduler(opts = {}) {
  scheduleFile = path.join(TMP_DIR, `schedule-${++instance}.json`);
  mode = opts.mode ?? "webhook";
  ownerChatId = opts.ownerChatId ?? "";
  allowedUserIds = opts.allowedUserIds ?? ["42", "99"];
  if (opts.seed) fs.writeFileSync(scheduleFile, JSON.stringify(opts.seed));
  agentCalls.length = 0;
  sent.length = 0;
  agentBehaviour = opts.agent ?? (() => ({ text: "session ready" }));
  return import(`../dist/scheduler/scheduler.js?instance=${instance}`);
}

const task = (over = {}) => ({
  id: "morning",
  name: "Morning session nudge",
  cron: "0 8 * * *",
  prompt: "What is today's session?",
  chatId: "42",
  enabled: true,
  ...over,
});

test("executeTask sends the agent response to the task's chat", async () => {
  const scheduler = await loadScheduler({ agent: () => ({ text: "Legs today." }) });

  await scheduler.executeTask(task());

  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].chatId, "42");
  assert.equal(agentCalls[0].userMessage, "What is today's session?");
  assert.deepEqual(sent, [{ chatId: "42", text: "Legs today." }]);
});

test("an empty agent response still sends something rather than a blank message", async () => {
  const scheduler = await loadScheduler({ agent: () => ({ text: "" }) });

  await scheduler.executeTask(task());

  assert.equal(sent[0].text, "(no output)");
});

test("stored tasks cannot run or send reminders after a recipient is removed from the allowlist", async () => {
  const scheduler = await loadScheduler({
    allowedUserIds: ["42"],
    seed: [task({ chatId: "99" })],
  });
  await scheduler.initScheduler();
  await scheduler.executeTask(scheduler.getTask("morning"));
  for (const chatId of ["0", "-100123456", "not-a-private-id", "9007199254740993"]) {
    await scheduler.executeTask(task({ chatId }));
  }
  assert.equal(agentCalls.length, 0);
  assert.equal(sent.length, 0);
});

test("a failing task is reported to the chat instead of crashing the scheduler", async () => {
  const scheduler = await loadScheduler({
    agent: () => {
      throw new Error("connect ETIMEDOUT");
    },
  });

  await scheduler.executeTask(task({ name: "Sunday weekly plan" }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "42");
  assert.match(sent[0].text, /Sunday weekly plan.*failed.*ETIMEDOUT/);
});

test("seeds the default reminders when no schedule file exists and an owner is set", async () => {
  const scheduler = await loadScheduler({ ownerChatId: "99" });

  await scheduler.initScheduler();

  const ids = scheduler.listTasks().map((t) => t.id);
  assert.deepEqual(ids, ["morning-nudge", "weekly-plan"]);
  assert.ok(scheduler.listTasks().every((t) => t.chatId === "99"));
  assert.equal(JSON.parse(fs.readFileSync(scheduleFile, "utf-8")).length, 2);
});

test("seeds nothing when there is no owner chat to send reminders to", async () => {
  const scheduler = await loadScheduler();

  await scheduler.initScheduler();

  assert.deepEqual(scheduler.listTasks(), []);
});

test("webhook mode loads task definitions without starting in-process cron jobs", async () => {
  const scheduler = await loadScheduler({ seed: [task()] });

  await scheduler.initScheduler();

  assert.equal(scheduler.getTask("morning")?.name, "Morning session nudge");
  // No croner job was created, so nothing needs stopping; the external scheduler
  // drives reminders via /cron/run in this mode.
});

test("addTask persists the task and replaces one with the same id", async () => {
  const scheduler = await loadScheduler();
  await scheduler.initScheduler();

  scheduler.addTask(task());
  scheduler.addTask(task({ prompt: "Changed prompt" }));

  assert.equal(scheduler.listTasks().length, 1);
  assert.equal(scheduler.getTask("morning").prompt, "Changed prompt");
  assert.equal(JSON.parse(fs.readFileSync(scheduleFile, "utf-8"))[0].prompt, "Changed prompt");
});

test("removeTask stops a live cron job and reports whether the task existed", async () => {
  const scheduler = await loadScheduler({ mode: "polling" });
  await scheduler.initScheduler();
  // A daily 4am job: it will not fire during the test, and removeTask stops it.
  scheduler.addTask(task({ cron: "0 4 * * *" }));

  assert.equal(scheduler.removeTask("morning"), true);
  assert.equal(scheduler.removeTask("morning"), false);
  assert.deepEqual(scheduler.listTasks(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(scheduleFile, "utf-8")), []);
});

test("a corrupt schedule file falls back to the defaults instead of throwing", async () => {
  scheduleFile = path.join(TMP_DIR, `schedule-corrupt-${++instance}.json`);
  fs.writeFileSync(scheduleFile, "[not json");
  ownerChatId = "99";
  mode = "webhook";

  const scheduler = await import(`../dist/scheduler/scheduler.js?instance=corrupt-${instance}`);
  await scheduler.initScheduler();

  assert.equal(scheduler.listTasks().length, 2);
});

test("stale default prompts refresh on startup, preserving chatId and enabled", async () => {
  const scheduler = await loadScheduler({ ownerChatId: "99" });
  await scheduler.initScheduler();
  const current = scheduler.listTasks().find((t) => t.id === "morning-nudge");
  assert.equal(current.promptVersion, scheduler.DEFAULT_PROMPT_VERSION);

  // Simulate a v1 install: old prompt, user-disabled, custom chat.
  const stale = scheduler
    .listTasks()
    .map((t) =>
      t.id === "morning-nudge"
        ? { ...t, prompt: "Old prompt", promptVersion: 1, enabled: false, chatId: "123" }
        : t,
    );
  const refreshed = scheduler.refreshDefaultPrompts(stale);
  const morning = refreshed.find((t) => t.id === "morning-nudge");
  assert.equal(morning.prompt, current.prompt);
  assert.equal(morning.promptVersion, scheduler.DEFAULT_PROMPT_VERSION);
  assert.equal(morning.cron, "0 11 * * *");
  assert.equal(morning.enabled, false);
  assert.equal(morning.chatId, "123");

  // Current-version and custom tasks are untouched (same references back).
  const untouched = scheduler.refreshDefaultPrompts([
    ...refreshed,
    task({ id: "custom", promptVersion: undefined }),
  ]);
  assert.equal(untouched.find((t) => t.id === "custom").prompt, "What is today's session?");
});
