import { AsyncLocalStorage } from "node:async_hooks";

interface Intake {
  release: () => void;
}

const currentIntake = new AsyncLocalStorage<Intake>();
const admissionGates = new Map<string, Promise<void>>();

/** Let the next update prepare once this update has reserved its work in the chat queue. */
export function releaseChatIntake(): void {
  currentIntake.getStore()?.release();
}

/** Preserve per-chat admission order without holding intake until a queued model run finishes. */
export async function withChatIntake<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const previous = admissionGates.get(chatId);
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  admissionGates.set(chatId, gate);
  await previous;

  let released = false;
  const intake: Intake = {
    release() {
      if (released) return;
      released = true;
      resolveGate();
      if (admissionGates.get(chatId) === gate) admissionGates.delete(chatId);
    },
  };
  return currentIntake.run(intake, async () => {
    try {
      return await task();
    } finally {
      intake.release();
    }
  });
}
