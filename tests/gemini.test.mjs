import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

// The gemini module reads config at load time (history file path, TTL), so a
// mock config is installed before the first dynamic import below.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-gemini-"));

const testConfig = {
  telegramBotToken: "test",
  geminiApiKey: "test-key",
  geminiModel: "gemini-test",
  agentName: "myGymBro",
  timezone: "Etc/UTC",
  sessionTtlHours: 12,
  geminiHistoryFile: path.join(TMP_DIR, "gemini-history.json"),
  geminiSmartRouting: false,
  geminiHeavyModels: [],
  geminiLightModels: [],
};
const generationCalls = [];
const toolCalls = [];
const timings = [];
let steps = [];
let timerContext;
let toolHandler;
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
      if (toolHandler) return toolHandler();
      return { saved: true, totalCalories: 370 };
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
  namedExports: {
    appendRunRecord: async () => {},
    summariseUsage: () => undefined,
  },
});
mock.module("../dist/util/timing.js", {
  namedExports: {
    recordTiming: (stage, durationMs, operation) => timings.push({ stage, durationMs, operation }),
    measureTiming: async (stage, task, operation) => {
      const startedAt = Date.now();
      try {
        const result = task();
        if (stage === "retry_wait") timerContext.mock.timers.runAll();
        return await result;
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
        list: async () => (async function* () {})(),
        generateContent: async (args) => {
          generationCalls.push(structuredClone(args));
          const step = steps.shift();
          assert.ok(step, "unexpected model request");
          if (step instanceof Error) throw step;
          return step;
        },
      };
    },
  },
});

beforeEach((context) => {
  timerContext = context;
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  caseId++;
  testConfig.geminiHeavyModels = [`gemini-case-${caseId}-primary`];
  generationCalls.length = 0;
  toolCalls.length = 0;
  timings.length = 0;
  steps = [];
  toolHandler = undefined;
  for (const filename of ["gemini-last-good.json", "gemini-quotas.json"]) {
    fs.rmSync(path.join(TMP_DIR, "data", filename), { force: true });
  }
});
after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

const {
  assembleSystemPrompt,
  attachmentsToParts,
  isModelUnavailableError,
  isOverloadedError,
  isPerDayQuota,
  parseRetrySeconds,
  resolveRunModels,
  responseText,
  runGeminiAgent,
  sanitizeModelParts,
  trimHistory,
} = await import("../dist/agent/gemini.js");

const { QUICK_CHOICE_INSTRUCTIONS } = await import("../dist/channel/quick-choices.js");

// ─── system prompt assembly ──────────────────────────────────────────────────

test("assembleSystemPrompt: includes engine notes, CLAUDE.md, PERSONAL.md, skills, persona", () => {
  const md = assembleSystemPrompt({
    claudeMd: "# Coach rules",
    personalMd: "- Daily calorie target (kcal): 2000",
    skills: [{ relPath: "coach-plugin/skills/log-meal/SKILL.md", body: "Log meals carefully." }],
    personaAppend: "Speak like a drill sergeant.",
    agentName: "myGymBro",
  });
  assert.match(md, /You are myGymBro/);
  assert.match(md, /`run_script`/);
  assert.match(
    md,
    /# Coach rules[\s\S]*# Coach instructions|Coach instructions[\s\S]*# Coach rules/,
  );
  assert.match(md, /Daily calorie target \(kcal\): 2000/);
  assert.match(md, /Skill playbook: coach-plugin\/skills\/log-meal\/SKILL.md/);
  assert.match(md, /Log meals carefully\./);
  assert.match(md, /Speak like a drill sergeant\./);
  assert.match(md, /Retry a rejected write only when the helper confirms nothing was written/);
  assert.match(md, /never blindly repeat an additive meal/);
  assert.equal(md.split(QUICK_CHOICE_INSTRUCTIONS).length - 1, 1);
});

test("assembleSystemPrompt: omits PERSONAL.md section when absent", () => {
  const md = assembleSystemPrompt({
    claudeMd: "# Coach rules",
    skills: [],
    personaAppend: "",
    agentName: "myGymBro",
  });
  assert.doesNotMatch(md, /PERSONAL\.md\)/);
});

test("assembleSystemPrompt: includes logging shorthand when present", () => {
  const md = assembleSystemPrompt({
    claudeMd: "# Coach rules",
    loggingStyle: "db = dumbbell; weight x reps per set, kg by default.",
    skills: [],
    personaAppend: "",
    agentName: "myGymBro",
  });
  assert.match(md, /LOGGING_STYLE\.md/);
  assert.match(md, /db = dumbbell/);
});

// ─── attachment mapping ──────────────────────────────────────────────────────

test("attachmentsToParts: maps images and PDFs to inlineData parts, drops other types", () => {
  const parts = attachmentsToParts([
    { mediaType: "image/jpeg", data: "AAA" },
    { mediaType: "application/pdf", data: "BBB" },
    { mediaType: "video/mp4", data: "CCC" },
  ]);
  assert.deepEqual(parts, [
    { inlineData: { mimeType: "image/jpeg", data: "AAA" } },
    { inlineData: { mimeType: "application/pdf", data: "BBB" } },
  ]);
  assert.deepEqual(attachmentsToParts(undefined), []);
});

// ─── history trimming ────────────────────────────────────────────────────────

const u = (text) => ({ role: "user", parts: [{ text }] });
const m = (text) => ({ role: "model", parts: [{ text }] });

test("trimHistory: caps length and never starts on a model entry", () => {
  const history = [u("one"), m("two"), u("three"), m("four"), u("five"), m("six")];
  const trimmed = trimHistory(history, 4);
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed[0].role, "user");
  assert.equal(trimmed.at(-1).parts[0].text, "six");
});

test("trimHistory: drops leading orphaned function-response halves and dangling calls", () => {
  const history = [
    { role: "model", parts: [{ functionCall: { name: "bash", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "bash", response: {} } }] },
    u("fresh question"),
    m("answer"),
  ];
  // A trim that lands between an exchange's halves leaves a bare responses-user
  // at the head; it must be dropped so history starts on a real user turn.
  const orphaned = [history[1], u("fresh question"), m("answer")];
  const trimmed = trimHistory(orphaned, 10);
  assert.equal(trimmed[0].parts[0].text, "fresh question");

  // A trim that ends on a model function call awaiting its response must drop
  // that dangling tail rather than send an incomplete exchange.
  const dangling = [
    u("fresh question"),
    m("answer"),
    { role: "model", parts: [{ functionCall: { name: "bash" } }] },
  ];
  const trimmedDangling = trimHistory(dangling, 10);
  assert.equal(trimmedDangling.length, 2);
  assert.equal(trimmedDangling.at(-1).parts[0].text, "answer");
});

test("trimHistory: mid-exchange cut never leaves an orphaned call first", () => {
  // Real poison shape from a quota-stormed history file: a run of
  // model(call) -> user(response) pairs with no user-text turn before them.
  // Stripping only the first entry would promote the next orphaned call to
  // the head, which the API rejects with 400 ("function call turn comes
  // immediately after a user turn or after a function response turn").
  // Every call left in the output must be preceded by a user turn.
  const call = () => ({ role: "model", parts: [{ functionCall: { name: "bash", args: {} } }] });
  const resp = () => ({
    role: "user",
    parts: [{ functionResponse: { name: "bash", response: {} } }],
  });
  const poisoned = [
    call(),
    resp(),
    call(),
    resp(),
    call(),
    resp(),
    u("fresh question"),
    m("answer"),
  ];
  const trimmed = trimHistory(poisoned, 60);
  assert.equal(trimmed[0].parts[0].text, "fresh question");
  for (let i = 0; i < trimmed.length; i++) {
    const isCall = trimmed[i].role === "model" && trimmed[i].parts.some((p) => p.functionCall);
    if (!isCall) continue;
    const prev = trimmed[i - 1];
    assert.ok(prev && prev.role === "user", `call at index ${i} is not preceded by a user turn`);
  }
});

// ─── response text extraction ────────────────────────────────────────────────

test("responseText: joins text parts and tolerates missing candidates", () => {
  assert.equal(
    responseText({ candidates: [{ content: { parts: [{ text: "Hello " }, { text: "bro" }] } }] }),
    "Hello bro",
  );
  assert.equal(responseText({}), "");
  assert.equal(responseText(undefined), "");
});

// ─── model part sanitising (thought signatures) ──────────────────────────────

test("sanitizeModelParts: keeps functionCall parts verbatim, signature included", () => {
  const part = {
    functionCall: { name: "bash", args: { command: "node -v" } },
    thoughtSignature: "encrypted-blob",
  };
  const out = sanitizeModelParts([part]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], part);
  assert.equal(out[0].thoughtSignature, "encrypted-blob");
});

test("sanitizeModelParts: keeps plain text, drops thought summaries and junk", () => {
  const out = sanitizeModelParts([
    { text: "Let me check that.", thoughtSignature: "sig" },
    { text: "internal reasoning", thought: true },
    null,
    { inlineData: { mimeType: "image/png", data: "x" } },
    undefined,
  ]);
  assert.deepEqual(out, [{ text: "Let me check that.", thoughtSignature: "sig" }]);
});

test("sanitizeModelParts: empty input yields empty output", () => {
  assert.deepEqual(sanitizeModelParts([]), []);
  assert.deepEqual(sanitizeModelParts(undefined), []);
});

// ─── model failover chain ────────────────────────────────────────────────────

test("isModelUnavailableError: matches 404-class model errors, not quota or network", () => {
  assert.equal(
    isModelUnavailableError("models/gemini-2.5-flash is no longer available to new users"),
    true,
  );
  assert.equal(isModelUnavailableError('{"code":404,"status":"NOT_FOUND"}'), true);
  assert.equal(isModelUnavailableError("quota exceeded for this model"), false);
  assert.equal(isModelUnavailableError("socket hang up"), false);
});

test("isOverloadedError: matches 503-class shed-load errors for instant failover", () => {
  assert.equal(
    isOverloadedError(
      '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
    ),
    true,
  );
  assert.equal(isOverloadedError("models/gemini-2.0-flash is overloaded"), true);
  assert.equal(isOverloadedError("quota exceeded for this model"), false);
  assert.equal(isOverloadedError("socket hang up"), false);
});

test("isPerDayQuota: daily caps park the model, minute windows do not", () => {
  assert.equal(
    isPerDayQuota("quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit 20"),
    true,
  );
  assert.equal(isPerDayQuota("Quota exceeded for metric, per-day limit reached"), true);
  assert.equal(isPerDayQuota("Please retry in 22.5s."), false);
  assert.equal(isPerDayQuota("socket hang up"), false);
});

// ─── discovery-aware chain resolution ────────────────────────────────────────

test("parseRetrySeconds: reads Google's fractional and minute forms", () => {
  assert.equal(parseRetrySeconds("Please retry in 22.496439837s."), 22.496439837);
  assert.equal(parseRetrySeconds('retryDelay":"1m5s"'), 65);
  assert.equal(parseRetrySeconds("quota exhausted, no hint here"), null);
});

test("resolveRunModels: configured-first, chat models scored per tier, junk excluded", () => {
  const discovered = [
    "gemini-3.6-flash",
    "gemini-3.6-flash-lite-001",
    "gemini-3.6-pro-preview",
    "gemini-tuning-xyz",
    "gemini-2.5-flash-preview-tts",
    "veo-3.1-generate-preview",
    "gemini-3.1-flash-image",
  ];
  const heavy = resolveRunModels(["gemini-3.6-flash"], discovered, "standard");
  // Stable flash first, non-preview over preview, image/TTS/veo never invited.
  assert.deepEqual(heavy, [
    "gemini-3.6-flash",
    "gemini-tuning-xyz",
    "gemini-3.6-flash-lite-001",
    "gemini-3.6-pro-preview",
  ]);
  const light = resolveRunModels(["gemini-3.6-flash"], discovered, "fast");
  assert.equal(light[0], "gemini-3.6-flash");
  assert.equal(light[1], "gemini-3.6-flash-lite-001");
});

test("resolveRunModels: caps appended fallbacks so failover stays fast", () => {
  const many = Array.from({ length: 30 }, (_, i) => `gemini-x-${i}`);
  const out = resolveRunModels(["gemini-primary"], many, "standard");
  assert.ok(out.length <= 6);
});

test("resolveRunModels: sticky last-good model goes first, unknown ids ignored", () => {
  const discovered = ["gemini-a", "gemini-b", "gemini-c"];
  const sticky = resolveRunModels(["gemini-a", "gemini-b"], discovered, "fast", "gemini-c");
  assert.deepEqual(sticky, ["gemini-c", "gemini-a", "gemini-b"]);
  const unknown = resolveRunModels(["gemini-a", "gemini-b"], discovered, "fast", "gemini-gone");
  assert.deepEqual(unknown, ["gemini-a", "gemini-b", "gemini-c"]);
  const none = resolveRunModels(["gemini-a", "gemini-b"], discovered, "fast");
  assert.deepEqual(none, ["gemini-a", "gemini-b", "gemini-c"]);
});

test("resolveRunModels: per-day dead models are skipped, all-dead still tries", () => {
  const discovered = ["gemini-a", "gemini-b", "gemini-c"];
  const skipped = resolveRunModels(["gemini-a", "gemini-b"], discovered, "fast", null, [
    "gemini-a",
  ]);
  assert.deepEqual(skipped, ["gemini-b", "gemini-c"]);
  const stickyDead = resolveRunModels(["gemini-a", "gemini-b"], discovered, "fast", "gemini-a", [
    "gemini-a",
  ]);
  assert.deepEqual(stickyDead, ["gemini-b", "gemini-c"]);
  const allDead = resolveRunModels(["gemini-a"], discovered, "standard", null, [
    "gemini-a",
    "gemini-b",
    "gemini-c",
  ]);
  assert.ok(allDead.length > 0);
});

test("resolveRunModels: older generations sort first, newest stay reachable", () => {
  const discovered = ["gemini-3.8-flash", "gemini-2.0-flash", "gemini-3.6-flash"];
  const out = resolveRunModels(["gemini-3.8-flash"], discovered, "standard");
  assert.deepEqual(out, ["gemini-3.8-flash", "gemini-2.0-flash", "gemini-3.6-flash"]);
});

test("resolveRunModels: null or empty discovery keeps the configured chain", () => {
  assert.deepEqual(resolveRunModels(["a", "b"], null, "standard"), ["a", "b"]);
  assert.deepEqual(resolveRunModels(["a", "b"], [], "standard"), ["a", "b"]);
});

// ─── interactive quota budget and cooldowns ─────────────────────────────────

const answer = (text = "Ready.") => ({ candidates: [{ content: { parts: [{ text }] } }] });
const quota = (seconds) => new Error(`429 RESOURCE_EXHAUSTED: Please retry in ${seconds}s.`);
const run = (extra = {}) =>
  runGeminiAgent({ userMessage: "What should I train today?", chatId: `chat-${caseId}`, ...extra });
const waits = () => timings.filter(({ stage }) => stage === "retry_wait");

test("runGeminiAgent: healthy requests keep their single model call and record stages", async () => {
  steps = [answer("Upper body today.")];
  assert.equal((await run()).text, "Upper body today.");
  assert.equal(generationCalls.length, 1);
  assert.equal(toolCalls.length, 0);
  assert.equal(waits().length, 0);
  assert.ok(timings.some(({ stage }) => stage === "prompt_preparation"));
  assert.ok(timings.some(({ stage }) => stage === "model_discovery"));
  assert.deepEqual(
    timings.filter(({ stage }) => stage === "model_request").map(({ operation }) => operation),
    testConfig.geminiHeavyModels,
  );
});

test("runGeminiAgent: long quota hints fail over immediately and cool the throttled model", async (t) => {
  const primary = testConfig.geminiHeavyModels[0];
  const fallback = `gemini-case-${caseId}-fallback`;
  testConfig.geminiHeavyModels.push(fallback);
  steps = [quota(22), answer("Fallback answered.")];
  assert.equal((await run()).text, "Fallback answered.");
  assert.deepEqual(
    generationCalls.map(({ model }) => model),
    [primary, fallback],
  );
  assert.equal(waits().length, 0);

  // Remove the sticky winner to prove cooldown, rather than ordering, skips it.
  fs.rmSync(path.join(TMP_DIR, "data", "gemini-last-good.json"));
  generationCalls.length = 0;
  steps = [answer()];
  await run();
  assert.deepEqual(
    generationCalls.map(({ model }) => model),
    [fallback],
  );

  t.mock.timers.tick(22_500);
  fs.rmSync(path.join(TMP_DIR, "data", "gemini-last-good.json"));
  generationCalls.length = 0;
  steps = [answer()];
  await run();
  assert.deepEqual(
    generationCalls.map(({ model }) => model),
    [primary],
  );
});

test("runGeminiAgent: a lone long-throttled model returns promptly and is not hammered again", async () => {
  steps = [quota(30)];
  assert.match((await run()).text, /at capacity/);
  assert.equal(generationCalls.length, 1);
  assert.equal(waits().length, 0);
  await run();
  assert.equal(generationCalls.length, 1);
});

test("runGeminiAgent: short quota retries share one two-second interactive budget", async () => {
  steps = [quota(1), quota(1), answer("Must not reach a third request.")];
  assert.match((await run()).text, /at capacity/);
  assert.equal(generationCalls.length, 2);
  assert.deepEqual(
    waits().map(({ durationMs }) => durationMs),
    [1500],
  );
  assert.ok(waits().reduce((total, span) => total + span.durationMs, 0) <= 2000);
});

test("runGeminiAgent: a short single-model window can still recover within budget", async () => {
  steps = [quota(0.2), answer("Recovered.")];
  assert.equal((await run()).text, "Recovered.");
  assert.equal(generationCalls.length, 2);
  assert.deepEqual(
    waits().map(({ durationMs }) => durationMs),
    [700],
  );
});

test("runGeminiAgent: scheduled tasks retain their existing longer quota retry", async () => {
  steps = [quota(22), answer("Scheduled task finished.")];
  assert.equal((await run({ userLabel: "scheduled task" })).text, "Scheduled task finished.");
  assert.equal(generationCalls.length, 2);
  assert.deepEqual(
    waits().map(({ durationMs }) => durationMs),
    [22_500],
  );
});

test("runGeminiAgent: daily quota is parked without retrying even with a short hint", async () => {
  steps = [new Error("429 GenerateRequestsPerDay: Please retry in 0.1s.")];
  assert.match((await run()).text, /at capacity/);
  assert.equal(generationCalls.length, 1);
  assert.equal(waits().length, 0);
  const dead = JSON.parse(fs.readFileSync(path.join(TMP_DIR, "data", "gemini-quotas.json")));
  assert.equal(dead[testConfig.geminiHeavyModels[0]], Date.now() + 86_400_000);
});

const savedMealCall = () => ({
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: "run_script",
              args: { script: "notion.mjs", args: ["log-meal"] },
            },
            thoughtSignature: "preserved-signature",
          },
        ],
      },
    },
  ],
});

test("runGeminiAgent: quota fallback carries completed tool results without repeating the save", async () => {
  const primary = testConfig.geminiHeavyModels[0];
  const fallback = `gemini-case-${caseId}-fallback`;
  testConfig.geminiHeavyModels.push(fallback);
  steps = [savedMealCall(), quota(20), answer("Meal saved.")];
  assert.equal((await run()).text, "Meal saved.");
  assert.deepEqual(
    generationCalls.map(({ model }) => model),
    [primary, primary, fallback],
  );
  assert.equal(toolCalls.length, 1);
  const contents = generationCalls[2].contents;
  assert.equal(contents.at(-2).parts[0].thoughtSignature, "preserved-signature");
  assert.deepEqual(contents.at(-1).parts[0].functionResponse.response, {
    saved: true,
    totalCalories: 370,
  });
  assert.equal(waits().length, 0);
});

test("runGeminiAgent: an exhausted chain preserves completed writes for the next turn", async (t) => {
  steps = [savedMealCall(), quota(20)];
  assert.match((await run()).text, /at capacity/);
  assert.equal(toolCalls.length, 1);
  t.mock.timers.tick(21_000);
  steps = [answer("The earlier meal was already saved.")];
  await run({ userMessage: "Did that save?" });
  const nextHistory = generationCalls.at(-1).contents;
  assert.ok(
    nextHistory.some((content) =>
      content.parts.some((part) => part.functionResponse?.response.saved),
    ),
  );
  assert.equal(toolCalls.length, 1);
});

test("runGeminiAgent: HTTP 429 without a textual quota keyword still cools the model", async () => {
  const error = new Error("TooManyRequests");
  error.status = 429;
  steps = [error];
  assert.match((await run()).text, /at capacity/);
  await run();
  assert.equal(generationCalls.length, 1);
  assert.equal(waits().length, 0);
});

test("runGeminiAgent: non-quota failures still throw without crossing model boundaries", async () => {
  testConfig.geminiHeavyModels.push(`gemini-case-${caseId}-fallback`);
  steps = [new Error("Invalid API key")];
  await assert.rejects(run(), /Invalid API key/);
  assert.equal(generationCalls.length, 1);
  assert.equal(waits().length, 0);
});

test("runGeminiAgent: existing transient retries are retained and timed", async () => {
  steps = [new Error("fetch failed"), new Error("socket hang up"), answer()];
  assert.equal((await run()).text, "Ready.");
  assert.equal(generationCalls.length, 3);
  assert.deepEqual(
    waits().map(({ durationMs }) => durationMs),
    [1000, 2000],
  );
});

test("runGeminiAgent: concurrent quota cooldown is honored between completed tool steps", async () => {
  let releaseTool;
  let enteredTool;
  const toolStarted = new Promise((resolve) => {
    enteredTool = resolve;
  });
  const toolFinished = new Promise((resolve) => {
    releaseTool = resolve;
  });
  toolHandler = async () => {
    enteredTool();
    await toolFinished;
    return { saved: true, totalCalories: 370 };
  };
  steps = [savedMealCall(), quota(30)];
  const first = run({ chatId: `chat-${caseId}-first` });
  await toolStarted;
  assert.match((await run({ chatId: `chat-${caseId}-second` })).text, /at capacity/);
  releaseTool();
  assert.match((await first).text, /at capacity/);
  assert.equal(generationCalls.length, 2);
  assert.equal(toolCalls.length, 1);
});
