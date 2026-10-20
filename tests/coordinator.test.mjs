import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { flushTimings, withResponseTiming } from "../dist/util/timing.js";

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

test("shutdown drain waits for accepted queued work even when an earlier task fails", async () => {
  const { enqueueChatRun, drainChatRuns } = await loadCoordinator();
  const gate = deferred();
  const order = [];
  const first = enqueueChatRun("42", async () => {
    await gate.promise;
    order.push("first");
    throw new Error("expected failure");
  });
  const failure = assert.rejects(first, /expected failure/);
  const next = enqueueChatRun("42", async () => order.push("next"));
  let drained = false;
  const drain = drainChatRuns().then(() => {
    drained = true;
  });
  await settle();
  assert.equal(drained, false);
  gate.resolve();
  await Promise.all([failure, next, drain]);
  assert.deepEqual(order, ["first", "next"]);
  assert.equal(drained, true);
});

async function captureQueueTiming(task) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mygymbro-queue-timing-"));
  const file = path.join(directory, "timings.jsonl");
  const previousFile = process.env.RESPONSE_TIMING_FILE;
  process.env.RESPONSE_TIMING_FILE = file;
  try {
    await task();
    await flushTimings();
    return (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  } finally {
    await flushTimings();
    if (previousFile === undefined) Reflect.deleteProperty(process.env, "RESPONSE_TIMING_FILE");
    else process.env.RESPONSE_TIMING_FILE = previousFile;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("mygymbro-queue-timing-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function queueSpan(record, stage) {
  const matches = record.spans.filter((span) => span.stage === stage);
  assert.equal(matches.length, 1, `expected one ${stage} span`);
  return matches[0];
}

test("timings distinguish a previous same-chat task from a provider-slot wait without reordering", async () => {
  const { enqueueChatRun } = await loadCoordinator();
  const gate = deferred();
  const order = [];
  const [record] = await captureQueueTiming(async () => {
    const first = enqueueChatRun("same-chat", async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-finish");
    });
    await settle();
    const second = withResponseTiming("message", () =>
      enqueueChatRun("same-chat", async () => order.push("second")),
    );
    await delay(30);
    assert.deepEqual(order, ["first-start"]);
    gate.resolve();
    await Promise.all([first, second]);
  });
  assert.deepEqual(order, ["first-start", "first-finish", "second"]);
  const chat = queueSpan(record, "chat_wait");
  const slot = queueSpan(record, "provider_slot_wait");
  const total = queueSpan(record, "queue_wait");
  assert.ok(chat.durationMs >= 20);
  assert.ok(chat.durationMs > slot.durationMs);
  assert.ok(slot.startMs >= chat.startMs + chat.durationMs - 0.2);
  assert.ok(total.durationMs >= chat.durationMs);
  assert.equal(JSON.stringify(record).includes("same-chat"), false);
});

test("timings attribute a third independent chat to the global provider slot rather than its chat chain", async () => {
  const { enqueueChatRun } = await loadCoordinator();
  const gate = deferred();
  const order = [];
  const [record] = await captureQueueTiming(async () => {
    const one = enqueueChatRun("one", async () => {
      order.push("one");
      await gate.promise;
    });
    const two = enqueueChatRun("two", async () => {
      order.push("two");
      await gate.promise;
    });
    await settle();
    const three = withResponseTiming("message", () =>
      enqueueChatRun("three", async () => order.push("three")),
    );
    await delay(30);
    assert.deepEqual(order, ["one", "two"]);
    gate.resolve();
    await Promise.all([one, two, three]);
  });
  assert.deepEqual(order, ["one", "two", "three"]);
  const chat = queueSpan(record, "chat_wait");
  const slot = queueSpan(record, "provider_slot_wait");
  const total = queueSpan(record, "queue_wait");
  assert.ok(slot.durationMs >= 20);
  assert.ok(slot.durationMs > chat.durationMs);
  assert.ok(total.durationMs >= slot.durationMs);
  assert.equal(JSON.stringify(record).includes('"three"'), false);
});

test("queue-full rejection retains its total error span without inventing chat or slot waits", async () => {
  const { enqueueChatRun, QueueFullError } = await loadCoordinator();
  const gate = deferred();
  const [record] = await captureQueueTiming(async () => {
    const accepted = Array.from({ length: 20 }, () =>
      enqueueChatRun("full-chat", async () => gate.promise),
    );
    await settle();
    await assert.rejects(
      withResponseTiming("message", () =>
        enqueueChatRun("full-chat", async () => assert.fail("rejected task ran")),
      ),
      QueueFullError,
    );
    gate.resolve();
    await Promise.all(accepted);
  });
  assert.equal(record.error, true);
  assert.deepEqual(
    record.spans.map((span) => span.stage),
    ["queue_wait"],
  );
  assert.equal(queueSpan(record, "queue_wait").error, true);
});
