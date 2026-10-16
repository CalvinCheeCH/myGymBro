import assert from "node:assert/strict";
import { test } from "node:test";

let instance = 0;
const load = () => import(`../dist/notion/refresh.js?instance=${++instance}`);
const settle = () => new Promise(setImmediate);
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a staged display never runs before delivery flush and coalesces across chats", async () => {
  const queue = await load();
  const calls = [];
  queue.requestVisualRefresh("42", "dashboard", async () => {
    calls.push("old");
  });
  queue.requestVisualRefresh("42", "dashboard", async () => {
    calls.push("latest-a");
  });
  queue.requestVisualRefresh("99", "dashboard", async () => {
    calls.push("latest-b");
  });
  await settle();
  assert.deepEqual(calls, []);
  const first = queue.flushVisualRefreshes("42");
  const second = queue.flushVisualRefreshes("99");
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["latest-b"]);
});

test("an unacknowledged chat stays staged when another chat flushes", async () => {
  const queue = await load();
  const calls = [];
  queue.requestVisualRefresh("42", "dashboard", async () => {
    calls.push("delivered");
  });
  queue.requestVisualRefresh("99", "heatmap", async () => {
    calls.push("not-delivered");
  });
  await queue.flushVisualRefreshes("42");
  assert.deepEqual(calls, ["delivered"]);
  await queue.flushVisualRefreshes("99");
  assert.deepEqual(calls, ["delivered", "not-delivered"]);
});

test("a completion microtask restart runs only ready work and leaves unreplied intents staged", async () => {
  const queue = await load();
  const calls = [];
  queue.requestVisualRefresh("unreplied", "pending", async () => {
    calls.push("unreplied");
  });
  queue.requestVisualRefresh("42", "dashboard", async () => {
    calls.push("first");
    // Add ready work after the worker sees an empty queue but before its finally runs.
    queueMicrotask(() =>
      queueMicrotask(() => {
        queue.requestVisualRefresh("99", "heatmap", async () => {
          calls.push("delivered");
        });
        void queue.flushVisualRefreshes("99");
      }),
    );
  });
  await queue.flushVisualRefreshes("42");
  await settle();
  await settle();
  assert.deepEqual(calls, ["first", "delivered"]);
  await queue.flushVisualRefreshes("unreplied");
  assert.deepEqual(calls, ["first", "delivered", "unreplied"]);
});

test("requests arriving during a refresh cause one latest rerun without parallel writers", async () => {
  const queue = await load();
  const held = gate();
  const calls = [];
  let active = 0;
  let maximum = 0;
  queue.requestVisualRefresh("42", "dashboard", async () => {
    maximum = Math.max(maximum, ++active);
    calls.push("first");
    await held.promise;
    active--;
  });
  const running = queue.flushVisualRefreshes("42");
  await settle();
  for (const label of ["stale", "latest"]) {
    queue.requestVisualRefresh("99", "dashboard", async () => {
      maximum = Math.max(maximum, ++active);
      calls.push(label);
      active--;
    });
    void queue.flushVisualRefreshes("99");
  }
  queue.requestVisualRefresh("42", "heatmap", async () => {
    maximum = Math.max(maximum, ++active);
    calls.push("heatmap");
    active--;
  });
  void queue.flushVisualRefreshes("42");
  assert.deepEqual(calls, ["first"]);
  held.resolve();
  await running;
  assert.deepEqual(calls, ["first", "latest", "heatmap"]);
  assert.equal(maximum, 1);
});

test("a failed optional refresh is redacted and cannot poison later work", async (t) => {
  const queue = await load();
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  queue.requestVisualRefresh("42", "dashboard", async () => {
    throw new Error("synthetic failure sk-ant-syntheticSecretCanary123");
  });
  await queue.flushVisualRefreshes("42");
  let recovered = false;
  queue.requestVisualRefresh("42", "dashboard", async () => {
    recovered = true;
  });
  await queue.flushVisualRefreshes("42");
  assert.equal(recovered, true);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /syntheticSecretCanary/);
});

test("reset drains the current writer, discards stale jobs and releases the guard after errors", async () => {
  const queue = await load();
  const held = gate();
  const calls = [];
  queue.requestVisualRefresh("42", "dashboard", async () => {
    calls.push("in-flight");
    await held.promise;
  });
  const running = queue.flushVisualRefreshes("42");
  await settle();
  queue.requestVisualRefresh("42", "dashboard", async () => {
    calls.push("stale");
  });
  void queue.flushVisualRefreshes("42");
  const reset = queue.withVisualRefreshPaused(async () => {
    assert.equal(queue.isVisualRefreshPaused(), true);
    calls.push("reset");
    throw new Error("synthetic archive failure");
  });
  const failed = assert.rejects(reset, /synthetic archive failure/);
  queue.requestVisualRefresh("99", "heatmap", async () => {
    calls.push("during-reset");
  });
  await queue.flushVisualRefreshes("99");
  assert.deepEqual(calls, ["in-flight"]);
  held.resolve();
  await Promise.all([running, failed]);
  assert.equal(queue.isVisualRefreshPaused(), false);
  queue.requestVisualRefresh("42", "dashboard", async () => {
    calls.push("fresh");
  });
  await queue.flushVisualRefreshes("42");
  assert.deepEqual(calls, ["in-flight", "reset", "fresh"]);
});
