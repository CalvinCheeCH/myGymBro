import crypto from "node:crypto";
import http from "node:http";
import type { Bot } from "grammy";
import { config } from "../config.js";
import { type ScheduledTask, executeTask, getTask } from "../scheduler/scheduler.js";
import { TtlSet } from "../util/dedupe.js";
import { isAllowed } from "./permissions.js";

/**
 * HTTP server for webhook mode. This is what lets the service scale to zero on a
 * host like Cloud Run: there is no long-polling loop, the platform cold-starts an
 * instance when a request arrives. Routes:
 *
 *  - POST /webhook/telegram : Telegram pushes updates here. The secret token set
 *    via setWebhook is echoed back on every delivery and verified. We acknowledge
 *    with 200 immediately and process in the background, so a long agent run never
 *    makes Telegram time out and retry. Duplicate deliveries are dropped.
 *  - POST /cron/run : the external scheduler (Cloud Scheduler) calls this to fire a
 *    reminder. Authorised with a bearer CRON_SECRET. Body: {"taskId": "..."} to run
 *    a defined reminder, or {"chatId": "...", "prompt": "..."} for an ad hoc one.
 *  - GET /healthz : liveness.
 *
 * For background work to complete after the 200 response, the Cloud Run service
 * must run with CPU always allocated (--no-cpu-throttling); otherwise the instance
 * freezes the moment the response is sent. min-instances can still be 0.
 */

// Telegram has no per-webhook signing secret; instead a secret_token set via
// setWebhook is echoed back on every delivery. Derived from the bot token so
// there is no extra secret to manage.
const webhookSecret = crypto.createHash("sha256").update(config.telegramBotToken).digest("hex");

// Telegram redelivers until the webhook returns 200; replays are dropped.
const seenUpdates = new TtlSet(10 * 60 * 1000);

// Cap the body so a malformed or hostile POST cannot buffer unbounded memory.
// Telegram updates and cron payloads are tiny; 1 MB is comfortably generous.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PENDING_UPDATES = 32;
const MAX_PENDING_TASKS = 2;

class BodyError extends Error {
  constructor(readonly status: number) {
    super(status === 413 ? "payload too large" : "incomplete request body");
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: BodyError) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onError);
      if (error) {
        req.pause();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(new BodyError(413));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => finish();
    const onError = () => finish(new BodyError(400));
    const timer = setTimeout(() => finish(new BodyError(408)), 10_000);
    timer.unref();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onError);
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) finish(new BodyError(413));
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function startWebhookServer(bot: Bot): http.Server {
  let pendingUpdates = 0;
  const pendingTasks = new Set<string>();
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        ...(code >= 400 ? { Connection: "close" } : {}),
        ...(code === 503 ? { "Retry-After": "5" } : {}),
      });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) {
      send(200, { status: "healthy" });
      return;
    }

    // ── Telegram updates ──────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/webhook/telegram") {
      const token = req.headers["x-telegram-bot-api-secret-token"];
      if (typeof token !== "string" || !timingSafeEqual(token, webhookSecret)) {
        send(401, { error: "bad secret token" });
        return;
      }
      if (pendingUpdates >= MAX_PENDING_UPDATES) {
        send(503, { error: "busy; retry later" });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (error) {
        send(error instanceof BodyError ? error.status : 400, { error: "invalid request body" });
        return;
      }

      let update: any;
      try {
        update = JSON.parse(raw);
      } catch {
        send(400, { error: "invalid JSON" });
        return;
      }
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        send(400, { error: "invalid Telegram update" });
        return;
      }
      const message = update.message ?? update.callback_query?.message;
      const sender = update.callback_query?.from ?? message?.from;
      if (
        message?.chat?.type !== "private" ||
        !Number.isSafeInteger(sender?.id) ||
        !isAllowed(sender.id) ||
        String(message.chat.id) !== String(sender.id)
      ) {
        send(200);
        return;
      }
      if (pendingUpdates >= MAX_PENDING_UPDATES) {
        send(503, { error: "busy; retry later" });
        return;
      }
      if (seenUpdates.seen(String(update.update_id))) {
        send(200);
        return;
      }
      // Reserve before acknowledging so parallel deliveries cannot bypass the cap.
      pendingUpdates++;
      send(200);
      // Fire and forget: runs are long, the response is already sent. Requires
      // CPU-always-allocated on Cloud Run so this keeps executing.
      void bot
        .handleUpdate(update)
        .catch((err) => console.error("[webhook] handleUpdate failed:", err?.message))
        .finally(() => pendingUpdates--);
      return;
    }

    // ── Reminder trigger from the external scheduler ──────────────────
    if (req.method === "POST" && req.url === "/cron/run") {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${config.cronSecret}`;
      if (!config.cronSecret || !timingSafeEqual(auth, expected)) {
        send(401, { error: "unauthorized" });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (error) {
        send(error instanceof BodyError ? error.status : 400, { error: "invalid request body" });
        return;
      }

      let payload: { taskId?: string; chatId?: string; prompt?: string };
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        send(400, { error: "invalid JSON" });
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        send(400, { error: "invalid reminder payload" });
        return;
      }

      let task: ScheduledTask | undefined;
      if (typeof payload.taskId === "string" && payload.taskId.length <= 128 && payload.taskId) {
        task = getTask(payload.taskId);
        if (!task) {
          send(404, { error: "task not found" });
          return;
        }
        if (!task.enabled) {
          send(409, { error: "task disabled" });
          return;
        }
      } else if (
        payload.taskId === undefined &&
        typeof payload.chatId === "string" &&
        /^\d+$/.test(payload.chatId) &&
        typeof payload.prompt === "string" &&
        payload.prompt.trim() &&
        payload.prompt.length <= 16_384
      ) {
        task = {
          id: `adhoc-${crypto.randomUUID()}`,
          name: "ad hoc reminder",
          cron: "",
          prompt: payload.prompt,
          chatId: payload.chatId,
          enabled: true,
          modelTier: "standard",
        };
      } else {
        send(400, { error: "taskId, or chatId and prompt are required" });
        return;
      }
      if (!isAllowed(task.chatId)) {
        send(403, { error: "recipient is not allowed" });
        return;
      }
      if (pendingTasks.has(task.id)) {
        send(200, { ok: true, alreadyRunning: true });
        return;
      }
      if (pendingTasks.size >= MAX_PENDING_TASKS) {
        send(503, { error: "busy; retry later" });
        return;
      }
      pendingTasks.add(task.id);
      send(200, { ok: true });
      void executeTask(task)
        .catch((err) => console.error("[cron] task failed:", err?.message))
        .finally(() => pendingTasks.delete(task.id));
      return;
    }

    send(404, { error: "not found" });
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.timeout = 15_000;
  server.maxConnections = 128;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[webhook] Listening on :${config.port} (/webhook/telegram, /cron/run, /healthz)`);
  });
  return server;
}

/** Register the Telegram webhook with Telegram on startup. */
export async function registerTelegramWebhook(bot: Bot): Promise<void> {
  if (!config.publicBaseUrl) {
    console.warn("[webhook] PUBLIC_BASE_URL unset; cannot register Telegram webhook");
    return;
  }
  const url = new URL("/webhook/telegram", config.publicBaseUrl).toString();
  await bot.api.setWebhook(url, {
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
  });
  console.log(`[webhook] Telegram webhook set to ${url}`);
}
