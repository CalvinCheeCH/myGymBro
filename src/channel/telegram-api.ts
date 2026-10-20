import type { Transformer } from "grammy";
import { markReplyAccepted, measureTiming, startTiming } from "../util/timing.js";

/** Time Telegram delivery without recording chat IDs, payloads or transport errors. */
export const telegramApiTransformer: Transformer = async (prev, method, payload, signal) => {
  // The polling receiver owns its abortable retries; long polls are not response latency.
  if (method === "getUpdates") return prev(method, payload, signal);
  const stage = ["sendMessage", "sendPhoto", "sendDocument"].includes(method)
    ? "telegram_send"
    : method === "answerCallbackQuery"
      ? "telegram_ack"
      : method === "editMessageReplyMarkup"
        ? "telegram_edit"
        : undefined;

  const request = async () => {
    const finish = stage ? startTiming(stage) : undefined;
    try {
      const result = await prev(method, payload, signal);
      finish?.(!result.ok);
      if (result.ok && stage === "telegram_send") markReplyAccepted();
      return result;
    } catch (error) {
      finish?.(true);
      throw error;
    }
  };

  let result = await request();
  for (let attempt = 0; attempt < 3 && !result.ok && result.error_code === 429; attempt++) {
    const retryAfter = result.parameters?.retry_after ?? 1;
    await measureTiming(
      "retry_wait",
      () => new Promise<void>((resolve) => setTimeout(resolve, (retryAfter + 0.5) * 1000)),
    );
    result = await request();
  }
  return result;
};
