import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type TimingStage =
  | "intake_wait"
  | "queue_wait"
  | "chat_wait"
  | "provider_slot_wait"
  | "agent"
  | "prompt_preparation"
  | "model_discovery"
  | "model_request"
  | "tool"
  | "retry_wait"
  | "telegram_send"
  | "telegram_ack"
  | "telegram_edit"
  | "notion_read"
  | "media_download"
  | "transcription"
  | "album_wait";

type Span = {
  stage: TimingStage;
  startMs: number;
  durationMs: number;
  operation?: string;
  error?: true;
};
type Trace = {
  requestId: string;
  ts: string;
  kind: "message" | "callback";
  started: number;
  holds: number;
  error: boolean;
  background: boolean;
  spans: Span[];
  droppedSpans: number;
  firstReplyAcceptedMs?: number;
  lastReplyAcceptedMs?: number;
  telegramDeliveryLagMs?: number;
};
const scope = new AsyncLocalStorage<Trace>();
const writes = new Set<Promise<void>>();
const MAX_SPANS = 160;
const rounded = (value: number) => Math.round(Math.max(0, value) * 10) / 10;

// Accept fixed tool names and model IDs, never arguments, paths, outputs or raw errors.
function safeOperation(operation?: string): string | undefined {
  return operation &&
    operation.trim() === operation &&
    /^(?:gemini-[a-zA-Z0-9_.-]{1,75}|read_file|write_file|list_knowledge|move_knowledge|run_script(?::(?:calendar|exercise-db|notion|progression|publish-heatmap|report-card|send-photo|setup-workspace)\.mjs)?)$/.test(
      operation,
    )
    ? operation
    : undefined;
}

function addSpan(trace: Trace, span: Span): void {
  if (trace.holds <= 0) return;
  if (trace.spans.length < MAX_SPANS) trace.spans.push(span);
  else trace.droppedSpans++;
}

export function startTiming(stage: TimingStage, operation?: string): (error?: boolean) => void {
  const trace = scope.getStore();
  const start = performance.now();
  let finished = false;
  return (error = false) => {
    if (!trace || finished) return;
    finished = true;
    addSpan(trace, {
      stage,
      startMs: rounded(start - trace.started),
      durationMs: rounded(performance.now() - start),
      operation: safeOperation(operation),
      ...(error ? { error: true as const } : {}),
    });
  };
}

export function recordTiming(stage: TimingStage, durationMs: number, operation?: string): void {
  const trace = scope.getStore();
  if (!trace || !Number.isFinite(durationMs) || durationMs < 0) return;
  addSpan(trace, {
    stage,
    startMs: rounded(performance.now() - trace.started - durationMs),
    durationMs: rounded(durationMs),
    operation: safeOperation(operation),
  });
}

export async function measureTiming<T>(
  stage: TimingStage,
  task: () => Promise<T>,
  operation?: string,
): Promise<T> {
  const finish = startTiming(stage, operation);
  try {
    const result = await task();
    finish();
    return result;
  } catch (error) {
    finish(true);
    throw error;
  }
}

export function markReplyAccepted(): void {
  const trace = scope.getStore();
  if (!trace || trace.holds <= 0) return;
  const elapsed = rounded(performance.now() - trace.started);
  trace.firstReplyAcceptedMs ??= elapsed;
  trace.lastReplyAcceptedMs = elapsed;
}

function release(trace: Trace): void {
  if (--trace.holds !== 0) return;
  const { started, holds: _holds, ...record } = trace;
  const totalMs = rounded(performance.now() - started);
  const file = process.env.RESPONSE_TIMING_FILE ?? "./data/response-timings.jsonl";
  const write = (async () => {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify({ ...record, totalMs })}\n`, "utf8");
    } catch {
      console.warn("[timing] Could not write response timings.");
    }
  })();
  writes.add(write);
  void write.then(() => writes.delete(write));
}

/** Detached rapid logs and album work belong to the initiating update's trace. */
export function retainTimingUntil(task: Promise<unknown>): void {
  const trace = scope.getStore();
  if (!trace || trace.holds <= 0) return;
  trace.holds++;
  trace.background = true;
  void task.then(
    () => release(trace),
    () => {
      trace.error = true;
      release(trace);
    },
  );
}

export async function withResponseTiming<T>(
  kind: Trace["kind"],
  task: () => Promise<T>,
  telegramDate?: number,
): Promise<T> {
  const trace: Trace = {
    requestId: randomUUID(),
    ts: new Date().toISOString(),
    kind,
    started: performance.now(),
    holds: 1,
    error: false,
    background: false,
    spans: [],
    droppedSpans: 0,
    ...(Number.isFinite(telegramDate)
      ? { telegramDeliveryLagMs: Math.max(0, Date.now() - telegramDate! * 1000) }
      : {}),
  };
  return scope.run(trace, async () => {
    try {
      return await task();
    } catch (error) {
      trace.error = true;
      throw error;
    } finally {
      release(trace);
    }
  });
}

/** Optional displays are outside the reply lifecycle. */
export function withoutTiming<T>(task: () => T): T {
  return scope.exit(task);
}

export async function flushTimings(): Promise<void> {
  await Promise.all([...writes]);
}
