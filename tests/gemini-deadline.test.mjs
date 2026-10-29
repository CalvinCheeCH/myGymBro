import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-gemini-deadline-"));
const testConfig = {
  telegramBotToken: "test",
  geminiApiKey: "test-key",
  geminiModel: "gemini-test",
  agentName: "myGymBro",
  timezone: "Etc/UTC",
  sessionTtlHours: 12,
  geminiHistoryFile: path.join(TMP_DIR, "history.json"),
  geminiSmartRouting: false,
  geminiHeavyModels: [],
  geminiLightModels: [],
  geminiRequestTimeoutMs: 20_000,
  geminiResponseTimeoutMs: 60_000,
  geminiHeavyRequestTimeoutMs: 20_000,
  geminiHeavyResponseTimeoutMs: 60_000,
};
const generationCalls = [];
const discoveryCalls = [];
const toolCalls = [];
const timings = [];
let steps = [];
let listHandler;
let toolHandler;
let timerContext;
let caseId = 0;

mock.module("../dist/config.js", {
  namedExports: { pickEngine: () => "gemini", config: testConfig },
});
mock.module("../dist/agent/tooling.js", {
  namedExports: {
    PROJECT_ROOT: TMP_DIR,
    SCRIPT_NAMES: ["notion.mjs"],
    executeCoachTool: async (name, args, chatId) => {
      toolCalls.push({ name, args, chatId });
      return toolHandler ? toolHandler(name, args) : { saved: true, totalCalories: 370 };
    },
  },
});
mock.module("../dist/agent/personalities.js", {
  namedExports: {
    pickPersonality: () => ({ id: "normal" }),
    personaSystemPrompt: () => "",
  },
});
mock.module("../dist/agent/runlog.js", {
  namedExports: { appendRunRecord: async () => {}, summariseUsage: () => undefined },
});
mock.module("../dist/util/timing.js", {
  namedExports: {
    recordTiming: (stage, durationMs, operation) => timings.push({ stage, durationMs, operation }),
    measureTiming: async (stage, task, operation) => {
      const startedAt = Date.now();
      try {
        const value = task();
        if (stage === "retry_wait") timerContext.mock.timers.runAll();
        return await value;
      } finally {
        timings.push({ stage, durationMs: Date.now() - startedAt, operation });
      }
    },
  },
});
mock.module("@google/genai", {
  namedExports: {
    GoogleGenAI: class {
      models = {
        list: async (args) => {
          discoveryCalls.push(args);
          return listHandler ? listHandler(args) : (async function* () {})();
        },
        generateContent: async (args) => {
          generationCalls.push({ ...args, contents: structuredClone(args.contents) });
          const step = steps.shift();
          assert.ok(step, "unexpected model request");
          if (step instanceof Error) throw step;
          return typeof step === "function" ? step(args) : step;
        },
      };
    },
  },
});

beforeEach((context) => {
  timerContext = context;
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  caseId++;
  testConfig.geminiHeavyModels = [`gemini-deadline-${caseId}-primary`];
  testConfig.geminiRequestTimeoutMs = 20_000;
  testConfig.geminiResponseTimeoutMs = 60_000;
  testConfig.geminiHeavyRequestTimeoutMs = 20_000;
  testConfig.geminiHeavyResponseTimeoutMs = 60_000;
  testConfig.geminiSmartRouting = false;
  steps = [];
  listHandler = undefined;
  toolHandler = undefined;
  generationCalls.length = 0;
  discoveryCalls.length = 0;
  toolCalls.length = 0;
  timings.length = 0;
  for (const filename of ["gemini-last-good.json", "gemini-quotas.json"]) {
    fs.rmSync(path.join(TMP_DIR, "data", filename), { force: true });
  }
});
after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

const { runGeminiAgent } = await import("../dist/agent/gemini.js");
const answer = (text = "Ready.") => ({ candidates: [{ content: { parts: [{ text }] } }] });
const toolResponse = (count = 1) => ({
  candidates: [
    {
      content: {
        parts: Array.from({ length: count }, (_, index) => ({
          functionCall: {
            name: "run_script",
            args: { script: "notion.mjs", args: ["log-meal", `meal-${index}`] },
          },
          thoughtSignature: `signature-${index}`,
        })),
      },
    },
  ],
});
const run = (extra = {}) =>
  runGeminiAgent({
    userMessage: "Save the meal and tell me what remains.",
    chatId: `deadline-chat-${caseId}`,
    ...extra,
  });
const waits = () => timings.filter(({ stage }) => stage === "retry_wait");
const assertDeadline = (args, timeout, message) => {
  assert.ok(
    args.config.abortSignal instanceof AbortSignal,
    "SDK must receive a cancellable signal",
  );
  assert.equal(args.config.httpOptions.timeout, Math.max(10_000, timeout), message);
  assert.equal(
    args.config.httpOptions.retryOptions.attempts,
    1,
    "SDK must not silently retry requests",
  );
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const waitForAbort = (signal) =>
  new Promise((_, reject) => {
    assert.ok(signal instanceof AbortSignal);
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

/** A run with smart routing off is on the heavy chain: set both budget pairs. */
const setBudgets = (requestMs, responseMs) => {
  testConfig.geminiRequestTimeoutMs = requestMs;
  testConfig.geminiResponseTimeoutMs = responseMs;
  testConfig.geminiHeavyRequestTimeoutMs = requestMs;
  testConfig.geminiHeavyResponseTimeoutMs = responseMs;
};

test("Gemini interactive discovery and generation send bounded cancellable SDK requests without hidden retries", async () => {
  steps = [answer()];
  assert.equal((await run()).text, "Ready.");
  assertDeadline(discoveryCalls[0], 5000);
  assertDeadline(generationCalls[0], 20_000);
  assert.equal(generationCalls[0].config.abortSignal.aborted, false);
  timerContext.mock.timers.tick(25_000);
  assert.equal(
    generationCalls[0].config.abortSignal.aborted,
    false,
    "successful calls clear their deadline timer",
  );
});

test("Gemini heavy-context runs get their own larger request and response budgets", async () => {
  testConfig.geminiHeavyRequestTimeoutMs = 120_000;
  testConfig.geminiHeavyResponseTimeoutMs = 600_000;
  const entered = deferred();
  steps = [
    (args) => {
      entered.resolve();
      return waitForAbort(args.config.abortSignal);
    },
  ];
  const startedAt = Date.now();
  const pending = run();
  await entered.promise;
  assertDeadline(generationCalls[0], 120_000);
  assert.equal(generationCalls[0].config.httpOptions.timeout, 120_000);
  timerContext.mock.timers.tick(119_999);
  assert.equal(
    generationCalls[0].config.abortSignal.aborted,
    false,
    "a heavy generation must keep running past the fast-tier limit",
  );
  timerContext.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(Date.now() - startedAt, 120_000);
  assert.equal(generationCalls[0].config.abortSignal.aborted, true);
  assert.equal(waits().length, 0);
});

test("Gemini smart routing keeps quick logs on the fast budget and upgrades photo runs to the heavy budget", async () => {
  testConfig.geminiSmartRouting = true;
  testConfig.geminiHeavyRequestTimeoutMs = 120_000;
  testConfig.geminiHeavyResponseTimeoutMs = 600_000;
  testConfig.geminiLightModels = [`gemini-deadline-${caseId}-light`];
  steps = [answer("Logged."), answer("Analysed the meal photo.")];
  await run({ modelTier: "fast", userMessage: "just ate chicken and rice" });
  assertDeadline(generationCalls[0], 20_000, "quick logs keep the fast-tier budget");
  await run({
    modelTier: "fast",
    userMessage: "Work out the calories in this.",
    attachments: [{ mediaType: "image/jpeg", data: "aGVsbG8=" }],
  });
  assertDeadline(
    generationCalls[1],
    120_000,
    "photo runs ride the heavy chain and its larger budget",
  );
});

test("Gemini aborts a stalled model at 20 seconds and immediately uses the next model", async () => {
  const entered = deferred();
  const primary = testConfig.geminiHeavyModels[0];
  const fallback = `gemini-deadline-${caseId}-fallback`;
  testConfig.geminiHeavyModels.push(fallback);
  steps = [
    (args) => {
      entered.resolve();
      return waitForAbort(args.config.abortSignal);
    },
    answer("Fallback answered."),
  ];
  const startedAt = Date.now();
  const pending = run();
  await entered.promise;
  timerContext.mock.timers.tick(19_999);
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].config.abortSignal.aborted, false);
  timerContext.mock.timers.tick(1);
  assert.equal((await pending).text, "Fallback answered.");
  assert.equal(Date.now() - startedAt, 20_000);
  assert.equal(generationCalls[0].config.abortSignal.aborted, true);
  assert.deepEqual(
    generationCalls.map(({ model }) => model),
    [primary, fallback],
  );
  assert.equal(waits().length, 0, "request deadlines must not add transient retry sleeps");
});

test("Gemini request deadline fallback carries completed tool results without repeating a save", async () => {
  const entered = deferred();
  testConfig.geminiHeavyModels.push(`gemini-deadline-${caseId}-fallback`);
  steps = [
    toolResponse(),
    (args) => {
      entered.resolve();
      return waitForAbort(args.config.abortSignal);
    },
    answer("Already saved."),
  ];
  const pending = run();
  await entered.promise;
  timerContext.mock.timers.tick(20_000);
  assert.equal((await pending).text, "Already saved.");
  assert.equal(toolCalls.length, 1);
  assert.equal(generationCalls.length, 3);
  const contents = generationCalls[2].contents;
  assert.equal(contents.at(-2).parts[0].thoughtSignature, "signature-0");
  assert.deepEqual(contents.at(-1).parts[0].functionResponse.response, {
    saved: true,
    totalCalories: 370,
  });
  assert.equal(waits().length, 0);
});

test("Gemini exhausted model chain returns an incomplete time-limit response and preserves the user question", async () => {
  const entered = deferred();
  steps = [
    (args) => {
      entered.resolve();
      return waitForAbort(args.config.abortSignal);
    },
  ];
  const pending = run({ userMessage: "Please compare upper and lower body sessions." });
  await entered.promise;
  timerContext.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(generationCalls.length, 1);
  assert.equal(waits().length, 0);
  timerContext.mock.timers.tick(31_000);
  steps = [answer("We were comparing upper and lower body sessions.")];
  await run({ userMessage: "Continue, please." });
  assert.ok(
    generationCalls
      .at(-1)
      .contents.some((content) =>
        content.parts.some((part) =>
          part.text?.includes("Please compare upper and lower body sessions."),
        ),
      ),
  );
});

test("Gemini total interactive budget includes model discovery and reduces the remaining request deadline", async () => {
  listHandler = () => {
    timerContext.mock.timers.tick(4000);
    return (async function* () {})();
  };
  testConfig.geminiResponseTimeoutMs = 13_000;
  testConfig.geminiHeavyResponseTimeoutMs = 13_000;
  steps = [answer()];
  assert.equal((await run()).text, "Ready.");
  assertDeadline(discoveryCalls[0], 5000);
  assertDeadline(generationCalls[0], 9000);
});

test("Gemini stops new model calls when completed tool rounds consume the total 60 second budget", async () => {
  const startedAt = Date.now();
  steps = Array.from({ length: 3 }, () => () => {
    timerContext.mock.timers.tick(19_000);
    return toolResponse();
  });
  toolHandler = () => {
    timerContext.mock.timers.tick(1000);
    return { saved: true };
  };
  const result = await run();
  assert.equal(Date.now() - startedAt, 60_000);
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(generationCalls.length, 3);
  assert.equal(toolCalls.length, 3);
  assert.equal(waits().length, 0);
});

test("Gemini lets an in-flight save finish past budget, skips remaining batch calls, and retains valid followup history", async () => {
  const entered = deferred();
  const release = deferred();
  steps = [toolResponse(2)];
  toolHandler = async () => {
    entered.resolve();
    await release.promise;
    return { saved: true, recordId: "fictional-meal" };
  };
  let settled = false;
  const pending = run().finally(() => {
    settled = true;
  });
  await entered.promise;
  timerContext.mock.timers.tick(61_000);
  await Promise.resolve();
  assert.equal(
    settled,
    false,
    "do not release the conversation queue while a save remains in flight",
  );
  assert.equal(toolCalls.length, 1);
  release.resolve();
  const result = await pending;
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(generationCalls.length, 1);
  assert.equal(toolCalls.length, 1, "remaining writes must not begin after the budget");

  steps = [answer("The first meal was already saved; the second was not executed.")];
  const followup = await run({ userMessage: "What was saved?" });
  assert.match(followup.text, /already saved/);
  assert.equal(toolCalls.length, 1, "followup must reuse the completed write context");
  const contents = generationCalls.at(-1).contents;
  const callTurn = contents.findIndex((content) => content.parts.some((part) => part.functionCall));
  assert.notEqual(callTurn, -1);
  assert.equal(contents[callTurn].parts.length, 2);
  const results = contents[callTurn + 1].parts;
  assert.equal(results.length, 2, "every model function call needs a paired result");
  assert.deepEqual(results[0].functionResponse.response, {
    saved: true,
    recordId: "fictional-meal",
  });
  assert.match(JSON.stringify(results[1].functionResponse.response), /not executed/i);
  assert.match(JSON.stringify(results[1].functionResponse.response), /time budget/i);
});

test("Gemini scheduled tasks retain unrestricted model and tool durations", async () => {
  steps = [
    () => {
      timerContext.mock.timers.tick(70_000);
      return toolResponse();
    },
    answer("Scheduled work finished."),
  ];
  toolHandler = () => {
    timerContext.mock.timers.tick(70_000);
    return { saved: true };
  };
  const startedAt = Date.now();
  const result = await run({ userLabel: "scheduled task" });
  assert.equal(result.text, "Scheduled work finished.");
  assert.equal(result.incomplete, undefined);
  assert.equal(Date.now() - startedAt, 140_000);
  assert.equal(toolCalls.length, 1);
  for (const args of [...discoveryCalls, ...generationCalls]) {
    assert.equal(args.config?.abortSignal, undefined);
    assert.equal(args.config?.httpOptions?.timeout, undefined);
  }
});

test("Gemini configured sub-10s requests advertise a valid server deadline and still abort at the configured millisecond limit", async () => {
  testConfig.geminiRequestTimeoutMs = 1250;
  testConfig.geminiResponseTimeoutMs = 3000;
  testConfig.geminiHeavyRequestTimeoutMs = 1250;
  testConfig.geminiHeavyResponseTimeoutMs = 3000;
  const entered = deferred();
  steps = [
    (args) => {
      entered.resolve();
      return waitForAbort(args.config.abortSignal);
    },
  ];
  const startedAt = Date.now();
  const pending = run();
  await entered.promise;
  assertDeadline(discoveryCalls[0], 1250);
  assertDeadline(generationCalls[0], 1250);
  assert.equal(generationCalls[0].config.httpOptions.timeout, 10_000);
  timerContext.mock.timers.tick(1249);
  assert.equal(generationCalls[0].config.abortSignal.aborted, false);
  timerContext.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(Date.now() - startedAt, 1250);
  assert.equal(generationCalls[0].config.abortSignal.aborted, true);
  assert.equal(waits().length, 0);
});

test("Gemini final fallback with 6s remaining advertises 10s but keeps the total response budget and completed save", async () => {
  testConfig.geminiResponseTimeoutMs = 44_000;
  testConfig.geminiHeavyResponseTimeoutMs = 44_000;
  testConfig.geminiHeavyModels.push(
    `gemini-deadline-${caseId}-second`,
    `gemini-deadline-${caseId}-third`,
  );
  const entered = deferred();
  const serverDeadline = () => {
    timerContext.mock.timers.tick(19_000);
    throw new Error("504 DEADLINE_EXCEEDED: Deadline expired before operation could complete.");
  };
  steps = [
    toolResponse(),
    serverDeadline,
    serverDeadline,
    (args) => {
      entered.resolve();
      return waitForAbort(args.config.abortSignal);
    },
  ];
  const startedAt = Date.now();
  const pending = run();
  await entered.promise;
  assert.equal(generationCalls.length, 4);
  const lastRequest = generationCalls.at(-1);
  assert.equal(lastRequest.config.httpOptions.timeout, 10_000);
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(lastRequest.contents.at(-1).parts[0].functionResponse.response, {
    saved: true,
    totalCalories: 370,
  });
  timerContext.mock.timers.tick(5999);
  assert.equal(lastRequest.config.abortSignal.aborted, false);
  timerContext.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(Date.now() - startedAt, 44_000);
  assert.equal(lastRequest.config.abortSignal.aborted, true);
  assert.equal(toolCalls.length, 1, "a failover must reuse the completed save");
  assert.equal(generationCalls.length, 4);
  assert.equal(waits().length, 0);
});

test("Gemini discovery iterator has a deadline and falls back to configured models", async () => {
  const entered = deferred();
  listHandler = (args) => ({
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      entered.resolve();
      await waitForAbort(args.config.abortSignal);
      return { done: true };
    },
  });
  steps = [answer("Configured model answered.")];
  const pending = run();
  await entered.promise;
  timerContext.mock.timers.tick(4999);
  assert.equal(discoveryCalls[0].config.abortSignal.aborted, false);
  timerContext.mock.timers.tick(1);
  assert.equal((await pending).text, "Configured model answered.");
  assert.equal(discoveryCalls[0].config.abortSignal.aborted, true);
  assert.equal(generationCalls.length, 1);
  assertDeadline(generationCalls[0], 20_000);
  assert.equal(waits().length, 0);
});

test("Gemini total budget stops a chain of stalled fallbacks at 60 seconds", async () => {
  testConfig.geminiHeavyModels.push(
    `gemini-deadline-${caseId}-second`,
    `gemini-deadline-${caseId}-third`,
    `gemini-deadline-${caseId}-must-not-start`,
  );
  const entries = [deferred(), deferred(), deferred()];
  steps = entries.map((entry) => (args) => {
    entry.resolve();
    return waitForAbort(args.config.abortSignal);
  });
  const startedAt = Date.now();
  const pending = run();
  for (const entry of entries) {
    await entry.promise;
    timerContext.mock.timers.tick(20_000);
  }
  const result = await pending;
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(Date.now() - startedAt, 60_000);
  assert.equal(generationCalls.length, 3);
  assert.equal(waits().length, 0);
});

test("Gemini does not start a quota retry sleep that would exhaust its remaining response budget", async () => {
  setBudgets(20_000, 1000);
  steps = [new Error("429 RESOURCE_EXHAUSTED: Please retry in 1s.")];
  const startedAt = Date.now();
  const result = await run();
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(Date.now() - startedAt, 0);
  assert.equal(generationCalls.length, 1);
  assert.equal(waits().length, 0);
});

test("Gemini does not start a transient retry sleep that would exhaust its remaining response budget", async () => {
  setBudgets(20_000, 1000);
  steps = [new Error("fetch failed")];
  const result = await run();
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(generationCalls.length, 1);
  assert.equal(waits().length, 0);
});

test("Gemini does not execute tool calls from a model response arriving after its time budget", async () => {
  setBudgets(65_000, 60_000);
  steps = [
    () => {
      timerContext.mock.timers.tick(60_000);
      return toolResponse(2);
    },
  ];
  const result = await run();
  assert.equal(result.incomplete, true);
  assert.match(result.text, /time limit/i);
  assert.equal(toolCalls.length, 0);
  assert.equal(generationCalls.length, 1);
  assertDeadline(generationCalls[0], 60_000);
});

test("Gemini fast turn limit spans primary and fallback attempts without restarting the budget", async () => {
  const primary = testConfig.geminiHeavyModels[0];
  const fallback = `gemini-deadline-${caseId}-fallback`;
  testConfig.geminiHeavyModels.push(fallback);
  steps = [
    ...Array.from({ length: 9 }, () => toolResponse()),
    new Error("503 UNAVAILABLE: model overloaded"),
    ...Array.from({ length: 5 }, () => toolResponse()),
    answer("This sixteenth request must not start."),
  ];
  const startedAt = Date.now();
  const result = await run({ modelTier: "fast" });
  assert.equal(result.incomplete, true);
  assert.match(result.text, /ran out of steps/i);
  assert.equal(Date.now() - startedAt, 0, "the turn limit applies before any wall-clock deadline");
  assert.equal(generationCalls.length, 15);
  assert.deepEqual(
    generationCalls.map(({ model }) => model),
    [...Array(10).fill(primary), ...Array(5).fill(fallback)],
  );
  assert.equal(toolCalls.length, 14);
  assert.equal(steps.length, 1, "the fallback must not receive a fresh turn allowance");

  steps = [answer("The previous steps were already saved.")];
  await run({ modelTier: "fast", userMessage: "Continue without repeating completed saves." });
  assert.equal(toolCalls.length, 14);
  const history = generationCalls.at(-1).contents;
  const calls = history.filter((content) => content.parts.some((part) => part.functionCall));
  assert.equal(calls.length, 14);
  for (const call of calls) {
    const responses = history[history.indexOf(call) + 1];
    assert.equal(responses.role, "user");
    assert.equal(responses.parts.length, call.parts.length);
    assert.deepEqual(responses.parts[0].functionResponse.response, {
      saved: true,
      totalCalories: 370,
    });
  }
});
