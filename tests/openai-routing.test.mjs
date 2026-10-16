import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-openai-routing-"));
mock.module("../dist/config.js", {
  exports: {
    config: {
      sessionTtlHours: 12,
      openaiHistoryFile: path.join(tmpDir, "history.json"),
    },
  },
});
mock.module("../dist/agent/gemini.js", {
  exports: { buildSystemPrompt: () => "" },
});
const { usesOpenAIFastModel } = await import("../dist/agent/openai.js");
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("OpenAI uses the fast model only for fast-tier messages without attachments", () => {
  assert.equal(usesOpenAIFastModel("fast", 0), true);
  assert.equal(usesOpenAIFastModel("fast", 1), false);
  assert.equal(usesOpenAIFastModel("standard", 0), false);
  assert.equal(usesOpenAIFastModel(undefined, 0), false);
});
