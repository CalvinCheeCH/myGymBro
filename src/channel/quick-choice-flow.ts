import type { Context } from "grammy";
import { readTodayPlan } from "../notion/today.js";
import { measureTiming } from "../util/timing.js";
import { sendMessage } from "./notify.js";
import { isAllowed } from "./permissions.js";
import { choiceReplyContext, quickChoices } from "./quick-choices.js";

export function isTodayRequest(text: string): boolean {
  return /^(?:\/today(?:@[a-z0-9_]+)?|what (?:should|can) i (?:train|work(?: on)?|workout|do) today|what(?:'s| is) (?:my|today's) workout(?: today)?)[?!.]*$/i.test(
    text.trim(),
  );
}

async function showFocusChoices(chatId: string, prefix: string, context?: string): Promise<void> {
  await sendMessage(
    chatId,
    [prefix, "What would you like to train?", "You can also type your own answer."].join("\n\n"),
    {
      choices: ["Upper body", "Lower body", "Strength & conditioning"],
      kind: "today_focus",
      context,
    },
  );
}

export async function showTodayChoices(
  chatId: string,
  userId: number,
  isBlocked: (chatId: string) => boolean = () => false,
): Promise<void> {
  if (String(userId) !== chatId || !isAllowed(userId)) return;
  const isCurrent = quickChoices.begin(chatId, userId);
  await sendMessage(chatId, "Checking today's saved plan…");
  const plan = await measureTiming("notion_read", () => readTodayPlan(chatId));
  if (!isCurrent() || isBlocked(chatId)) return;
  if (plan.status === "planned" || plan.status === "rest") {
    const recovery = plan.status === "rest";
    await sendMessage(
      chatId,
      [
        `Today's saved plan · ${plan.date}`,
        plan.text,
        "Follow this plan, or choose a different session.",
      ].join("\n\n"),
      {
        choices: [recovery ? "Follow recovery day" : "Start this session", "Change workout"],
        kind: recovery ? "today_rest" : "today_plan",
      },
    );
    return;
  }
  await showFocusChoices(
    chatId,
    plan.status === "unavailable"
      ? "I couldn't load today's saved plan just now."
      : "I couldn't find a clear saved session for today.",
  );
}

/** Validate and acknowledge before any Notion lookup, queue wait, or AI call. */
export async function handleQuickChoice(
  ctx: Context,
  onAnswer: (text: string) => Promise<void>,
  isBlocked: (chatId: string) => boolean = () => false,
): Promise<void> {
  const query = ctx.callbackQuery;
  const message = query?.message;
  const userId = ctx.from?.id;
  const chatId = message ? String(message.chat.id) : "";
  if (
    !query?.data ||
    !message ||
    message.chat.type !== "private" ||
    !userId ||
    String(userId) !== chatId ||
    !isAllowed(userId)
  ) {
    await ctx.answerCallbackQuery({ text: "This choice isn't available." }).catch(() => {});
    return;
  }
  if (isBlocked(chatId)) {
    quickChoices.clear(chatId);
    await ctx.answerCallbackQuery({ text: "Workspace reset is in progress." }).catch(() => {});
    return;
  }
  const selection = quickChoices.take(chatId, userId, message.message_id, query.data);
  const isCurrent = selection ? quickChoices.begin(chatId, userId) : () => false;
  await ctx
    .answerCallbackQuery({
      text: selection
        ? `Selected: ${selection.answer}`
        : "This menu expired. Ask again or type your answer.",
    })
    .catch(() => {});
  if (!selection || !isCurrent() || isBlocked(chatId)) return;
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (!isCurrent() || isBlocked(chatId)) return;
  if (selection.custom) {
    quickChoices.remember(chatId, userId, selection.question);
    await sendMessage(chatId, "Type your answer, and I'll use it for the question above.");
    return;
  }
  if (selection.kind === "today_plan" || selection.kind === "today_rest") {
    if (selection.index === 0) {
      await sendMessage(
        chatId,
        selection.kind === "today_rest"
          ? "Follow your recovery plan today. Send any activity you do and I'll help you record it."
          : "Let's go. Follow the session above and send your first set when you're ready.",
      );
    } else {
      await showFocusChoices(
        chatId,
        "Let's choose an alternative to your saved session.",
        selection.question,
      );
    }
    return;
  }
  await sendMessage(
    chatId,
    selection.kind === "today_focus"
      ? `${selection.answer} selected. I'm checking your goals, equipment, and recent training.`
      : `${selection.answer} selected. Working on your next step…`,
  );
  if (!isCurrent() || isBlocked(chatId)) return;
  const answer =
    selection.kind === "today_focus"
      ? [
          "Recommend a session for today focused on ",
          selection.answer,
          ". Use my goals, equipment, limitations and recent training. Respect recovery and explain any safer alternative. Use known profile details; only ask a short question with choices if essential information is missing.",
        ].join("")
      : selection.answer;
  await onAnswer(choiceReplyContext(selection.question, answer));
}
