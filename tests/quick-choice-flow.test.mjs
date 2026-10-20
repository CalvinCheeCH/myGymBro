import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

const CHAT_ID = "123";
const USER_ID = 123;
let allowed = true;
let plan;
let readCalls;
let readGate;
let sendGate;
let nextMessageId;
const sent = [];
const events = [];

mock.module("../dist/notion/today.js", {
  exports: {
    readTodayPlan: async () => {
      readCalls++;
      if (readGate) await readGate;
      return plan;
    },
  },
});
mock.module("../dist/channel/permissions.js", {
  exports: { isAllowed: () => allowed },
});
mock.module("../dist/channel/notify.js", {
  exports: {
    sendMessage: async (chatId, text, options) => {
      events.push("send");
      if (sendGate) await sendGate;
      const message = { chatId, text, options, messageId: nextMessageId++ };
      if (options) {
        message.card = quickChoices.prepare(chatId, Number(chatId), text, options);
        assert.ok(message.card);
        quickChoices.bind(chatId, message.card.token, message.messageId);
      }
      sent.push(message);
    },
  },
});
const { quickChoices } = await import("../dist/channel/quick-choices.js");
const { handleQuickChoice, isTodayRequest, showTodayChoices } = await import(
  "../dist/channel/quick-choice-flow.js"
);

beforeEach(() => {
  quickChoices.clear(CHAT_ID);
  quickChoices.clear("456");
  quickChoices.clear("42");
  allowed = true;
  plan = { status: "missing", date: "2026-10-19", text: "" };
  readCalls = 0;
  readGate = undefined;
  sendGate = undefined;
  nextMessageId = 1;
  sent.length = 0;
  events.length = 0;
});

function seedCard({ kind = "question", question = "How much time do you have?", now } = {}) {
  const card = quickChoices.prepare(
    CHAT_ID,
    USER_ID,
    question,
    {
      choices: ["20 minutes", "40 minutes"],
      kind,
    },
    now,
  );
  assert.ok(card);
  quickChoices.bind(CHAT_ID, card.token, 77);
  return { card, messageId: 77 };
}

function callback(
  message,
  index = 0,
  {
    userId = USER_ID,
    chatId = CHAT_ID,
    type = "private",
    messageId = message.messageId,
    data,
    editFails = false,
    ackGate,
    editGate,
  } = {},
) {
  const acknowledgements = [];
  return {
    acknowledgements,
    from: { id: userId },
    callbackQuery: {
      data: data ?? message.card.reply_markup.inline_keyboard.flat()[index].callback_data,
      message: { message_id: messageId, chat: { id: Number(chatId), type } },
    },
    answerCallbackQuery: async (value) => {
      events.push("ack");
      acknowledgements.push(value);
      if (ackGate) await ackGate;
    },
    editMessageReplyMarkup: async () => {
      events.push("edit");
      if (editGate) await editGate;
      if (editFails) throw new Error("Message cannot be edited");
    },
  };
}

test("today interception accepts only the command and clear standalone questions", () => {
  for (const value of [
    "/today",
    "/today@myGymBro_bot",
    "what should i work today?",
    "What can I train today?",
    "What's my workout today?",
    "  what is today's workout!  ",
  ]) {
    assert.equal(isTodayRequest(value), true, value);
  }
  for (const value of [
    "/today upper body",
    "what should I train today? My knee hurts",
    "My shoulder hurts, what should I do today?",
    "what should I train today with dumbbells",
    "How should I plan my week?",
    "/today_extra",
  ]) {
    assert.equal(isTodayRequest(value), false, value);
  }
});

test("today shows the saved session or recovery first with relevant buttons", async (t) => {
  for (const [status, firstChoice] of [
    ["planned", "Start this session"],
    ["rest", "Follow recovery day"],
  ]) {
    await t.test(status, async () => {
      sent.length = 0;
      plan = {
        status,
        date: "2026-10-19",
        text:
          status === "rest"
            ? "Monday · Rest day\nEasy walking only."
            : "Monday · Upper body\nBench press: 3 × 8.",
      };
      await showTodayChoices(CHAT_ID, USER_ID);
      assert.match(sent[0].text, /Checking today's saved plan/);
      assert.ok(sent[1].text.includes(plan.text));
      assert.ok(sent[1].text.includes(plan.date));
      assert.deepEqual(sent[1].options.choices, [firstChoice, "Change workout"]);
      assert.equal(sent[1].options.kind, status === "rest" ? "today_rest" : "today_plan");
      assert.equal(readCalls, 1);
    });
  }
});

test("missing and temporarily unavailable plans fall back to focus choices", async () => {
  for (const status of ["missing", "unavailable"]) {
    sent.length = 0;
    plan.status = status;
    await showTodayChoices(CHAT_ID, USER_ID);
    const menu = sent.at(-1);
    assert.equal(menu.options.kind, "today_focus");
    assert.deepEqual(menu.options.choices, ["Upper body", "Lower body", "Strength & conditioning"]);
    assert.match(menu.text, /type your own answer/i);
    assert.match(menu.text, status === "missing" ? /clear saved session/ : /couldn't load/);
  }
});

test("today ignores other owners and disallowed users without reading Notion", async () => {
  await showTodayChoices(CHAT_ID, 456);
  allowed = false;
  await showTodayChoices(CHAT_ID, USER_ID);
  assert.equal(readCalls, 0);
  assert.equal(sent.length, 0);
});

test("callbacks acknowledge before slow answers and cannot replay while work is pending", async () => {
  const message = seedCard();
  const ctx = callback(message);
  const answers = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = handleQuickChoice(ctx, async (text) => {
    events.push("answer");
    answers.push(text);
    await gate;
  });
  await new Promise(setImmediate);
  assert.equal(ctx.acknowledgements.length, 1);
  assert.ok(events.indexOf("ack") < events.indexOf("answer"));
  assert.match(answers[0], /How much time do you have\?/);
  assert.match(answers[0], /20 minutes$/);
  await handleQuickChoice(callback(message), async (text) => answers.push(text));
  assert.equal(answers.length, 1);
  release();
  await pending;
});

test("wrong owner, group, message, token, expired and malformed callbacks never run the model", async () => {
  const invalid = [
    { userId: 456 },
    { userId: 456, chatId: "456" },
    { type: "group" },
    { messageId: 78 },
    { data: "qc:0000000000000000:0" },
    { data: "qc:invalid:0" },
    { data: "qc:0000000000000000:9" },
  ];
  for (const options of invalid) {
    const ctx = callback(seedCard(), 0, options);
    await handleQuickChoice(ctx, async () => assert.fail("Unexpected model call"));
    assert.equal(ctx.acknowledgements.length, 1);
  }
  const ctx = callback(seedCard({ now: Date.now() - 31 * 60 * 1000 }));
  await handleQuickChoice(ctx, async () => assert.fail("Expired choice reached model"));
  assert.match(ctx.acknowledgements[0].text, /expired/);
  allowed = false;
  await handleQuickChoice(callback(seedCard()), async () =>
    assert.fail("Disallowed user reached model"),
  );
  assert.equal(sent.length, 0);
});

test("failure to remove buttons is best-effort and a consumed choice still runs once", async () => {
  const message = seedCard();
  let answers = 0;
  await handleQuickChoice(callback(message, 0, { editFails: true }), async () => {
    answers++;
  });
  await handleQuickChoice(callback(message), async () => {
    answers++;
  });
  assert.equal(answers, 1);
});

test("Something else keeps the original question for the next typed answer", async () => {
  const message = seedCard({ question: "Which equipment is available?" });
  await handleQuickChoice(callback(message, 2), async () =>
    assert.fail("Custom choice reached model"),
  );
  assert.match(sent.at(-1).text, /Type your answer/);
  assert.equal(quickChoices.takeText(CHAT_ID, 456), undefined);
  assert.equal(quickChoices.takeText(CHAT_ID, USER_ID), "Which equipment is available?");
  assert.equal(quickChoices.takeText(CHAT_ID, USER_ID), undefined);
});

test("starting a saved workout or following recovery is immediate without a model call", async () => {
  for (const kind of ["today_plan", "today_rest"]) {
    await handleQuickChoice(callback(seedCard({ kind })), async () =>
      assert.fail("Unexpected model call"),
    );
    assert.match(sent.at(-1).text, kind === "today_rest" ? /recovery plan/ : /send your first set/);
  }
  assert.equal(readCalls, 0);
});

test("changing a saved plan offers focus choices and preserves the original plan context", async () => {
  const original = "Today's saved plan · Monday\nLower body · 3 × 5 squats.";
  await handleQuickChoice(
    callback(seedCard({ kind: "today_plan", question: original }), 1),
    async () => assert.fail("Changing focus should not call the model yet"),
  );
  const menu = sent.at(-1);
  assert.equal(menu.options.kind, "today_focus");
  const answers = [];
  await handleQuickChoice(callback(menu), async (text) => answers.push(text));
  assert.equal(answers.length, 1);
  assert.ok(answers[0].includes(original));
  assert.match(answers[0], /Upper body/);
  assert.match(answers[0], /goals, equipment, limitations and recent training/);
  assert.match(answers[0], /Respect recovery/);
  assert.equal(readCalls, 0);
});

test("reset blocks existing cards and prevents showing a plan after an in-flight lookup", async () => {
  const message = seedCard();
  const ctx = callback(message);
  await handleQuickChoice(
    ctx,
    async () => assert.fail("Reset must block model calls"),
    () => true,
  );
  assert.match(ctx.acknowledgements[0].text, /reset is in progress/);
  assert.equal(
    quickChoices.take(
      CHAT_ID,
      USER_ID,
      message.messageId,
      message.card.reply_markup.inline_keyboard[0][0].callback_data,
    ),
    null,
  );
  let release;
  readGate = new Promise((resolve) => {
    release = resolve;
  });
  let blocked = false;
  const pending = showTodayChoices(CHAT_ID, USER_ID, () => blocked);
  blocked = true;
  release();
  await pending;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options, undefined);
});

test("an answer failure is returned to the caller and never retries a consumed choice", async () => {
  const message = seedCard();
  let attempts = 0;
  await assert.rejects(
    handleQuickChoice(callback(message), async () => {
      attempts++;
      throw new Error("Queue full");
    }),
    /Queue full/,
  );
  await handleQuickChoice(callback(message), async () => {
    attempts++;
  });
  assert.equal(attempts, 1);
});

test("clearing choices during a today lookup prevents an outdated card from returning", async () => {
  let release;
  readGate = new Promise((resolve) => {
    release = resolve;
  });
  plan = { status: "planned", date: "2026-10-19", text: "Upper body · Bench press" };
  const pending = showTodayChoices("42", 42);
  await new Promise(setImmediate);
  assert.equal(readCalls, 1);
  quickChoices.clear("42");
  release();
  await pending;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options, undefined);
  assert.equal(quickChoices.takeText("42", 42), undefined);
});

test("a newer today lookup keeps its menu when an older lookup finishes later", async () => {
  let release;
  readGate = new Promise((resolve) => {
    release = resolve;
  });
  plan = { status: "planned", date: "2026-10-19", text: "Older saved workout" };
  const older = showTodayChoices(CHAT_ID, USER_ID);
  await new Promise(setImmediate);
  assert.equal(readCalls, 1);
  readGate = undefined;
  plan = { status: "planned", date: "2026-10-19", text: "Newer saved workout" };
  await showTodayChoices(CHAT_ID, USER_ID);
  assert.equal(readCalls, 2);
  const latestMenu = sent.at(-1);
  assert.match(latestMenu.text, /Newer saved workout/);
  const count = sent.length;
  release();
  await older;
  assert.equal(sent.length, count);
  await handleQuickChoice(callback(latestMenu), async () =>
    assert.fail("Start should not call the model"),
  );
  assert.match(sent.at(-1).text, /send your first set/);
});

test("a custom answer cannot restore context after its delayed acknowledgement becomes stale", async () => {
  let release;
  const ackGate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = handleQuickChoice(callback(seedCard(), 2, { ackGate }), async () =>
    assert.fail("Custom selection must not call the model"),
  );
  await new Promise(setImmediate);
  quickChoices.clear(CHAT_ID);
  release();
  await pending;
  assert.equal(quickChoices.takeText(CHAT_ID, USER_ID), undefined);
  assert.equal(sent.length, 0);
});

test("a delayed Change callback cannot replace a newer today menu", async () => {
  let release;
  const editGate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = handleQuickChoice(
    callback(seedCard({ kind: "today_plan" }), 1, { editGate }),
    async () => assert.fail("Change must not call the model"),
  );
  await new Promise(setImmediate);
  plan = { status: "planned", date: "2026-10-19", text: "Newer upper-body plan" };
  await showTodayChoices(CHAT_ID, USER_ID);
  const latestMenu = sent.at(-1);
  const count = sent.length;
  release();
  await pending;
  assert.equal(sent.length, count);
  assert.match(latestMenu.text, /Newer upper-body plan/);
  await handleQuickChoice(callback(latestMenu), async () =>
    assert.fail("Start must not call the model"),
  );
  assert.match(sent.at(-1).text, /send your first set/);
});

test("a delayed progress reply cannot enqueue an answer after a new message or reset", async (t) => {
  for (const reason of ["new message", "reset"]) {
    await t.test(reason, async () => {
      let release;
      sendGate = new Promise((resolve) => {
        release = resolve;
      });
      let blocked = false;
      let answers = 0;
      const pending = handleQuickChoice(
        callback(seedCard()),
        async () => {
          answers++;
        },
        () => blocked,
      );
      await new Promise(setImmediate);
      assert.ok(events.includes("send"));
      if (reason === "reset") blocked = true;
      else quickChoices.begin(CHAT_ID, USER_ID);
      release();
      await pending;
      assert.equal(answers, 0);
    });
  }
});
