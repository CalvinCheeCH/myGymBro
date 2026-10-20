import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatTimings, summarizeTimings } from "../scripts/response-timings.mjs";

const requestId = "00000000-0000-4000-8000-000000000001";
const trace = (extra = {}) => ({
  requestId,
  totalMs: 1000,
  background: false,
  spans: [],
  ...extra,
});
const jsonl = (...records) => records.map((record) => JSON.stringify(record)).join("\n");

test("timing summary selects latest completed valid record and skips malformed lines", () => {
  const input = `${jsonl(trace(), trace({ totalMs: 1300 }))}\n{broken\n${jsonl({ requestId, spans: [] })}`;
  assert.equal(summarizeTimings(input).totalMs, 1300);
  assert.equal(summarizeTimings("\nnull\n[]\n{}\n{broken"), undefined);
  assert.equal(summarizeTimings(jsonl(trace({ requestId: "private chat text" }))), undefined);
  assert.equal(summarizeTimings(jsonl(trace({ requestId: [requestId] }))), undefined);
  assert.equal(summarizeTimings(jsonl(trace({ requestId: `${requestId}\n` }))), undefined);
});

test("timing summary groups stage and operation while keeping nested durations separate", () => {
  const summary = summarizeTimings(
    jsonl(
      trace({
        firstReplyAcceptedMs: 900,
        lastReplyAcceptedMs: 950,
        background: true,
        telegramDeliveryLagMs: 250,
        spans: [
          { stage: "agent", durationMs: 900 },
          { stage: "model_request", operation: "gemini-flash", durationMs: 300 },
          { stage: "model_request", operation: "gemini-flash", durationMs: 200 },
          { stage: "tool", operation: "run_script:notion.mjs", durationMs: 150 },
        ],
      }),
    ),
  );
  assert.equal(summary.totalMs, 1000);
  assert.deepEqual(summary.spans, [
    { stage: "agent", operation: "", count: 1, totalMs: 900 },
    { stage: "model_request", operation: "gemini-flash", count: 2, totalMs: 500 },
    { stage: "tool", operation: "run_script:notion.mjs", count: 1, totalMs: 150 },
  ]);
  const output = formatTimings(summary);
  assert.match(output, /First reply accepted: 900 ms/);
  assert.match(output, /Last reply accepted: 950 ms/);
  assert.match(output, /Background work: yes/);
  assert.match(output, /delivery lag \(approximate\): 250 ms/);
  assert.match(output, /Nested spans overlap; do not add/);
});

test("timing summary omits unknown fields, unsafe labels and nonnumeric metadata", () => {
  const summary = summarizeTimings(
    jsonl(
      trace({
        chatId: "SECRET_CHAT",
        message: "SECRET_MESSAGE",
        firstReplyAcceptedMs: "SECRET_FIRST",
        lastReplyAcceptedMs: -1,
        telegramDeliveryLagMs: "SECRET_LAG",
        spans: [
          { stage: "SECRET_STAGE", durationMs: 100 },
          {
            stage: "tool",
            operation: "run_script:notion.mjs --token SECRET_TOKEN",
            durationMs: 50,
            error: "SECRET_ERROR",
          },
          { stage: "model_request", operation: "gemini-model\nSECRET_LABEL", durationMs: 20 },
          { stage: "model_request", operation: "gemini-model\n", durationMs: 10 },
          { stage: "tool", durationMs: -1 },
          { stage: "tool", durationMs: "SECRET_DURATION" },
          null,
        ],
      }),
    ),
  );
  assert.equal(summary.spans.length, 2);
  assert.equal(summary.spans[1].count, 2);
  assert.equal(summary.spans[0].operation, "");
  assert.equal(summary.spans[1].operation, "");
  const output = formatTimings(summary);
  assert.doesNotMatch(JSON.stringify(summary) + output, /SECRET_/);
  assert.match(output, /First reply accepted: not recorded/);
  assert.doesNotMatch(output, /delivery lag/);
});

test("timing viewer CLI reads configured file and hides missing-file paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-timings-"));
  const script = fileURLToPath(new URL("../scripts/response-timings.mjs", import.meta.url));
  try {
    const file = path.join(dir, "trace.jsonl");
    fs.writeFileSync(file, jsonl(trace({ totalMs: 1234.56 })));
    const output = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, RESPONSE_TIMING_FILE: file },
    });
    assert.match(output, /Total lifecycle: 1234.6 ms/);
    const missing = path.join(dir, "PRIVATE_MISSING_FILE");
    const empty = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, RESPONSE_TIMING_FILE: missing },
    });
    assert.match(empty, /send a Telegram query/);
    assert.doesNotMatch(empty, /PRIVATE_MISSING_FILE|Error:|at /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
