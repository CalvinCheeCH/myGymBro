import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The friendly error classifier reads the engine's predicates, so install the
// same stand-ins the Gemini test files use before the dynamic import. Nothing
// here runs the engine; the mocks only keep the import graph side-effect free.
mock.module("../dist/config.js", {
  namedExports: {
    pickEngine: () => "gemini",
    config: {
      telegramBotToken: "test",
      geminiApiKey: "test",
      agentName: "myGymBro",
      timezone: "Etc/UTC",
      sessionTtlHours: 12,
    },
  },
});
mock.module("../dist/agent/tooling.js", {
  namedExports: {
    PROJECT_ROOT: "/tmp-invalid-mygymbro-errors",
    SCRIPT_NAMES: [],
    executeCoachTool: async () => ({ error: "not available in tests" }),
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
    recordTiming: () => {},
    measureTiming: async (_stage, task) => task(),
  },
});
mock.module("@google/genai", { namedExports: { GoogleGenAI: class {} } });

const { classifyError } = await import("../dist/channel/errors.js");
const { humanizeWaitSeconds } = await import("../dist/util/format.js");

test("humanizeWaitSeconds turns raw retry windows into chat-sized wording", () => {
  assert.equal(humanizeWaitSeconds(null), null);
  assert.equal(humanizeWaitSeconds(0), null);
  assert.equal(humanizeWaitSeconds(30), "less than a minute");
  assert.equal(humanizeWaitSeconds(65), "about a minute");
  assert.equal(humanizeWaitSeconds(190), "about 3 minutes");
  assert.equal(humanizeWaitSeconds(3600), "about an hour");
  assert.equal(humanizeWaitSeconds(61355), "about 17 hours");
});

test("classifyError explains a drained daily quota with its reset window", () => {
  const message = classifyError(
    "429 RESOURCE_EXHAUSTED: quota exceeded; quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier. " +
      "Please retry in 17h2m35.58441243s.",
  );
  assert.match(message, /daily quota/i);
  assert.match(message, /resets in about 17 hours/i);
  assert.match(message, /send it again/i);
});

test("classifyError explains short rate windows without pretending to know the day", () => {
  const message = classifyError("429 RESOURCE_EXHAUSTED: Please retry in 22s.");
  assert.match(message, /rate limit/i);
  assert.match(message, /clears in less than a minute/i);
});

test("classifyError distinguishes overloaded models, deadline misses, and unknown failures", () => {
  assert.match(
    classifyError("503 UNAVAILABLE: high demand. Spikes in demand are usually temporary."),
    /overloaded/i,
  );
  assert.match(
    classifyError("504 DEADLINE_EXCEEDED: Deadline expired before operation could complete."),
    /time limit/i,
  );
  assert.match(classifyError("kaboom"), /Something went wrong/i);
});

test("classifyError keeps the workspace, usage, and Notion guardrails", () => {
  assert.match(classifyError("Workspace reset is in progress."), /reset/);
  assert.match(classifyError("usage limit reached"), /usage limit/i);
  assert.match(classifyError("Notion fetch failed"), /Notion/i);
});
