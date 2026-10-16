import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { after, before, mock, test } from "node:test";

const botToken = "test-token-not-a-credential";
const telegramSecret = crypto.createHash("sha256").update(botToken).digest("hex");
const cronSecret = "test-cron-secret-not-a-credential";
mock.module("../dist/config.js", {
  namedExports: {
    config: { telegramBotToken: botToken, cronSecret, allowedUserIds: ["42"], port: 0 },
  },
});

let tasks = [];
const executed = [];
let execute = async () => {};
mock.module("../dist/scheduler/scheduler.js", {
  namedExports: {
    getTask: (id) => tasks.find((task) => task.id === id),
    listTasks: () => tasks,
    addTask: (task) => {
      tasks = [...tasks.filter((existing) => existing.id !== task.id), task];
    },
    removeTask: (id) => {
      const exists = tasks.some((task) => task.id === id);
      tasks = tasks.filter((task) => task.id !== id);
      return exists;
    },
    executeTask: async (task) => {
      executed.push(task);
      await execute(task);
    },
  },
});

const { startWebhookServer } = await import("../dist/channel/webhook-server.js");
const { startSchedulerServer } = await import("../dist/scheduler/server.js");
const updates = [];
let handleUpdate = async () => {};
let webhook;
let scheduler;

before(async () => {
  webhook = startWebhookServer({
    handleUpdate: async (update) => {
      updates.push(update);
      await handleUpdate(update);
    },
  });
  await once(webhook, "listening");
  // Test the production loopback binding without claiming its fixed control-plane port.
  const listen = http.Server.prototype.listen;
  const mockListen = mock.method(http.Server.prototype, "listen", function (_port, host, callback) {
    assert.equal(host, "127.0.0.1");
    return listen.call(this, 0, host, callback);
  });
  try {
    scheduler = startSchedulerServer();
  } finally {
    mockListen.mock.restore();
  }
  await once(scheduler, "listening");
});

after(async () => {
  for (const server of [webhook, scheduler]) {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function request(server, route, { method = "POST", body, headers = {}, slow = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: route,
        method,
        agent: false,
        headers: {
          "Content-Type": "application/json",
          ...(server === scheduler
            ? { Host: "127.0.0.1:9130" }
            : { "X-Telegram-Bot-Api-Secret-Token": telegramSecret }),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: text && JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (slow) {
      req.write('{"');
      return;
    }
    req.end(
      typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
    );
  });
}

const update = (id, extra = {}) => ({
  update_id: id,
  message: { from: { id: 42 }, chat: { id: 42, type: "private" }, text: "bench 60x12", ...extra },
});
const task = (id, extra = {}) => ({
  id,
  name: "Training reminder",
  cron: "0 8 * * *",
  prompt: "What is today's session?",
  chatId: "42",
  enabled: true,
  ...extra,
});
const cron = (body) =>
  request(webhook, "/cron/run", { body, headers: { Authorization: `Bearer ${cronSecret}` } });

test("unauthenticated webhook and cron calls never dispatch expensive work", async () => {
  assert.equal(
    (
      await request(webhook, "/webhook/telegram", {
        body: update(1),
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await request(webhook, "/cron/run", { body: { chatId: "42", prompt: "hello" } })).status,
    401,
  );
  assert.equal(updates.length, 0);
  assert.equal(executed.length, 0);
});

test("malformed JSON and JSON null do not crash either authenticated endpoint", async () => {
  for (const body of ["null", "[]", "1", "{broken"]) {
    assert.equal((await request(webhook, "/webhook/telegram", { body })).status, 400);
    assert.equal((await cron(body)).status, 400);
    assert.equal((await request(scheduler, "/tasks", { body })).status, 400);
  }
  assert.equal((await request(webhook, "/healthz", { method: "GET" })).status, 200);
});

test("Telegram ignores strangers and group chats, accepts private allowlisted updates once", async () => {
  const before = updates.length;
  for (const extra of [
    { from: { id: 99 } },
    { chat: { id: -1, type: "group" } },
    { chat: { id: 99, type: "private" } },
  ]) {
    assert.equal(
      (await request(webhook, "/webhook/telegram", { body: update(2, extra) })).status,
      200,
    );
  }
  assert.equal(updates.length, before);
  assert.equal(
    (await request(webhook, "/webhook/telegram", { body: update(3, { text: "💪" }) })).status,
    200,
  );
  assert.equal((await request(webhook, "/webhook/telegram", { body: update(3) })).status, 200);
  assert.equal(updates.length, before + 1);
  assert.equal(updates.at(-1).message.text, "💪");
});

test("public and local APIs reject oversized bodies without buffering or dispatching them", async () => {
  const before = updates.length;
  assert.equal(
    (await request(webhook, "/webhook/telegram", { body: "x".repeat(1024 * 1024 + 1) })).status,
    413,
  );
  assert.equal(
    (await request(scheduler, "/tasks", { body: "x".repeat(32 * 1024 + 1) })).status,
    413,
  );
  assert.equal(updates.length, before);
});

test("parallel updates cannot create more than 32 pending handlers and are retried after capacity returns", async () => {
  const releases = [];
  handleUpdate = () => new Promise((resolve) => releases.push(resolve));
  try {
    const replies = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(webhook, "/webhook/telegram", { body: update(100 + i) }),
      ),
    );
    assert.equal(releases.length, 32);
    assert.equal(replies.filter((reply) => reply.status === 200).length, 32);
    assert.equal(replies.filter((reply) => reply.status === 503).length, 8);
    assert.equal(replies.find((reply) => reply.status === 503).headers["retry-after"], "5");
  } finally {
    handleUpdate = async () => {};
    for (const release of releases) release();
  }
  await new Promise(setImmediate);
  assert.equal((await request(webhook, "/webhook/telegram", { body: update(139) })).status, 200);
});

test("cron validates payloads and denies both stored and ad hoc recipients outside the allowlist", async () => {
  tasks = [
    task("allowed"),
    task("disabled", { enabled: false }),
    task("forbidden", { chatId: "99" }),
  ];
  assert.equal((await cron({ taskId: "missing" })).status, 404);
  assert.equal((await cron({ taskId: "disabled" })).status, 409);
  assert.equal((await cron({ taskId: [] })).status, 400);
  assert.equal((await cron({ chatId: "42", prompt: { malicious: true } })).status, 400);
  assert.equal((await cron({ taskId: "forbidden" })).status, 403);
  assert.equal((await cron({ chatId: "99", prompt: "hello" })).status, 403);
  const before = executed.length;
  assert.equal((await cron({ taskId: "allowed" })).status, 200);
  assert.equal((await cron({ chatId: "42", prompt: "hello" })).status, 200);
  assert.equal(executed.length, before + 2);
});

test("cron collapses a running task retry and caps simultaneous scheduled jobs", async () => {
  tasks = [task("one"), task("two"), task("three")];
  const releases = [];
  execute = () => new Promise((resolve) => releases.push(resolve));
  try {
    assert.equal((await cron({ taskId: "one" })).status, 200);
    assert.equal((await cron({ taskId: "one" })).body.alreadyRunning, true);
    assert.equal((await cron({ taskId: "two" })).status, 200);
    assert.equal((await cron({ taskId: "three" })).status, 503);
    assert.equal(releases.length, 2);
  } finally {
    execute = async () => {};
    for (const release of releases) release();
  }
  await new Promise(setImmediate);
  assert.equal((await cron({ taskId: "three" })).status, 200);
});

test("scheduler rejects cross-site browser access and DNS rebinding hosts", async () => {
  for (const headers of [
    { Origin: "https://untrusted.example" },
    { "Sec-Fetch-Site": "cross-site" },
    { Host: "untrusted.example:9130" },
  ]) {
    assert.equal((await request(scheduler, "/tasks", { method: "GET", headers })).status, 403);
    assert.equal(
      (await request(scheduler, "/tasks", { method: "POST", body: task("blocked"), headers }))
        .status,
      403,
    );
  }
  assert.equal((await request(scheduler, "/tasks", { method: "GET" })).status, 200);
});

test("scheduler validates task fields, cron expressions and recipient before changing definitions", async () => {
  tasks = [];
  for (const change of [
    { name: [] },
    { prompt: " " },
    { cron: "invalid cron" },
    { enabled: "false" },
    { modelTier: "unknown" },
    { id: "../bad" },
  ]) {
    assert.equal((await request(scheduler, "/tasks", { body: task("bad", change) })).status, 400);
    assert.equal(tasks.length, 0);
  }
  assert.equal(
    (await request(scheduler, "/tasks", { body: task("forbidden", { chatId: "99" }) })).status,
    403,
  );
  assert.equal((await request(scheduler, "/tasks", { body: task("valid") })).status, 200);
  assert.equal(tasks[0].id, "valid");
  assert.equal((await request(scheduler, "/tasks/%ZZ", { method: "DELETE" })).status, 400);
  assert.equal((await request(scheduler, "/tasks/valid", { method: "DELETE" })).status, 200);
  assert.equal(tasks.length, 0);
});

test("scheduler bounds stored task count while allowing an existing task to be updated", async () => {
  tasks = Array.from({ length: 32 }, (_, i) => task(`task-${i}`));
  assert.equal((await request(scheduler, "/tasks", { body: task("overflow") })).status, 409);
  assert.equal(
    (await request(scheduler, "/tasks", { body: task("task-0", { prompt: "updated" }) })).status,
    200,
  );
  assert.equal(tasks.length, 32);
  assert.equal(tasks.find((task) => task.id === "task-0").prompt, "updated");
});

test("both HTTP surfaces cap connections, headers and idle/request lifetimes", () => {
  for (const server of [webhook, scheduler]) {
    assert.equal(server.headersTimeout, 5000);
    assert.equal(server.requestTimeout, 10000);
    assert.equal(server.timeout, 15000);
    assert.equal(server.maxHeadersCount, 32);
    assert.equal(server.maxRequestsPerSocket, 100);
    assert.ok(server.maxConnections <= 128);
  }
});

test(
  "slow request bodies are terminated with 408 on both surfaces",
  { timeout: 15000 },
  async () => {
    const results = await Promise.all([
      request(webhook, "/webhook/telegram", { slow: true }),
      request(scheduler, "/tasks", { slow: true }),
    ]);
    assert.ok(results.every((reply) => reply.status === 408));
  },
);
