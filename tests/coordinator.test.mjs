import assert from "node:assert/strict";
import { test } from "node:test";

let instance = 0;
const loadCoordinator = () => import(`../dist/agent/coordinator.js?instance=${++instance}`);
const settle = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("same-chat tasks stay in order and a failed task cannot block the next one", async () => {
  const { enqueueChatRun } = await loadCoordinator();
  const gate = deferred();
  const order = [];
  const first = enqueueChatRun("42", async () => {
    order.push("first");
    await gate.promise;
    throw new Error("expected failure");
  });
  const rejection = assert.rejects(first, /expected failure/);
  const second = enqueueChatRun("42", async () => {
    order.push("second");
    return "saved";
  });
  await settle();
  assert.deepEqual(order, ["first"]);
  gate.resolve();
  await rejection;
  assert.equal(await second, "saved");
  assert.deepEqual(order, ["first", "second"]);
});

test("at most two providers run across chats, including after a task throws", async () => {
  const { enqueueChatRun } = await loadCoordinator();
  const gate = deferred();
  const started = [];
  const one = enqueueChatRun("one", async () => {
    started.push("one");
    await gate.promise;
    throw new Error("expected failure");
  });
  const rejection = assert.rejects(one, /expected failure/);
  const two = enqueueChatRun("two", async () => {
    started.push("two");
    await gate.promise;
  });
  const three = enqueueChatRun("three", async () => started.push("three"));
  await settle();
  assert.deepEqual(started, ["one", "two"]);
  gate.resolve();
  await Promise.all([rejection, two, three]);
  assert.deepEqual(started, ["one", "two", "three"]);
});

test("per-chat cap counts running work, rejects without executing, and releases capacity", async () => {
  const { enqueueChatRun, QueueFullError } = await loadCoordinator();
  const gate = deferred();
  const calls = [];
  const accepted = Array.from({ length: 20 }, (_, i) =>
    enqueueChatRun("42", async () => {
      calls.push(i);
      await gate.promise;
      return i;
    }),
  );
  await settle();
  await assert.rejects(
    enqueueChatRun("42", async () => assert.fail("rejected task ran")),
    QueueFullError,
  );
  assert.deepEqual(calls, [0]);
  gate.resolve();
  assert.deepEqual(
    await Promise.all(accepted),
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert.equal(await enqueueChatRun("42", async () => "next"), "next");
});

test("total cap counts active and waiting chats and releases capacity after failure", async () => {
  const { enqueueChatRun, QueueFullError } = await loadCoordinator();
  const gate = deferred();
  let active = 0;
  let maximum = 0;
  const accepted = Array.from({ length: 64 }, (_, i) =>
    enqueueChatRun(`chat-${i}`, async () => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await gate.promise;
        if (i === 0) throw new Error("expected failure");
        return i;
      } finally {
        active--;
      }
    }),
  );
  const rejectedFirst = assert.rejects(accepted[0], /expected failure/);
  await settle();
  await assert.rejects(
    enqueueChatRun("overflow", async () => assert.fail("rejected task ran")),
    QueueFullError,
  );
  assert.equal(active, 2);
  gate.resolve();
  await Promise.all([rejectedFirst, ...accepted.slice(1)]);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(await enqueueChatRun("overflow", async () => "next"), "next");
});
