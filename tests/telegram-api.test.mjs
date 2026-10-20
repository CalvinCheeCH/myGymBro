import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { telegramApiTransformer } from "../dist/channel/telegram-api.js";
import { flushTimings, withResponseTiming } from "../dist/util/timing.js";

let outputDirectory;
before(async () => {
  outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mygymbro-telegram-api-"));
});
after(async () => {
  await flushTimings();
  assert.equal(path.dirname(outputDirectory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(outputDirectory).startsWith("mygymbro-telegram-api-"));
  await fs.rm(outputDirectory, { recursive: true, force: true });
});

async function record(task) {
  const previous = process.env.RESPONSE_TIMING_FILE;
  const file = path.join(outputDirectory, `${randomUUID()}.jsonl`);
  process.env.RESPONSE_TIMING_FILE = file;
  try {
    await withResponseTiming("message", task);
    await flushTimings();
    return JSON.parse((await fs.readFile(file, "utf8")).trim());
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "RESPONSE_TIMING_FILE");
    else process.env.RESPONSE_TIMING_FILE = previous;
  }
}
function assertPrivate(recorded) {
  const text = JSON.stringify(recorded);
  for (const privateValue of [
    "PRIVATE",
    "message_body",
    "chat_id",
    "Authorization",
    "error_message",
  ]) {
    assert.ok(!text.includes(privateValue), `timing record disclosed ${privateValue}`);
  }
  for (const span of recorded.spans) {
    assert.equal(span.operation, undefined);
    assert.ok(Number.isFinite(span.startMs));
    assert.ok(span.durationMs >= 0);
  }
}

for (const method of ["sendMessage", "sendPhoto", "sendDocument"]) {
  test(`successful ${method} records delivery and the accepted reply without recording its payload`, async () => {
    const payload = { chat_id: 42, text: "PRIVATE message_body Authorization", caption: "PRIVATE" };
    const signal = new AbortController().signal;
    const response = { ok: true, result: { message_id: 5, text: "PRIVATE" } };
    const recorded = await record(async () => {
      const actual = await telegramApiTransformer(
        async (actualMethod, actualPayload, actualSignal) => {
          assert.equal(actualMethod, method);
          assert.equal(actualPayload, payload);
          assert.equal(actualSignal, signal);
          return response;
        },
        method,
        payload,
        signal,
      );
      assert.equal(actual, response);
    });
    assert.deepEqual(
      recorded.spans.map((span) => span.stage),
      ["telegram_send"],
    );
    assert.ok(recorded.firstReplyAcceptedMs >= 0);
    assert.equal(recorded.firstReplyAcceptedMs, recorded.lastReplyAcceptedMs);
    assert.equal(recorded.spans[0].error, undefined);
    assertPrivate(recorded);
  });
}

test("callback acknowledgments and keyboard edits get separate stages but do not count as replies", async () => {
  const recorded = await record(async () => {
    for (const method of [
      "answerCallbackQuery",
      "editMessageReplyMarkup",
      "sendChatAction",
      "getMe",
    ]) {
      await telegramApiTransformer(async () => ({ ok: true, result: true }), method, {
        text: "PRIVATE message_body",
        chat_id: 42,
      });
    }
  });
  assert.deepEqual(
    recorded.spans.map((span) => span.stage),
    ["telegram_ack", "telegram_edit"],
  );
  assert.equal(recorded.firstReplyAcceptedMs, undefined);
  assert.equal(recorded.lastReplyAcceptedMs, undefined);
  assertPrivate(recorded);
});

test("failed API results and thrown transport errors mark their stage without accepting a reply", async () => {
  const failure = new Error("PRIVATE Authorization error_message");
  const recorded = await record(async () => {
    const response = { ok: false, error_code: 400, description: "PRIVATE error_message" };
    assert.equal(await telegramApiTransformer(async () => response, "sendMessage", {}), response);
    await assert.rejects(
      telegramApiTransformer(
        async () => {
          throw failure;
        },
        "sendPhoto",
        {},
      ),
      (error) => error === failure,
    );
    await telegramApiTransformer(async () => response, "answerCallbackQuery", {});
    await telegramApiTransformer(async () => response, "editMessageReplyMarkup", {});
  });
  assert.deepEqual(
    recorded.spans.map((span) => span.stage),
    ["telegram_send", "telegram_send", "telegram_ack", "telegram_edit"],
  );
  assert.ok(recorded.spans.every((span) => span.error === true));
  assert.equal(recorded.firstReplyAcceptedMs, undefined);
  assertPrivate(recorded);
});

test("getUpdates is passed through without timing or retries even when Telegram returns a quota error", async () => {
  let calls = 0;
  const response = {
    ok: false,
    error_code: 429,
    description: "PRIVATE error_message",
    parameters: { retry_after: 60 },
  };
  const signal = new AbortController().signal;
  const payload = { offset: 4, timeout: 30 };
  const recorded = await record(async () => {
    const actual = await telegramApiTransformer(
      async (method, actualPayload, actualSignal) => {
        calls++;
        assert.equal(method, "getUpdates");
        assert.equal(actualPayload, payload);
        assert.equal(actualSignal, signal);
        return response;
      },
      "getUpdates",
      payload,
      signal,
    );
    assert.equal(actual, response);
  });
  assert.equal(calls, 1);
  assert.deepEqual(recorded.spans, []);
  assert.equal(recorded.firstReplyAcceptedMs, undefined);
  assertPrivate(recorded);
});

test("Telegram flood-control waits honor retry_after plus 500ms and are measured separately", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const response = { ok: true, result: { message_id: 5 } };
  const recording = record(async () => {
    const actual = await telegramApiTransformer(
      async () => {
        calls++;
        return calls === 1
          ? { ok: false, error_code: 429, parameters: { retry_after: 2 } }
          : response;
      },
      "sendMessage",
      { chat_id: 42, text: "PRIVATE message_body" },
    );
    assert.equal(actual, response);
  });
  await immediate();
  assert.equal(calls, 1);
  context.mock.timers.tick(2_499);
  await immediate();
  assert.equal(calls, 1, "must not retry before the requested Telegram flood-control wait");
  context.mock.timers.tick(1);
  const recorded = await recording;
  assert.equal(calls, 2);
  assert.deepEqual(
    recorded.spans.map((span) => span.stage),
    ["telegram_send", "retry_wait", "telegram_send"],
  );
  assert.equal(recorded.spans[0].error, true);
  assert.equal(recorded.spans[2].error, undefined);
  assert.ok(recorded.firstReplyAcceptedMs >= 0);
  assertPrivate(recorded);
});

test("outgoing flood-control is capped at three retries and never treats a failed send as accepted", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const response = { ok: false, error_code: 429, parameters: { retry_after: 0 } };
  const recording = record(async () => {
    assert.equal(
      await telegramApiTransformer(
        async () => {
          calls++;
          return response;
        },
        "sendDocument",
        { chat_id: 42, document: "PRIVATE" },
      ),
      response,
    );
  });
  await immediate();
  for (let retry = 0; retry < 3; retry++) {
    assert.equal(calls, retry + 1);
    context.mock.timers.tick(500);
    await immediate();
  }
  const recorded = await recording;
  assert.equal(calls, 4);
  assert.equal(recorded.spans.filter((span) => span.stage === "retry_wait").length, 3);
  assert.ok(
    recorded.spans.filter((span) => span.stage === "telegram_send").every((span) => span.error),
  );
  assert.equal(recorded.firstReplyAcceptedMs, undefined);
  assertPrivate(recorded);
});

test("a missing Telegram retry hint retains the existing one-second plus 500ms fallback", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const recording = record(async () => {
    await telegramApiTransformer(
      async () => {
        calls++;
        return calls === 1 ? { ok: false, error_code: 429 } : { ok: true, result: true };
      },
      "answerCallbackQuery",
      {},
    );
  });
  await immediate();
  context.mock.timers.tick(1_499);
  await immediate();
  assert.equal(calls, 1);
  context.mock.timers.tick(1);
  const recorded = await recording;
  assert.equal(calls, 2);
  assert.deepEqual(
    recorded.spans.map((span) => span.stage),
    ["telegram_ack", "retry_wait", "telegram_ack"],
  );
  assert.equal(recorded.firstReplyAcceptedMs, undefined);
  assertPrivate(recorded);
});
