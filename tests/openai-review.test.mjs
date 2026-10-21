import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-openai-review-"));
const requests = [];
const tools = [];
const records = [];
let responses = [];
mock.module("../dist/config.js", {
  namedExports: {
    config: {
      sessionTtlHours: 12,
      openaiHistoryFile: path.join(directory, "history.json"),
      openaiApiKey: "synthetic-test-token",
      openaiModel: "synthetic-coaching-model",
      openaiModelFast: "synthetic-fast-model",
      timezone: "Etc/UTC",
    },
  },
});
mock.module("../dist/agent/gemini.js", {
  namedExports: { buildSystemPrompt: () => "Known profile and coaching voice." },
});
mock.module("../dist/agent/tooling.js", {
  namedExports: {
    executeCoachTool: async (...args) => {
      tools.push(args);
      return { saved: true };
    },
  },
});
mock.module("../dist/agent/runlog.js", {
  namedExports: {
    appendRunRecord: async (record) => {
      records.push(record);
    },
    summariseUsage: () => undefined,
  },
});
const { runOpenAIAgent } = await import("../dist/agent/openai.js");
let sequence = 0;
const answer = (text = "Keep the next session consistent.") => ({
  id: `synthetic-response-${++sequence}`,
  output_text: text,
  output: [],
});
const call = () => ({
  id: `synthetic-response-${++sequence}`,
  output: [
    {
      type: "function_call",
      name: "run_script",
      call_id: "synthetic-call",
      arguments: JSON.stringify({ script: "notion.mjs", args: ["log-meal"] }),
    },
  ],
});
beforeEach((t) => {
  requests.length = 0;
  tools.length = 0;
  records.length = 0;
  responses = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const response = responses.shift();
    assert.ok(response, "Unexpected model request");
    return Response.json(response);
  });
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("precomputed OpenAI reviews answer in one generation while retaining profile and follow-up conversation", async () => {
  responses = [answer()];
  const result = await runOpenAIAgent({
    chatId: "review-text",
    userMessage: "/progress\nSaved facts.",
    toolsEnabled: false,
  });
  assert.match(result.text, /next session/);
  assert.equal(requests.length, 1);
  assert.equal(tools.length, 0);
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].tool_choice, "none");
  assert.match(requests[0].instructions, /Known profile and coaching voice/);
  assert.match(requests[0].instructions, /read-only coaching review/);
  assert.match(requests[0].input, /Saved facts/);
  responses = [answer("A normal coaching answer.")];
  await runOpenAIAgent({ chatId: "review-text", userMessage: "What next?" });
  assert.ok(requests[1].previous_response_id);
  assert.ok(requests[1].tools.length > 0);
  assert.equal(requests[1].tool_choice, undefined);
});

test("unexpected OpenAI review tool calls are rejected without execution, further generation or orphaned conversation state", async () => {
  responses = [call()];
  const result = await runOpenAIAgent({
    chatId: "review-rejected",
    userMessage: "Saved facts.",
    toolsEnabled: false,
  });
  assert.equal(result.incomplete, true);
  assert.match(result.text, /couldn't finish the coaching review/);
  assert.equal(requests.length, 1);
  assert.equal(tools.length, 0);
  assert.equal(records[0].isError, true);
  responses = [answer()];
  await runOpenAIAgent({ chatId: "review-rejected", userMessage: "A normal question." });
  assert.equal(requests[1].previous_response_id, undefined);
});

test("normal OpenAI requests retain the existing tool loop", async () => {
  responses = [call(), answer("Saved the requested record.")];
  const result = await runOpenAIAgent({ chatId: "normal-tools", userMessage: "Save my meal." });
  assert.match(result.text, /Saved the requested record/);
  assert.equal(requests.length, 2);
  assert.equal(tools.length, 1);
  assert.equal(requests[1].input[0].type, "function_call_output");
});

test("incomplete OpenAI review text is rejected without changing normal responses", async () => {
  responses = [{ ...answer("A cut-off paragraph."), status: "incomplete" }];
  const review = await runOpenAIAgent({
    chatId: "review-cutoff",
    userMessage: "Saved facts.",
    toolsEnabled: false,
  });
  assert.equal(review.incomplete, true);
  assert.match(review.text, /couldn't finish the coaching review/);
  assert.equal(records[0].isError, true);
  responses = [{ ...answer("A cut-off paragraph."), status: "incomplete" }];
  const normal = await runOpenAIAgent({
    chatId: "normal-cutoff",
    userMessage: "A normal question.",
  });
  assert.equal(normal.incomplete, undefined);
  assert.equal(normal.text, "A cut-off paragraph.");
});
