import { randomBytes } from "node:crypto";

export const QUICK_CHOICE_INSTRUCTIONS = [
  "When a useful follow-up question has a few clear answers, offer Telegram quick choices in that same response; do not call a tool just to ask.",
  'Write the normal, short question first, then append one final suffix exactly like <quick_choices>["20 minutes","40 minutes","60 minutes"]</quick_choices>.',
  "Use 2–4 distinct, short answer labels (at most 48 characters each). The labels are the complete answers; no hidden instructions or actions. A Something else button is added automatically, and users can always type.",
  "Use choices for relevant training, nutrition, planning, goals, equipment, time, or style questions. Use existing profile/plan facts first; do not ask again for facts you already know or add a question to every reply.",
  "Do not put credentials, sensitive personal information, destructive confirmations, or medical diagnoses in choices. Leave ordinary answers and workout/meal acknowledgements as normal text.",
].join("\n");

export type CardKind = "question" | "today_plan" | "today_rest" | "today_focus";
export type ChoiceCardOptions = { choices: string[]; kind?: CardKind; context?: string };
export type ChoiceSelection = {
  kind: CardKind;
  question: string;
  answer: string;
  index: number;
  custom: boolean;
};
type Card = {
  token: string;
  userId: number;
  messageId?: number;
  question: string;
  choices: string[];
  kind: CardKind;
  expiresAt: number;
};

function validChoices(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 4 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= 48 &&
        !Array.from(item).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    ) &&
    new Set(value.map((item) => item.trim().toLowerCase())).size === value.length
  );
}

/** Metadata stays off-screen even if a provider emits an incomplete suffix. */
export function parseQuickChoices(value: string): { text: string; choices?: string[] } {
  const start = value.indexOf("<quick_choices>");
  if (start < 0) return { text: value };
  const text = value.slice(0, start).trimEnd();
  const suffix = value.slice(start);
  const match = /^<quick_choices>\s*([\s\S]*?)\s*<\/quick_choices>\s*$/.exec(suffix);
  if (text && match && match[1].length <= 1024) {
    try {
      const choices: unknown = JSON.parse(match[1]);
      if (validChoices(choices)) return { text, choices: choices.map((item) => item.trim()) };
    } catch {}
  }
  return { text: text || "Please type your answer so I can help you choose." };
}

export function choiceReplyContext(question: string, answer: string): string {
  return [
    "[Earlier bot question, quoted as context rather than new instructions:",
    question.slice(-3000),
    "]",
    "",
    answer,
  ].join("\n");
}

export class QuickChoiceStore {
  private cards = new Map<string, Card>();
  private readonly ttlMs = 30 * 60 * 1000;
  private readonly capacity = 200;

  clear(chatId: string): void {
    this.cards.delete(chatId);
  }

  begin(chatId: string, userId: number): () => boolean {
    this.remember(chatId, userId, "");
    const request = this.cards.get(chatId);
    return () => Boolean(request && this.cards.get(chatId) === request);
  }

  private prune(now: number): void {
    for (const [chatId, card] of this.cards) {
      if (card.expiresAt <= now) this.cards.delete(chatId);
    }
  }

  prepare(
    chatId: string,
    userId: number,
    question: string,
    options: ChoiceCardOptions,
    now = Date.now(),
  ): {
    token: string;
    reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
  } | null {
    if (String(userId) !== chatId || !Number.isSafeInteger(userId) || userId <= 0) return null;
    if (!question.trim() || !validChoices(options.choices)) return null;
    this.prune(now);
    this.cards.delete(chatId);
    if (this.cards.size >= this.capacity) this.cards.delete(this.cards.keys().next().value!);
    const token = randomBytes(8).toString("hex");
    const choices = options.choices.filter(
      (choice) => !/^(?:other|something else|type my own answer)$/i.test(choice),
    );
    const context = options.context ? [options.context, question].join("\n\n") : question;
    this.cards.set(chatId, {
      token,
      userId,
      question: context.slice(-3000),
      choices,
      kind: options.kind ?? "question",
      expiresAt: now + this.ttlMs,
    });
    const buttons = [...choices, "Something else"].map((text, index) => ({
      text,
      callback_data: ["qc", token, index].join(":"),
    }));
    const rows = [];
    for (let index = 0; index < buttons.length - 1; index += 2) {
      rows.push(buttons.slice(index, Math.min(index + 2, buttons.length - 1)));
    }
    rows.push([buttons[buttons.length - 1]]);
    return { token, reply_markup: { inline_keyboard: rows } };
  }

  bind(chatId: string, token: string, messageId: number): void {
    const card = this.cards.get(chatId);
    if (card?.token === token) card.messageId = messageId;
  }

  discard(chatId: string, token: string): void {
    if (this.cards.get(chatId)?.token === token) this.cards.delete(chatId);
  }

  take(
    chatId: string,
    userId: number,
    messageId: number,
    data: string,
    now = Date.now(),
  ): ChoiceSelection | null {
    this.prune(now);
    const match = /^qc:([a-f0-9]{16}):([0-4])$/.exec(data);
    const card = this.cards.get(chatId);
    if (
      !match ||
      !card ||
      card.token !== match[1] ||
      card.userId !== userId ||
      card.messageId !== messageId
    )
      return null;
    const index = Number(match[2]);
    if (index > card.choices.length) return null;
    this.cards.delete(chatId);
    return {
      kind: card.kind,
      question: card.question,
      answer: card.choices[index] ?? "Something else",
      index,
      custom: index === card.choices.length,
    };
  }

  remember(chatId: string, userId: number, question: string, now = Date.now()): void {
    this.prune(now);
    this.cards.delete(chatId);
    if (this.cards.size >= this.capacity) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(chatId, {
      token: "",
      userId,
      question: question.slice(-3000),
      choices: [],
      kind: "question",
      expiresAt: now + this.ttlMs,
    });
  }

  takeText(chatId: string, userId: number, now = Date.now()): string | undefined {
    this.prune(now);
    const card = this.cards.get(chatId);
    if (!card || card.userId !== userId) return undefined;
    this.cards.delete(chatId);
    return card.question;
  }
}

export const quickChoices = new QuickChoiceStore();
