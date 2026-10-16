import { redactSecrets } from "../util/redact.js";

type Refresh = () => Promise<void>;
const pending = new Map<string, Map<string, Refresh>>();
const ready = new Map<string, Refresh>();
let running: Promise<void> | undefined;
let paused = 0;

/** Stage optional displays until the requesting chat's reply has been delivered. */
export function requestVisualRefresh(chatId: string, key: string, refresh: Refresh): void {
  if (paused) return;
  const requests = pending.get(chatId) ?? new Map<string, Refresh>();
  requests.set(key, refresh);
  pending.set(chatId, requests);
}

export function isVisualRefreshPaused(): boolean {
  return paused > 0;
}

/** One workspace writer; new requests during a run leave one latest rerun. */
export function flushVisualRefreshes(chatId: string): Promise<void> {
  if (paused) return Promise.resolve();
  for (const [key, refresh] of pending.get(chatId) ?? []) ready.set(key, refresh);
  pending.delete(chatId);
  return startReadyWorker();
}

function startReadyWorker(): Promise<void> {
  if (paused) return Promise.resolve();
  if (running) return running;
  if (!ready.size) return Promise.resolve();
  // Snapshot this reply's intents now; start I/O after the provider slot is released.
  running = new Promise<void>((resolve) => setImmediate(resolve))
    .then(async () => {
      while (!paused && ready.size) {
        const [key, refresh] = ready.entries().next().value!;
        ready.delete(key);
        try {
          await refresh();
        } catch (error) {
          console.warn("[notion] Background display refresh failed:", redactSecrets(String(error)));
        }
      }
    })
    .finally(() => {
      running = undefined;
      if (!paused && ready.size) void startReadyWorker();
    });
  return running;
}

/** Reset waits for the current writer and discards stale display requests. */
export async function withVisualRefreshPaused<T>(task: () => Promise<T>): Promise<T> {
  paused++;
  pending.clear();
  ready.clear();
  try {
    await running;
    return await task();
  } finally {
    pending.clear();
    ready.clear();
    paused--;
  }
}
