import { setTimeout as delay } from "node:timers/promises";
import { type Bot, BotError, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { isAllowed } from "./permissions.js";

const MAX_PENDING_UPDATES = 32;
const MAX_UNCONFIRMED_UPDATES = 100;
const runningBots = new WeakSet<Bot>();

function isAuthorized(update: Update): boolean {
  const message = update.message ?? update.callback_query?.message;
  const sender = update.callback_query?.from ?? message?.from;
  return (
    message?.chat?.type === "private" &&
    Number.isSafeInteger(sender?.id) &&
    isAllowed(sender!.id) &&
    String(message.chat.id) === String(sender!.id)
  );
}

/** Receive new updates while earlier coaching runs, retaining a bounded backlog in Telegram. */
export function startPolling(bot: Bot): { done: Promise<void>; stop: () => Promise<void> } {
  if (!bot.isInited()) throw new Error("Initialize the bot before starting polling.");
  if (bot.isRunning() || runningBots.has(bot)) {
    throw new Error("Another polling loop is already running.");
  }
  runningBots.add(bot);
  const abort = new AbortController();
  const active = new Set<Promise<void>>();
  // Telegram returns only its first 100 unconfirmed updates; keep IDs/status, never message bodies.
  const completed = new Map<number, boolean>();
  let offset = 0;
  let failure: { error: unknown } | undefined;

  function advanceOffset(): void {
    for (const [id, done] of completed) {
      if (!done) break;
      offset = id + 1;
      completed.delete(id);
    }
  }

  function dispatch(update: Update): void {
    completed.set(update.update_id, false);
    const task = (async () => {
      try {
        await bot.handleUpdate(update);
      } catch (error) {
        if (error instanceof BotError) await bot.errorHandler(error);
        else throw error;
      }
    })()
      .then(() => {
        completed.set(update.update_id, true);
        advanceOffset();
      })
      .catch((error) => {
        failure ??= { error };
        abort.abort();
      })
      .finally(() => active.delete(task));
    active.add(task);
  }

  async function waitForProgress(): Promise<void> {
    const pause = new AbortController();
    const signal = AbortSignal.any([abort.signal, pause.signal]);
    try {
      await Promise.race([
        ...active,
        delay(500, undefined, { signal }).catch((error) => {
          if (!signal.aborted) throw error;
        }),
      ]);
    } finally {
      pause.abort();
    }
  }

  const done = (async () => {
    try {
      while (!abort.signal.aborted) {
        if (active.size >= MAX_PENDING_UPDATES) {
          await Promise.race(active);
          continue;
        }
        let updates: Update[];
        try {
          updates = await bot.api.getUpdates(
            {
              offset,
              // A smaller limit could return only already-running IDs and hide newer callbacks.
              limit: MAX_UNCONFIRMED_UPDATES,
              timeout: 30,
              allowed_updates: ["message", "callback_query"],
            },
            abort.signal as unknown as Parameters<typeof bot.api.getUpdates>[1],
          );
        } catch (error) {
          if (abort.signal.aborted) break;
          if (error instanceof GrammyError && [401, 409].includes(error.error_code)) throw error;
          const retryAfter =
            error instanceof GrammyError && error.error_code === 429
              ? error.parameters.retry_after
              : undefined;
          const waitMs = (retryAfter && retryAfter > 0 ? retryAfter : 3) * 1000;
          console.warn(`[polling] Telegram update fetch failed; retrying in ${waitMs / 1000}s.`);
          await delay(waitMs, undefined, { signal: abort.signal }).catch((error) => {
            if (!abort.signal.aborted) throw error;
          });
          continue;
        }
        let admitted = false;
        for (const update of updates) {
          if (abort.signal.aborted) break;
          if (
            !Number.isSafeInteger(update.update_id) ||
            update.update_id < offset ||
            completed.has(update.update_id)
          )
            continue;
          if (completed.size >= MAX_UNCONFIRMED_UPDATES) break;
          const authorized = isAuthorized(update);
          if (authorized && active.size >= MAX_PENDING_UPDATES) break;
          admitted = true;
          if (authorized) dispatch(update);
          else {
            completed.set(update.update_id, true);
            advanceOffset();
          }
        }
        // An unfinished head is returned immediately again; avoid a busy loop while retaining it.
        if (!admitted && completed.size > 0 && !abort.signal.aborted) await waitForProgress();
      }
    } catch (error) {
      failure ??= { error };
      abort.abort();
    } finally {
      await Promise.all(active);
    }
    if (failure) throw failure.error;
    if (offset > 0) {
      // Confirm completed work only; returned, unadmitted updates remain pending in Telegram.
      await bot.api.getUpdates(
        { offset, limit: 1, timeout: 0 },
        AbortSignal.timeout(5_000) as unknown as Parameters<typeof bot.api.getUpdates>[1],
      );
    }
  })().finally(() => runningBots.delete(bot));

  return {
    done,
    stop: async () => {
      abort.abort();
      await done;
    },
  };
}
