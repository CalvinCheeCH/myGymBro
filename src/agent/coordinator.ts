import { startTiming } from "../util/timing.js";

/** Serialize all agent work per chat and cap total provider queries. */
const MAX_CONCURRENT_QUERIES = 2;
const MAX_PENDING_PER_CHAT = 20;
const MAX_PENDING_TOTAL = 64;
let activeQueries = 0;
let pendingTotal = 0;
const pendingByChat = new Map<string, number>();
const slotWaiters: Array<() => void> = [];
const chatChains = new Map<string, Promise<unknown>>();

export class QueueFullError extends Error {
  constructor() {
    super("The coach is busy. Please try again shortly.");
    this.name = "QueueFullError";
  }
}

function drainSlots(): void {
  while (slotWaiters.length > 0 && activeQueries < MAX_CONCURRENT_QUERIES) {
    activeQueries++;
    slotWaiters.shift()?.();
  }
}

async function acquireSlot(): Promise<void> {
  if (activeQueries < MAX_CONCURRENT_QUERIES) {
    activeQueries++;
    return;
  }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(): void {
  activeQueries--;
  drainSlots();
}

export function enqueueChatRun<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const finishQueueWait = startTiming("queue_wait");
  const chatPending = pendingByChat.get(chatId) ?? 0;
  if (chatPending >= MAX_PENDING_PER_CHAT || pendingTotal >= MAX_PENDING_TOTAL) {
    finishQueueWait(true);
    return Promise.reject(new QueueFullError());
  }
  pendingByChat.set(chatId, chatPending + 1);
  pendingTotal++;
  const finishChatWait = startTiming("chat_wait");
  const previous = chatChains.get(chatId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      finishChatWait();
      const finishSlotWait = startTiming("provider_slot_wait");
      await acquireSlot();
      finishSlotWait();
      finishQueueWait();
      try {
        return await task();
      } finally {
        releaseSlot();
      }
    });
  chatChains.set(chatId, current);

  const cleanup = () => {
    pendingTotal--;
    const remaining = (pendingByChat.get(chatId) ?? 1) - 1;
    if (remaining === 0) pendingByChat.delete(chatId);
    else pendingByChat.set(chatId, remaining);
    if (chatChains.get(chatId) === current) chatChains.delete(chatId);
  };
  void current.then(cleanup, cleanup);
  return current;
}

/** Shutdown waits for accepted saves, including detached rapid logs. */
export async function drainChatRuns(): Promise<void> {
  while (chatChains.size) await Promise.allSettled([...chatChains.values()]);
}
