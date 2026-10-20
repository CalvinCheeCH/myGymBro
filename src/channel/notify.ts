import type { Bot } from "grammy";
import { redactSecrets } from "../util/redact.js";
import { toPlainText, toTelegramHtml } from "./format.js";
import { type ChoiceCardOptions, parseQuickChoices, quickChoices } from "./quick-choices.js";

let botRef: Bot | null = null;

export function registerBot(bot: Bot): void {
  botRef = bot;
}

/** Shared delivery for direct replies and scheduled coaching, including optional answer buttons. */
export async function sendMessage(
  chatId: string | number,
  text: string,
  options?: ChoiceCardOptions,
): Promise<void> {
  if (!botRef) {
    console.warn("[notify] No bot registered, cannot send message");
    return;
  }
  const parsed = parseQuickChoices(redactSecrets(text));
  const choices = options?.choices ?? parsed.choices;
  const card = choices
    ? quickChoices.prepare(String(chatId), Number(chatId), parsed.text, {
        ...options,
        choices: choices.map((choice) => redactSecrets(choice)),
        context: options?.context ? redactSecrets(options.context) : undefined,
      })
    : null;
  const chunks = splitMessage(parsed.text, 4096);
  try {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const reply_markup = card && index === chunks.length - 1 ? card.reply_markup : undefined;
      let message: { message_id: number };
      try {
        message = await botRef.api.sendMessage(chatId, toTelegramHtml(chunk), {
          parse_mode: "HTML",
          ...(reply_markup ? { reply_markup } : {}),
        });
      } catch {
        message = await botRef.api.sendMessage(
          chatId,
          toPlainText(chunk),
          reply_markup ? { reply_markup } : undefined,
        );
      }
      if (reply_markup) quickChoices.bind(String(chatId), card!.token, message.message_id);
    }
  } catch (error) {
    if (card) quickChoices.discard(String(chatId), card.token);
    throw error;
  }
}

/** Split a message into Telegram-sized chunks, preferring to break on newlines. */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
