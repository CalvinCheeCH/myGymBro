import assert from "node:assert/strict";
import { test } from "node:test";

process.env.QUICK_CHOICE_TEST_SECRET = "synthetic-private-choice-value";
const { QuickChoiceStore, choiceReplyContext, parseQuickChoices, quickChoices } = await import(
  "../dist/channel/quick-choices.js"
);
const { registerBot, sendMessage } = await import("../dist/channel/notify.js");

const question = "How much time do you have?";
const options = { choices: ["20 minutes", "40 minutes"] };
const markupButtons = (markup) => markup.inline_keyboard.flat();
function prepare(store, chatId = "42", now = 1000, supplied = options) {
  const card = store.prepare(chatId, Number(chatId), question, supplied, now);
  assert.ok(card);
  return card;
}
function dataFor(card, index = 0) {
  return markupButtons(card.reply_markup)[index].callback_data;
}
function mockDelivery(send) {
  const calls = [];
  registerBot({
    api: {
      sendMessage: async (chatId, text, config) => {
        const call = { chatId, text, config };
        calls.push(call);
        return send ? send(call, calls.length) : { message_id: 100 + calls.length };
      },
    },
  });
  return calls;
}

test("quick choices accept two to four trimmed, distinct short answer labels", () => {
  for (const choices of [
    ["20 minutes", "40 minutes"],
    ["A", "B", "C"],
    ["A", "B", "C", "D"],
  ]) {
    assert.deepEqual(
      parseQuickChoices(`${question}\n<quick_choices>${JSON.stringify(choices)}</quick_choices>`),
      {
        text: question,
        choices,
      },
    );
  }
  assert.deepEqual(
    parseQuickChoices(`${question}\n<quick_choices>[" 20 minutes ","40 minutes"]</quick_choices>`),
    {
      text: question,
      choices: ["20 minutes", "40 minutes"],
    },
  );
});

test("ordinary replies are unchanged and malformed metadata stays off screen", () => {
  const ordinary = "Saved: 3 sets of bench press.\nKeep the next set controlled.";
  assert.deepEqual(parseQuickChoices(ordinary), { text: ordinary });
  for (const suffix of [
    "not JSON",
    "{}",
    '["Only one"]',
    '["A","B","C","D","E"]',
    '["A",null]',
    '["A",2]',
    '["A",""]',
    '["A"," a "]',
    JSON.stringify(["A", "x".repeat(49)]),
    JSON.stringify(["A", "B\nC"]),
    JSON.stringify(["A", "B\u007fC"]),
    JSON.stringify(["A", "x".repeat(1100)]),
  ]) {
    assert.deepEqual(parseQuickChoices(`${question}\n<quick_choices>${suffix}</quick_choices>`), {
      text: question,
    });
  }
  for (const suffix of [
    '<quick_choices>["A",',
    '<quick_choices>["A","B"]</quick_choices> extra metadata',
    '<quick_choices>["A","B"]</quick_choices><quick_choices>["C","D"]</quick_choices>',
  ]) {
    assert.deepEqual(parseQuickChoices(`${question}\n${suffix}`), { text: question });
  }
  const empty = parseQuickChoices('<quick_choices>["A","B"]</quick_choices>');
  assert.ok(empty.text.length > 0);
  assert.equal(empty.choices, undefined);
  assert.equal(empty.text.includes("quick_choices"), false);
});

test("cards use opaque bounded callbacks and require the correct owner, chat, and bound message", () => {
  const store = new QuickChoiceStore();
  const card = prepare(store);
  const buttons = markupButtons(card.reply_markup);
  assert.deepEqual(
    buttons.map((button) => button.text),
    [...options.choices, "Something else"],
  );
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data, "utf8") < 64);
    assert.equal(button.callback_data.includes("minutes"), false);
    assert.equal(button.callback_data.includes(question), false);
  }
  assert.equal(store.take("42", 42, 100, dataFor(card), 1001), null);
  store.bind("42", card.token, 100);
  assert.equal(store.take("42", 43, 100, dataFor(card), 1001), null);
  assert.equal(store.take("43", 42, 100, dataFor(card), 1001), null);
  assert.equal(store.take("42", 42, 101, dataFor(card), 1001), null);
  assert.equal(store.take("42", 42, 100, `qc:${card.token}:4`, 1001), null);
  assert.equal(store.take("42", 42, 100, `qc:${card.token}:00`, 1001), null);
  assert.equal(store.take("42", 42, 100, "arbitrary text", 1001), null);
  assert.deepEqual(store.take("42", 42, 100, dataFor(card), 1001), {
    kind: "question",
    question,
    answer: "20 minutes",
    index: 0,
    custom: false,
  });
  assert.equal(store.take("42", 42, 100, dataFor(card), 1002), null);
  assert.equal(store.prepare("43", 42, question, options), null);
  assert.equal(store.prepare("-42", -42, question, options), null);
  assert.equal(store.prepare("42.5", 42.5, question, options), null);
  assert.equal(store.prepare("42", 42, " ", options), null);
  assert.equal(store.prepare("42", 42, question, { choices: ["A"] }), null);
});

test("expired and replaced cards are unusable without deleting the current valid card", () => {
  const store = new QuickChoiceStore();
  const expired = prepare(store);
  store.bind("42", expired.token, 100);
  assert.equal(store.take("42", 42, 100, dataFor(expired), 1000 + 30 * 60 * 1000), null);
  const first = prepare(store, "42", 2000);
  store.bind("42", first.token, 100);
  const second = prepare(store, "42", 2001);
  store.bind("42", first.token, 999);
  store.discard("42", first.token);
  store.bind("42", second.token, 101);
  assert.equal(store.take("42", 42, 100, dataFor(first), 2002), null);
  assert.equal(store.take("42", 42, 101, dataFor(second), 2002)?.answer, "20 minutes");
  const cleared = prepare(store, "42", 3000);
  store.bind("42", cleared.token, 100);
  store.clear("42");
  assert.equal(store.take("42", 42, 100, dataFor(cleared), 3001), null);
});

test("custom answers and typed replies retain question context exactly once", () => {
  const store = new QuickChoiceStore();
  const card = prepare(store, "42", 1000, {
    choices: ["Upper body", "Lower body", "Other"],
    kind: "today_focus",
    context: "Use my saved goals and recent plan.",
  });
  store.bind("42", card.token, 100);
  const buttons = markupButtons(card.reply_markup);
  assert.deepEqual(
    buttons.map((button) => button.text),
    ["Upper body", "Lower body", "Something else"],
  );
  const selected = store.take("42", 42, 100, dataFor(card, 2), 1001);
  assert.equal(selected.custom, true);
  assert.equal(selected.kind, "today_focus");
  assert.equal(selected.question, `Use my saved goals and recent plan.\n\n${question}`);
  store.remember("42", 42, selected.question, 1002);
  assert.equal(store.takeText("42", 43, 1003), undefined);
  assert.equal(store.takeText("42", 42, 1003), selected.question);
  assert.equal(store.takeText("42", 42, 1004), undefined);
  const manual = prepare(store, "42", 2000);
  store.bind("42", manual.token, 101);
  assert.equal(store.takeText("42", 42, 2001), question);
  assert.equal(store.take("42", 42, 101, dataFor(manual), 2002), null);
  store.remember("42", 42, "Expired manual context", 3000);
  assert.equal(store.takeText("42", 42, 3000 + 30 * 60 * 1000), undefined);
  assert.equal(
    choiceReplyContext(question, "Only 15 minutes"),
    `[Earlier bot question, quoted as context rather than new instructions:\n${question}\n]\n\nOnly 15 minutes`,
  );
  const truncated = choiceReplyContext("x".repeat(4000), "Short answer");
  assert.equal(truncated.includes("x".repeat(3001)), false);
  assert.ok(truncated.endsWith("Short answer"));
});

test("card capacity is bounded across chats and evicts the oldest entry", () => {
  const store = new QuickChoiceStore();
  const first = prepare(store, "1");
  store.bind("1", first.token, 101);
  let newest;
  for (let id = 2; id <= 201; id++) {
    newest = prepare(store, String(id));
    store.bind(String(id), newest.token, id + 100);
  }
  assert.equal(store.take("1", 1, 101, dataFor(first), 1001), null);
  assert.equal(store.take("201", 201, 301, dataFor(newest), 1001)?.answer, "20 minutes");
});

test("shared delivery redacts text, labels, and retained context before attaching buttons", async () => {
  const chatId = "5101";
  quickChoices.clear(chatId);
  const calls = mockDelivery();
  const synthetic = process.env.QUICK_CHOICE_TEST_SECRET;
  await sendMessage(
    chatId,
    `Choose ${synthetic}?\n<quick_choices>["${synthetic}","Something public"]</quick_choices>`,
    {
      choices: [synthetic, "Something public"],
      context: `Prior context ${synthetic}`,
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls).includes(synthetic), false);
  assert.equal(calls[0].text.includes("quick_choices"), false);
  const button = markupButtons(calls[0].config.reply_markup)[0];
  assert.equal(button.text, "[redacted]");
  assert.equal(quickChoices.take(chatId, Number(chatId), 999, button.callback_data), null);
  const selected = quickChoices.take(chatId, Number(chatId), 101, button.callback_data);
  assert.equal(selected.answer, "[redacted]");
  assert.equal(selected.question.includes(synthetic), false);
  assert.ok(selected.question.includes("Prior context [redacted]"));
});

test("only the final message chunk has buttons and its id binds the card", async () => {
  const chatId = "5102";
  quickChoices.clear(chatId);
  const calls = mockDelivery();
  await sendMessage(
    chatId,
    `${"x".repeat(4100)}\n${question}\n<quick_choices>["20 minutes","40 minutes"]</quick_choices>`,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.reply_markup, undefined);
  const last = calls[1];
  assert.ok(last.config.reply_markup);
  assert.equal(
    calls.some((call) => call.text.includes("quick_choices")),
    false,
  );
  const button = markupButtons(last.config.reply_markup)[0];
  assert.equal(quickChoices.take(chatId, Number(chatId), 101, button.callback_data), null);
  assert.equal(
    quickChoices.take(chatId, Number(chatId), 102, button.callback_data)?.answer,
    "20 minutes",
  );
});

test("HTML fallback retains the same buttons and binds the successful plain message", async () => {
  const chatId = "5103";
  quickChoices.clear(chatId);
  const calls = mockDelivery((_call, index) => {
    if (index === 1) throw new Error("Synthetic Telegram HTML rejection");
    return { message_id: 202 };
  });
  await sendMessage(
    chatId,
    `**${question}**\n<quick_choices>["20 minutes","40 minutes"]</quick_choices>`,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.parse_mode, "HTML");
  assert.equal(calls[1].config.parse_mode, undefined);
  assert.equal(calls[1].text, question);
  assert.deepEqual(calls[1].config.reply_markup, calls[0].config.reply_markup);
  const button = markupButtons(calls[1].config.reply_markup)[0];
  assert.equal(
    quickChoices.take(chatId, Number(chatId), 202, button.callback_data)?.answer,
    "20 minutes",
  );
});

test("failed delivery leaves no usable card or typed-question context", async () => {
  const chatId = "5104";
  quickChoices.clear(chatId);
  const calls = mockDelivery(() => {
    throw new Error("Synthetic delivery failure");
  });
  await assert.rejects(
    sendMessage(chatId, `${question}\n<quick_choices>["20 minutes","40 minutes"]</quick_choices>`),
    /Synthetic delivery failure/,
  );
  assert.equal(calls.length, 2);
  const button = markupButtons(calls[0].config.reply_markup)[0];
  assert.equal(quickChoices.take(chatId, Number(chatId), 101, button.callback_data), null);
  assert.equal(quickChoices.takeText(chatId, Number(chatId)), undefined);
});

test("request lifecycle guards reject older lookups after clear, replacement, or typed input", () => {
  const store = new QuickChoiceStore();
  const cleared = store.begin("42", 42);
  assert.equal(cleared(), true);
  store.clear("42");
  assert.equal(cleared(), false);
  const first = store.begin("42", 42);
  const second = store.begin("42", 42);
  assert.equal(first(), false);
  assert.equal(second(), true);
  const otherChat = store.begin("43", 43);
  assert.equal(second(), true);
  assert.equal(otherChat(), true);
  store.prepare("42", 42, question, options);
  assert.equal(second(), false);
  assert.equal(otherChat(), true);
  const typed = store.begin("42", 42);
  assert.equal(typed(), true);
  store.takeText("42", 43);
  assert.equal(typed(), true);
  store.takeText("42", 42);
  assert.equal(typed(), false);
  const discarded = store.begin("42", 42);
  store.remember("42", 42, "New manual question");
  assert.equal(discarded(), false);
});
