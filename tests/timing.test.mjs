import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  flushTimings,
  markReplyAccepted,
  measureTiming,
  recordTiming,
  retainTimingUntil,
  startTiming,
  withResponseTiming,
  withoutTiming,
} from "../dist/util/timing.js";

let directory;
let file;
const previousFile = process.env.RESPONSE_TIMING_FILE;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mygymbro-timing-"));
  file = path.join(directory, "timings.jsonl");
  process.env.RESPONSE_TIMING_FILE = file;
});
afterEach(async () => {
  await flushTimings();
  if (previousFile === undefined) Reflect.deleteProperty(process.env, "RESPONSE_TIMING_FILE");
  else process.env.RESPONSE_TIMING_FILE = previousFile;
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("mygymbro-timing-"));
  await fs.rm(directory, { recursive: true, force: true });
});
const records = async () => (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
const settle = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("stage timing records nested waits and accepted replies without serializing task data", async () => {
  const secret = "synthetic-private-chat-and-key";
  await withResponseTiming(
    "message",
    async () => {
      const finish = startTiming("queue_wait");
      finish();
      finish();
      assert.equal(
        await measureTiming("agent", async () => {
          recordTiming("prompt_preparation", 2);
          return measureTiming("tool", async () => secret, "run_script:notion.mjs");
        }),
        secret,
      );
      await measureTiming("telegram_send", async () => markReplyAccepted());
      markReplyAccepted();
    },
    Math.floor(Date.now() / 1000) - 1,
  );
  await flushTimings();
  const [record] = await records();
  assert.equal(record.kind, "message");
  assert.equal(record.error, false);
  assert.equal(record.background, false);
  assert.match(record.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(record.spans.filter((span) => span.stage === "queue_wait").length, 1);
  assert.equal(
    record.spans.find((span) => span.stage === "tool").operation,
    "run_script:notion.mjs",
  );
  assert.ok(record.telegramDeliveryLagMs >= 1000);
  assert.ok(record.firstReplyAcceptedMs <= record.lastReplyAcceptedMs);
  assert.ok(record.lastReplyAcceptedMs <= record.totalMs);
  assert.ok(record.spans.every((span) => span.startMs >= 0 && span.durationMs >= 0));
  assert.equal(JSON.stringify(record).includes(secret), false);
});

test("failed stages and tasks keep error text out of the record", async () => {
  await assert.rejects(
    withResponseTiming("callback", () =>
      measureTiming(
        "model_request",
        async () => {
          throw new Error("private server error");
        },
        "gemini-test",
      ),
    ),
    /private server error/,
  );
  await flushTimings();
  const [record] = await records();
  assert.equal(record.error, true);
  assert.equal(record.spans[0].error, true);
  assert.equal(record.spans[0].operation, "gemini-test");
  assert.equal(record.telegramDeliveryLagMs, undefined);
  assert.equal(JSON.stringify(record).includes("private server error"), false);
});

test("background rapid work retains the original trace after the acknowledgement returns", async () => {
  const gate = deferred();
  await withResponseTiming("message", async () => {
    markReplyAccepted();
    const background = measureTiming("agent", async () => {
      await gate.promise;
      recordTiming("tool", 1, "read_file");
      markReplyAccepted();
    });
    retainTimingUntil(background);
  });
  await flushTimings();
  await assert.rejects(fs.readFile(file), { code: "ENOENT" });
  gate.resolve();
  await settle();
  await flushTimings();
  const [record] = await records();
  assert.equal(record.background, true);
  assert.deepEqual(
    record.spans.map((span) => span.stage),
    ["tool", "agent"],
  );
  assert.ok(record.firstReplyAcceptedMs <= record.lastReplyAcceptedMs);
});

test("background failure is captured without an unhandled rejection or raw error", async () => {
  const gate = deferred();
  await withResponseTiming("message", async () => {
    retainTimingUntil(
      gate.promise.then(() => {
        throw new Error("private failure");
      }),
    );
  });
  gate.resolve();
  await settle();
  await flushTimings();
  const [record] = await records();
  assert.equal(record.error, true);
  assert.equal(JSON.stringify(record).includes("private failure"), false);
});

test("concurrent update contexts do not mix tool or model spans", async () => {
  const gate = deferred();
  const first = withResponseTiming("message", async () => {
    await gate.promise;
    recordTiming("tool", 3, "read_file");
  });
  await withResponseTiming("callback", async () => {
    recordTiming("model_request", 5, "gemini-example");
  });
  gate.resolve();
  await first;
  await flushTimings();
  const result = await records();
  assert.equal(result.length, 2);
  assert.notEqual(result[0].requestId, result[1].requestId);
  assert.deepEqual(
    result.find((record) => record.kind === "message").spans.map((span) => span.stage),
    ["tool"],
  );
  assert.deepEqual(
    result.find((record) => record.kind === "callback").spans.map((span) => span.stage),
    ["model_request"],
  );
});

test("optional displays and calls outside a trace do not extend reply timing", async () => {
  await measureTiming("tool", async () => undefined, "read_file");
  await withResponseTiming("message", async () => {
    await withoutTiming(() =>
      measureTiming("tool", async () => undefined, "run_script:notion.mjs"),
    );
    recordTiming("telegram_send", 1);
  });
  await flushTimings();
  const [record] = await records();
  assert.deepEqual(
    record.spans.map((span) => span.stage),
    ["telegram_send"],
  );
});

test("stage storage is bounded and arbitrary operation text is omitted", async () => {
  await withResponseTiming("message", async () => {
    recordTiming("tool", Number.NaN, "read_file");
    recordTiming("tool", -1, "read_file");
    for (let index = 0; index < 200; index++) recordTiming("tool", 1, "private name / token");
  });
  await flushTimings();
  const [record] = await records();
  assert.equal(record.spans.length, 160);
  assert.equal(record.droppedSpans, 40);
  assert.ok(record.spans.every((span) => span.operation === undefined));
  assert.equal(JSON.stringify(record).includes("private name"), false);
});

test("an unwritable timing destination never fails the request or prints its path", async () => {
  process.env.RESPONSE_TIMING_FILE = directory;
  const original = console.warn;
  const warnings = [];
  console.warn = (...values) => warnings.push(values.join(" "));
  try {
    assert.equal(await withResponseTiming("message", async () => 42), 42);
    await flushTimings();
    assert.deepEqual(warnings, ["[timing] Could not write response timings."]);
  } finally {
    console.warn = original;
  }
});
