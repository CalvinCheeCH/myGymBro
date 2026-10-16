import http from "node:http";
import { Cron } from "croner";
import { isAllowed } from "../channel/permissions.js";
import { type ScheduledTask, addTask, listTasks, removeTask } from "./scheduler.js";

/**
 * Localhost-only control plane for reminders. The agent (running as a child process
 * on the same host) can curl these endpoints to manage scheduled tasks live, so
 * "remind me to train at 6pm on weekdays" takes effect immediately rather than on
 * the next restart. Bound to 127.0.0.1 only, so it is not reachable off-box.
 */

const PORT = 9130;
const MAX_BODY_BYTES = 32 * 1024;

export function startSchedulerServer(): http.Server {
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        ...(code >= 400 ? { Connection: "close" } : {}),
      });
      res.end(JSON.stringify(body));
    };

    // Local agent/curl only: prevent a browser page or DNS rebinding from reading or changing tasks.
    if (
      ![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host ?? "") ||
      req.headers.origin !== undefined ||
      (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "none")
    ) {
      send(403, { error: "local clients only" });
      return;
    }

    if (req.method === "GET" && req.url === "/tasks") {
      send(200, { tasks: listTasks() });
      return;
    }

    if (req.method === "POST" && req.url === "/tasks") {
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      const rejectBody = (status: number) => {
        if (rejected || res.writableEnded) return;
        rejected = true;
        clearTimeout(timer);
        req.pause();
        send(status, { error: "invalid request body" });
      };
      const timer = setTimeout(() => rejectBody(408), 10_000);
      timer.unref();
      req.on("error", () => rejectBody(400));
      req.on("aborted", () => clearTimeout(timer));
      req.on("data", (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) rejectBody(413);
        else chunks.push(chunk);
      });
      req.on("end", () => {
        clearTimeout(timer);
        if (rejected) return;
        try {
          const t = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ScheduledTask>;
          const stringField = (value: unknown, max: number): value is string =>
            typeof value === "string" && value.trim().length > 0 && value.length <= max;
          if (
            !t ||
            Array.isArray(t) ||
            !stringField(t.name, 200) ||
            !stringField(t.cron, 200) ||
            !stringField(t.prompt, 16_384) ||
            typeof t.chatId !== "string" ||
            !/^\d+$/.test(t.chatId) ||
            (t.id !== undefined && (typeof t.id !== "string" || !/^[\w.-]{1,128}$/.test(t.id))) ||
            (t.enabled !== undefined && typeof t.enabled !== "boolean") ||
            (t.modelTier !== undefined && !["fast", "standard"].includes(t.modelTier))
          ) {
            send(400, { error: "invalid task fields" });
            return;
          }
          if (!isAllowed(t.chatId)) {
            send(403, { error: "recipient is not allowed" });
            return;
          }
          if (listTasks().length >= 32 && !listTasks().some((task) => task.id === t.id)) {
            send(409, { error: "task limit reached" });
            return;
          }
          // Validate before addTask mutates the live definitions.
          new Cron(t.cron, { paused: true }).stop();
          const task: ScheduledTask = {
            id: t.id || `task-${Date.now()}`,
            name: t.name,
            cron: t.cron,
            prompt: t.prompt,
            chatId: t.chatId,
            enabled: t.enabled ?? true,
            modelTier: t.modelTier ?? "standard",
          };
          addTask(task);
          send(200, { ok: true, task });
        } catch {
          send(400, { error: "invalid task or cron expression" });
        }
      });
      if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) rejectBody(413);
      return;
    }

    if (req.method === "DELETE" && req.url?.startsWith("/tasks/")) {
      let id: string;
      try {
        id = decodeURIComponent(req.url.slice("/tasks/".length));
      } catch {
        send(400, { error: "invalid task id" });
        return;
      }
      if (!/^[\w.-]{1,128}$/.test(id)) {
        send(400, { error: "invalid task id" });
        return;
      }
      const removed = removeTask(id);
      send(removed ? 200 : 404, { ok: removed });
      return;
    }

    send(404, { error: "Not found" });
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.timeout = 15_000;
  server.maxConnections = 32;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[scheduler] Control plane on http://localhost:${PORT}/tasks`);
  });
  return server;
}
