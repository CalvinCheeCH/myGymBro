import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

// The gemini module reads config at load time (history file path, TTL), so a
// mock config is installed before the first dynamic import below.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-gemini-"));

mock.module("../dist/config.js", {
  namedExports: {
    pickEngine: () => "gemini",
    config: {
      telegramBotToken: "test",
      geminiApiKey: "test-key",
      geminiModel: "gemini-test",
      agentName: "myGymBro",
      timezone: "Etc/UTC",
      sessionTtlHours: 12,
      geminiHistoryFile: path.join(TMP_DIR, "gemini-history.json"),
    },
  },
});

const {
  assembleSystemPrompt,
  attachmentsToParts,
  isModelUnavailableError,
  isOverloadedError,
  isPerDayQuota,
  parseRetrySeconds,
  resolveRunModels,
  responseText,
  sanitizeModelParts,
  trimHistory,
} = await import("../dist/agent/gemini.js");

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
