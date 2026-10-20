import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { BotError, GrammyError } from "grammy";

mock.module("../dist/channel/permissions.js", {
  namedExports: { isAllowed: (id) => id === 42 },
});
const { startPolling } = await import("../dist/channel/polling.js");

const update = (id, extra = {}) => ({
  update_id: id,
  message: { from: { id: 42 }, chat: { id: 42, type: "private" }, text: "hello", ...extra },
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await immediate();
  }
  assert.ok(check(), "polling state did not settle");
}
function harness(
  batches,
  handle = async () => {},
  errorHandler = async (error) => {
    throw error;
  },
) {
  const calls = [];
  const handled = [];
  const bot = {
    isInited: () => true,
    isRunning: () => false,
    api: {
      getUpdates: async (options, signal) => {
        calls.push(options);
        if (options.timeout === 0) return [update(999)];
        if (batches.length) {
          const next = batches.shift();
          if (next instanceof Error) throw next;
          if (typeof next === "function") return await next(options, signal);
          return next;
        }
        return await new Promise((resolve, reject) => {
          if (signal.aborted) return reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    },
    handleUpdate: async (value) => {
      handled.push(value.update_id);
      await handle(value);
    },
    errorHandler,
  };
  const polling = startPolling(bot);
  void polling.done.catch(() => {});
  return { ...polling, calls, handled, bot };
}

test("starts admitted updates in arrival order without awaiting an earlier AI handler", async () => {
  const first = deferred();
  const polling = harness([[update(1), update(2), update(3)]], async (value) => {
    if (value.update_id === 1) await first.promise;
  });
  await until(() => polling.handled.length === 3);
  assert.deepEqual(polling.handled, [1, 2, 3]);
  assert.deepEqual(polling.calls[0], {
    offset: 0,
    limit: 100,
    timeout: 30,
    allowed_updates: ["message", "callback_query"],
  });
  let stopped = false;
  const stopping = polling.stop().then(() => {
    stopped = true;
  });
  await immediate();
  assert.equal(stopped, false, "shutdown must drain running handlers");
  first.resolve();
  await stopping;
  assert.deepEqual(polling.calls.at(-1), { offset: 4, limit: 1, timeout: 0 });
  assert.ok(!polling.handled.includes(999), "final acknowledgment must not dispatch new work");
});

test("saturation keeps further authorized updates in Telegram rather than dropping or buffering them", async () => {
  const work = Array.from({ length: 33 }, deferred);
  const polling = harness(
    [Array.from({ length: 32 }, (_, i) => update(i + 1)), [update(33)]],
    (value) => work[value.update_id - 1].promise,
  );
  await until(() => polling.handled.length === 32);
  await immediate();
  assert.equal(polling.calls.length, 1, "full intake must not fetch and acknowledge more updates");
  work[0].resolve();
  await until(() => polling.handled.length === 33);
  assert.equal(polling.calls[1].limit, 100);
  assert.equal(polling.calls[1].offset, 2);
  assert.equal(polling.calls.length, 2);
  const stopping = polling.stop();
  for (const task of work) task.resolve();
  await stopping;
  assert.deepEqual(polling.calls.at(-1), { offset: 34, limit: 1, timeout: 0 });
});

test("filters strangers, groups, mismatched owners, unsupported updates and duplicate deliveries", async () => {
  const polling = harness([
    [
      update(1),
      update(1),
      update(2, { from: { id: 99 } }),
      update(3, { chat: { id: -42, type: "group" } }),
      update(4, { chat: { id: 99, type: "private" } }),
      { update_id: 5, edited_message: update(5).message },
      {
        update_id: 6,
        callback_query: { from: { id: 42 }, message: update(6).message, data: "qc:x:0" },
      },
      { update_id: 7, message: { from: { id: 42 } } },
      { update_id: 8, message: { chat: { id: 42, type: "private" } } },
      { update_id: "bad", message: update(9).message },
    ],
  ]);
  await until(() => polling.calls.length === 2);
  assert.deepEqual(polling.handled, [1, 6]);
  assert.equal(polling.calls[1].offset, 0);
  await polling.stop();
});

test("does not admit a batch received after shutdown began", async () => {
  const batch = deferred();
  const polling = harness([() => batch.promise]);
  const stopping = polling.stop();
  batch.resolve([update(1)]);
  await stopping;
  assert.deepEqual(polling.handled, []);
  assert.equal(polling.calls.length, 1);
});

test("routes middleware BotErrors through the installed bot.catch handler and keeps polling", async () => {
  const caught = [];
  const problem = new BotError(new Error("test handler failed"), {});
  const polling = harness(
    [[update(1), update(2)]],
    async (value) => {
      if (value.update_id === 1) throw problem;
    },
    (error) => {
      caught.push(error);
    },
  );
  await until(() => caught.length === 1 && polling.calls.length === 2);
  assert.equal(caught[0], problem);
  assert.deepEqual(polling.handled, [1, 2]);
  await polling.stop();
});

test("unhandled middleware failures stop intake, drain other work, and propagate through done and stop", async () => {
  const running = deferred();
  const failure = new Error("unhandled test failure");
  const polling = harness([[update(1), update(2)]], async (value) => {
    if (value.update_id === 1) await running.promise;
    else throw failure;
  });
  let settled = false;
  void polling.done
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await until(() => polling.handled.length === 2);
  await immediate();
  assert.equal(settled, false);
  running.resolve();
  await assert.rejects(polling.done, (error) => error === failure);
  await assert.rejects(polling.stop(), (error) => error === failure);
});

for (const code of [401, 409]) {
  test(`fatal Telegram ${code} does not retry and drains accepted work before rejecting`, async () => {
    const running = deferred();
    const failure = new GrammyError(
      "getUpdates",
      { ok: false, error_code: code, description: "test" },
      {},
    );
    const polling = harness([[update(1)], failure], () => running.promise);
    await until(() => polling.calls.length === 2);
    let rejected = false;
    void polling.done.catch(() => {
      rejected = true;
    });
    await immediate();
    assert.equal(rejected, false);
    running.resolve();
    await assert.rejects(polling.done, (error) => error === failure);
    assert.equal(polling.calls.length, 2);
  });
}

test("network retry waits are abortable and never print bot tokens from transport errors", async () => {
  const warnings = [];
  const warning = mock.method(console, "warn", (text) => {
    warnings.push(text);
  });
  const polling = harness([new Error("https://api.telegram.org/botPRIVATE/getUpdates")]);
  try {
    await until(() => warnings.length === 1);
    assert.match(warnings[0], /retrying in 3s/);
    assert.ok(!warnings[0].includes("PRIVATE"));
    await polling.stop();
    assert.equal(polling.calls.length, 1);
  } finally {
    warning.mock.restore();
  }
});

test("honors Telegram retry_after and can stop during a quota wait", async () => {
  const warnings = [];
  const warning = mock.method(console, "warn", (text) => {
    warnings.push(text);
  });
  const limited = new GrammyError(
    "getUpdates",
    {
      ok: false,
      error_code: 429,
      description: "rate limited",
      parameters: { retry_after: 7 },
    },
    {},
  );
  const polling = harness([limited]);
  try {
    await until(() => warnings.length === 1);
    assert.match(warnings[0], /retrying in 7s/);
    await polling.stop();
    assert.equal(polling.calls.length, 1);
  } finally {
    warning.mock.restore();
  }
});

test("requires initialized bot and refuses simultaneous built-in polling", () => {
  assert.throws(() => startPolling({ isInited: () => false }), /Initialize/);
  assert.throws(
    () => startPolling({ isInited: () => true, isRunning: () => true }),
    /already running/,
  );
});

test("does not allow two custom intake loops on the same bot", async () => {
  const polling = harness([]);
  assert.throws(() => startPolling(polling.bot), /already running/);
  await polling.stop();
  const restarted = startPolling(polling.bot);
  await restarted.stop();
});

test("an error thrown by bot.catch is propagated rather than silently losing the handler failure", async () => {
  const failure = new Error("test error handler failed");
  const polling = harness(
    [[update(1)]],
    async () => {
      throw new BotError(new Error("test middleware failed"), {});
    },
    async () => {
      throw failure;
    },
  );
  await assert.rejects(polling.done, (error) => error === failure);
});

test("shutdown propagates acknowledgment failure after draining completed work", async () => {
  const polling = harness([[update(1)]]);
  await until(() => polling.calls.length === 2);
  const failure = new Error("test acknowledgment failed");
  polling.bot.api.getUpdates = async () => {
    throw failure;
  };
  await assert.rejects(polling.stop(), (error) => error === failure);
});

const callback = (id) => ({
  update_id: id,
  callback_query: { from: { id: 42 }, message: update(id).message, data: "qc:x:0" },
});

test("completion watermark retains an unfinished oldest update while newer callbacks execute once", async () => {
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const repeated = [update(1), update(2), callback(3)];
  const polling = harness([[update(1), update(2)], repeated, repeated, repeated], async (value) => {
    if (value.update_id === 1) await first.promise;
    if (value.update_id === 2) await second.promise;
    if (value.update_id === 3) await third.promise;
  });
  await until(() => polling.handled.length === 3 && polling.calls.length === 3);
  assert.deepEqual(polling.handled, [1, 2, 3]);
  for (const call of polling.calls) {
    assert.equal(call.offset, 0, "must not acknowledge the oldest unfinished update");
    assert.equal(call.limit, 100, "must look beyond already-running IDs to see newer callbacks");
  }
  second.resolve();
  await until(() => polling.calls.length === 4);
  assert.equal(
    polling.calls[3].offset,
    0,
    "later completion must not advance past the unfinished head",
  );
  assert.deepEqual(
    polling.handled,
    [1, 2, 3],
    "running and completed duplicates must both be suppressed",
  );
  const stopping = polling.stop();
  first.resolve();
  third.resolve();
  await stopping;
  assert.deepEqual(polling.calls.at(-1), { offset: 4, limit: 1, timeout: 0 });
});

test("repeated known updates wait without spinning, and shutdown aborts the delayed repoll", async () => {
  const first = deferred();
  const polling = harness([[update(1)], [update(1)], [update(1)]], () => first.promise);
  await until(() => polling.calls.length === 2);
  await immediate();
  await immediate();
  assert.equal(polling.calls.length, 2, "a repeated response must not trigger a hot polling loop");
  assert.deepEqual(polling.handled, [1]);
  const stopping = polling.stop();
  first.resolve();
  await stopping;
  assert.equal(
    polling.calls.length,
    3,
    "stop should only add the final completed-prefix confirmation",
  );
  assert.deepEqual(polling.calls.at(-1), { offset: 2, limit: 1, timeout: 0 });
});
test("shutdown confirms only the admitted completed prefix, leaving overflow updates pending in Telegram", async () => {
  const pending = Array.from({ length: 32 }, deferred);
  const polling = harness(
    [Array.from({ length: 100 }, (_, index) => update(index + 1))],
    (value) => pending[value.update_id - 1].promise,
  );
  await until(() => polling.handled.length === 32);
  assert.equal(polling.calls.length, 1);
  const stopping = polling.stop();
  for (const work of pending) work.resolve();
  await stopping;
  assert.deepEqual(
    polling.handled,
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  assert.deepEqual(polling.calls.at(-1), { offset: 33, limit: 1, timeout: 0 });
});
