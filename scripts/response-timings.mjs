import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGES = new Set([
  "intake_wait",
  "queue_wait",
  "chat_wait",
  "provider_slot_wait",
  "agent",
  "prompt_preparation",
  "model_discovery",
  "model_request",
  "tool",
  "retry_wait",
  "telegram_send",
  "telegram_ack",
  "telegram_edit",
  "notion_read",
  "media_download",
  "transcription",
  "album_wait",
]);
// Match src/util/timing.ts: arguments, paths, chat text and errors are never labels.
const SAFE_OPERATION =
  /^(?:gemini-[a-zA-Z0-9_.-]{1,75}|read_file|write_file|list_knowledge|move_knowledge|run_script(?::(?:calendar|exercise-db|notion|progression|publish-heatmap|report-card|send-photo|setup-workspace)\.mjs)?)$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const duration = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const ms = (value) => (duration(value) ? `${Math.round(value * 10) / 10} ms` : "not recorded");

/** Return only display-safe fields from the latest completed JSONL record. */
export function summarizeTimings(jsonl) {
  for (const line of jsonl.trim().split(/\r?\n/).reverse()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !record ||
      typeof record.requestId !== "string" ||
      record.requestId.length !== 36 ||
      !UUID.test(record.requestId) ||
      !duration(record.totalMs) ||
      !Array.isArray(record.spans) ||
      typeof record.background !== "boolean"
    )
      continue;
    const grouped = new Map();
    for (const span of record.spans) {
      if (!span || !STAGES.has(span.stage) || !duration(span.durationMs)) continue;
      const operation =
        typeof span.operation === "string" &&
        span.operation.trim() === span.operation &&
        SAFE_OPERATION.test(span.operation)
          ? span.operation
          : "";
      const key = `${span.stage}:${operation}`;
      const row = grouped.get(key) ?? { stage: span.stage, operation, count: 0, totalMs: 0 };
      row.count++;
      row.totalMs += span.durationMs;
      grouped.set(key, row);
    }
    return {
      requestId: record.requestId,
      totalMs: record.totalMs,
      firstReplyAcceptedMs: duration(record.firstReplyAcceptedMs)
        ? record.firstReplyAcceptedMs
        : undefined,
      lastReplyAcceptedMs: duration(record.lastReplyAcceptedMs)
        ? record.lastReplyAcceptedMs
        : undefined,
      telegramDeliveryLagMs: duration(record.telegramDeliveryLagMs)
        ? record.telegramDeliveryLagMs
        : undefined,
      background: record.background,
      spans: [...grouped.values()].sort((a, b) => b.totalMs - a.totalMs),
    };
  }
  return undefined;
}

export function formatTimings(summary) {
  if (!summary)
    return "No completed response timings yet. Start the bot, send a Telegram query, wait for the reply, then run npm run timings.";
  const rows = [
    ["Stage", "Operation", "Count", "Total"],
    ...summary.spans.map((span) => [
      span.stage,
      span.operation || "-",
      String(span.count),
      ms(span.totalMs),
    ]),
  ];
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return [
    `Latest completed response: ${summary.requestId}`,
    `Total lifecycle: ${ms(summary.totalMs)}`,
    `First reply accepted: ${ms(summary.firstReplyAcceptedMs)}`,
    `Last reply accepted: ${ms(summary.lastReplyAcceptedMs)}`,
    `Background work: ${summary.background ? "yes" : "no"}`,
    ...(duration(summary.telegramDeliveryLagMs)
      ? [`Telegram delivery lag (approximate): ${ms(summary.telegramDeliveryLagMs)}`]
      : []),
    "",
    ...rows.map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join("  ")
        .trimEnd(),
    ),
    "",
    "Nested spans overlap; do not add their totals. Agent time includes model, tool and retry waits. Queue time includes chat and provider-slot waits.",
    "Reply accepted means Telegram accepted the send; it does not measure when your screen displayed it.",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let jsonl = "";
  try {
    jsonl = await readFile(
      process.env.RESPONSE_TIMING_FILE ?? "./data/response-timings.jsonl",
      "utf8",
    );
  } catch {
    // Diagnostics stay useful when the bot has not written a trace yet.
  }
  console.log(formatTimings(summarizeTimings(jsonl)));
}
