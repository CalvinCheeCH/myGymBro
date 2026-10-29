import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "gymbro-intake-integration-"));
const oldTimingFile = process.env.RESPONSE_TIMING_FILE;
process.env.RESPONSE_TIMING_FILE = path.join(temporary, "timings.jsonl");
const classify = await import("../dist/agent/classify.js");
const { drainChatRuns } = await import("../dist/agent/coordinator.js");
const { flushTimings } = await import("../dist/util/timing.js");
const settle = () => new Promise(setImmediate);
const noop = () => {};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("Expected integration state was not reached");
}

const models = [];
const replies = [];
const histories = new Map();
const voices = new Map();
const mutations = [];
let modelWork = async () => {};
let sendWork = async () => {};
let typingWork = async () => {};
let libraryWork = async () => "**Food Library**\nSynthetic food";
let libraryReads = 0;
let progressReads = 0;
let progressWork = async () => ({
  text: "Synthetic recorded training",
  prompt: "Precomputed synthetic progress facts.",
});
let downloadWork = async () => new Uint8Array([1, 2, 3]).buffer;
let savedLedgers = {};
let archived = 0;
const middlewares = [];
const handlers = new Map();

const moduleMock = (name, namedExports) =>
  mock.module(new URL(`../dist/${name}.js`, import.meta.url).href, { namedExports });

class FakeBot {
  api = {
    config: { use: noop },
    getFile: async (fileId) => ({ file_path: fileId }),
  };
  use(handler) {
    middlewares.push(handler);
  }
  on(filter, handler) {
    handlers.set(filter, handler);
  }
  callbackQuery() {}
  catch() {}
  init() {
    return new Promise(() => {});
  }
}
mock.module("grammy", { namedExports: { Bot: FakeBot } });
moduleMock("config", {
  checkClaudeAuth: noop,
  config: {
    telegramBotToken: "synthetic-test-token",
    mode: "webhook",
    allowedUserIds: ["42"],
    ownerChatId: "42",
    timezone: "UTC",
    rapidLedgerFile: path.join(temporary, "missing-ledger.json"),
  },
});
moduleMock("agent/gemini", { clearGeminiHistory: noop, evictExpiredGemini: noop });
moduleMock("agent/openai", { clearOpenAIHistory: noop, evictExpiredOpenAI: noop });
moduleMock("agent/personalities", {
  clearPersonaOverride: (chatId) => voices.delete(chatId),
  listPersonas: () => [
    { id: "normal", name: "Normal" },
    { id: "yoda", name: "Yoda" },
  ],
  pickPersonality: (chatId) => ({ id: voices.get(chatId) ?? "normal", name: "Coach" }),
  setPersonaOverride: (chatId, id) => {
    voices.set(chatId, id);
    mutations.push({ kind: "persona", chatId });
    return { id, name: id };
  },
});
moduleMock("agent/runlog", {
  aggregateStats: () => ({ runs: 0 }),
  readRunRecords: () => [],
});
moduleMock("agent/runner", {
  applyRapidMessage: classify.applyRapidMessage,
  classifyQuery: classify.classifyQuery,
  emptyRapidLedger: classify.emptyRapidLedger,
  isCorrectionConfirm: classify.isCorrectionConfirm,
  isRapidFireLog: classify.isRapidFireLog,
  isSessionFinal: classify.isSessionFinal,
  renderRapidLedger: classify.renderRapidLedger,
  runAgent: async (opts) => {
    const call = {
      ...opts,
      priorHistory: [...(histories.get(opts.chatId) ?? [])],
      voice: voices.get(opts.chatId) ?? "normal",
    };
    models.push(call);
    const response = await modelWork(call);
    histories.set(opts.chatId, [...call.priorHistory, opts.userMessage]);
    return response ?? { text: "Saved." };
  },
});
moduleMock("agent/sessions", {
  clearSession: (chatId) => {
    histories.set(chatId, []);
    mutations.push({ kind: "clear", chatId });
  },
  evictExpired: noop,
});
moduleMock("agent/tooling", { executeCoachTool: async () => ({ output: "" }) });
moduleMock("calendar/status", { googleCalendarConfigured: () => false });
moduleMock("channel/notify", {
  registerBot: noop,
  sendMessage: async (chatId, text) => {
    replies.push({ chatId, text });
    await sendWork(chatId, text);
  },
});
moduleMock("channel/polling", { startPolling: noop });
moduleMock("channel/permissions", {
  isAllowed: (userId) => Number.isSafeInteger(Number(userId)) && Number(userId) >= 42,
});
moduleMock("channel/quick-choice-flow", {
  handleQuickChoice: async () => {},
  isTodayRequest: () => false,
  showTodayChoices: async () => {},
});
moduleMock("channel/webhook-server", {
  registerTelegramWebhook: async () => {},
  startWebhookServer: noop,
});
moduleMock("media/transcribe", {
  transcribeAudio: async () => "",
  transcriptionAvailable: () => false,
  warmupTranscriber: noop,
});
moduleMock("notion/reset", {
  prepareReset: async () => ({
    preview: {
      databases: { "Workout Log": 0 },
      weeklyPlanEntries: [],
      weeklyPlanPages: [],
      calendar: { configured: false, events: [] },
    },
    snapshot: {},
  }),
  archiveResetData: async () => {
    archived++;
    return {
      databases: { "Workout Log": 0 },
      weeklyPlanEntries: 0,
      weeklyPlanPages: 0,
      calendarEvents: 0,
      calendarConfigured: false,
    };
  },
});
moduleMock("notion/food-library", {
  readFoodLibrary: async () => {
    libraryReads++;
    return await libraryWork();
  },
});
moduleMock("notion/progress", {
  readProgressReview: async () => {
    progressReads++;
    return await progressWork();
  },
});
moduleMock("notion/status", { notionConfigured: () => false });
moduleMock("scheduler/scheduler", { initScheduler: async () => {} });
moduleMock("scheduler/server", { startSchedulerServer: noop });
moduleMock("util/atomicfile", {
  writeJsonAtomic: (_file, value) => {
    savedLedgers = structuredClone(value);
  },
});

// Keep index startup isolated and make album deadlines controllable without sleeping.
const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const albumTimers = new Set();
globalThis.fetch = async () => ({
  ok: true,
  arrayBuffer: () => downloadWork(),
});
globalThis.setInterval = (...args) => realSetInterval(...args).unref();
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 2500) return realSetTimeout(callback, delay, ...args);
  const timer = {
    callback: AsyncLocalStorage.bind(() => callback(...args)),
    cancelled: false,
  };
  albumTimers.add(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (!albumTimers.has(timer)) return realClearTimeout(timer);
  timer.cancelled = true;
};
await import("../dist/index.js");
globalThis.setInterval = realSetInterval;

function fireAlbumTimers() {
  for (const timer of [...albumTimers]) {
    albumTimers.delete(timer);
    if (!timer.cancelled) timer.callback();
  }
}
function dispatch(chatId, text, extra = {}, typing = () => typingWork()) {
  const message = {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    text,
    chat: { id: Number(chatId), type: "private" },
    from: { id: Number(chatId) },
    ...extra,
  };
  const ctx = {
    message,
    chat: message.chat,
    from: message.from,
    reply: (out) => {
      replies.push({ chatId, text: out });
      return Promise.resolve();
    },
    replyWithChatAction: typing,
  };
  const invoke = (index) =>
    index < middlewares.length
      ? middlewares[index](ctx, () => invoke(index + 1))
      : handlers.get("message")(ctx);
  return invoke(0);
}
const photo = (fileId = "synthetic-photo") => [{ file_id: fileId, file_size: 3 }];
const resetWork = () => {
  models.length = 0;
  replies.length = 0;
  mutations.length = 0;
  modelWork = async () => {};
  sendWork = async () => {};
  typingWork = async () => {};
  libraryReads = 0;
  progressReads = 0;
  progressWork = async () => ({
    text: "Synthetic recorded training",
    prompt: "Precomputed synthetic progress facts.",
  });
  libraryWork = async () => "**Food Library**\nSynthetic food";
  downloadWork = async () => new Uint8Array([1, 2, 3]).buffer;
};

after(async () => {
  await drainChatRuns();
  await settle();
  await flushTimings();
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  if (oldTimingFile === undefined) Reflect.deleteProperty(process.env, "RESPONSE_TIMING_FILE");
  else process.env.RESPONSE_TIMING_FILE = oldTimingFile;
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("gymbro-intake-integration-"));
  await fs.rm(temporary, { recursive: true, force: true });
});

test("real handlers reserve rapid sets before delayed acknowledgement and done ignores slow typing", async () => {
  resetWork();
  const ack = deferred();
  const rapidRun = deferred();
  const typing = deferred();
  sendWork = async (_chatId, text) => {
    if (text === "Noted.") await ack.promise;
  };
  modelWork = async (call) => {
    if (call.userMessage === "bench 60x12") await rapidRun.promise;
  };
  const first = dispatch("42", "bench 60x12");
  await until(() => replies.some((reply) => reply.text === "Noted."));
  const commands = dispatch("42", "/commands");
  await until(() => replies.some((reply) => reply.text.startsWith("**Bot Commands**")));
  assert.equal(models.length, 0);
  const finished = dispatch("42", "done", {}, () => typing.promise);
  ack.resolve();
  await until(() => models.length === 1);
  assert.equal(models[0].userMessage, "bench 60x12");
  rapidRun.resolve();
  await Promise.all([first, finished, commands]);
  assert.equal(models.length, 2);
  assert.match(models[1].userMessage, /^done\n/);
  assert.match(models[1].userMessage, /bench/);
  typing.resolve();
});

test("real handlers finish earlier media preparation before admitting a later text message", async () => {
  resetWork();
  const download = deferred();
  const firstRun = deferred();
  downloadWork = () => download.promise;
  modelWork = async (call) => {
    if (call.attachments.length) await firstRun.promise;
  };
  const first = dispatch("43", "", { caption: "Meal photo", photo: photo() });
  const second = dispatch("43", "plan tomorrow");
  await settle();
  assert.equal(models.length, 0);
  download.resolve(new Uint8Array([1, 2, 3]).buffer);
  await until(() => models.length === 1);
  assert.equal(models[0].attachments.length, 1);
  firstRun.resolve();
  await Promise.all([first, second]);
  assert.equal(models[1].userMessage, "plan tomorrow");
});

for (const [chatId, command, expectedVoice] of [
  ["44", "/new", "normal"],
  ["45", "/persona yoda", "yoda"],
]) {
  test(`real ${command} handler clears state after the active run and before future requests`, async () => {
    resetWork();
    const oldRun = deferred();
    modelWork = async (call) => {
      if (call.userMessage === "plan the week") await oldRun.promise;
    };
    const old = dispatch(chatId, "plan the week");
    await until(() => models.length === 1);
    const barrier = dispatch(chatId, command);
    const future = dispatch(chatId, "new goal strength");
    await settle();
    assert.equal(mutations.length, 0);
    assert.equal(models.length, 1);
    oldRun.resolve();
    await Promise.all([old, barrier, future]);
    assert.equal(models.length, 2);
    assert.deepEqual(models[1].priorHistory, []);
    assert.equal(models[1].voice, expectedVoice);
    assert.ok(mutations.some((mutation) => mutation.kind === "clear"));
  });
}

test("real done handler keeps the next rapid set in its own fresh ledger", async () => {
  resetWork();
  await dispatch("46", "bench 60x12");
  await drainChatRuns();
  const finalRun = deferred();
  modelWork = async (call) => {
    if (call.userMessage.startsWith("done")) await finalRun.promise;
  };
  const done = dispatch("46", "done");
  await until(() => models.length === 2);
  const next = dispatch("46", "row 30x10");
  await settle();
  assert.equal(replies.filter((reply) => reply.text === "Noted.").length, 1);
  finalRun.resolve();
  await Promise.all([done, next]);
  await drainChatRuns();
  const nextLedger = savedLedgers["46"].ledger;
  assert.equal(nextLedger.entries.length, 1);
  assert.match(JSON.stringify(nextLedger), /row/);
  assert.doesNotMatch(JSON.stringify(nextLedger), /bench/);
});

test("real handlers flush a pending album before later agent work and retain its timing context", async () => {
  resetWork();
  await flushTimings();
  const before = (await fs.readFile(process.env.RESPONSE_TIMING_FILE, "utf8"))
    .trim()
    .split("\n").length;
  await dispatch("47", "", {
    text: undefined,
    caption: "Meal portions",
    photo: photo("first-photo"),
    media_group_id: "synthetic-album",
  });
  await dispatch("47", "", {
    text: undefined,
    photo: photo("second-photo"),
    media_group_id: "synthetic-album",
  });
  await dispatch("47", "plan tomorrow");
  await drainChatRuns();
  await settle();
  await flushTimings();
  assert.equal(models.length, 2);
  assert.equal(models[0].attachments.length, 2);
  assert.equal(models[0].userMessage, "Meal portions");
  assert.equal(models[1].userMessage, "plan tomorrow");
  const traces = (await fs.readFile(process.env.RESPONSE_TIMING_FILE, "utf8"))
    .trim()
    .split("\n")
    .slice(before)
    .map((line) => JSON.parse(line));
  assert.ok(
    traces.some(
      (trace) =>
        trace.spans.some((span) => span.stage === "album_wait") &&
        trace.spans.filter((span) => span.stage === "agent").length === 1,
    ),
  );
  assert.ok(
    traces.some(
      (trace) =>
        !trace.spans.some((span) => span.stage === "album_wait") &&
        trace.spans.filter((span) => span.stage === "agent").length === 1,
    ),
  );
  fireAlbumTimers();
  await drainChatRuns();
  assert.equal(models.length, 2);
});

for (const [chatId, command] of [
  ["48", "/new"],
  ["49", "/persona yoda"],
]) {
  test(`real ${command} handler cancels pending album work`, async () => {
    resetWork();
    await dispatch(chatId, "", {
      text: undefined,
      caption: "Old album",
      photo: photo(),
      media_group_id: "cancelled-album",
    });
    await dispatch(chatId, command);
    fireAlbumTimers();
    await settle();
    await drainChatRuns();
    assert.equal(models.length, 0);
    await dispatch(chatId, "plan tomorrow");
    assert.equal(models.length, 1);
    assert.equal(models[0].attachments.length, 0);
  });
}

test("real resetdata confirmation cancels pending album before archiving", async () => {
  resetWork();
  await dispatch("42", "/resetdata");
  await dispatch("42", "", {
    text: undefined,
    caption: "Pre-reset album",
    photo: photo(),
    media_group_id: "reset-album",
  });
  const archivedBefore = archived;
  await dispatch("42", "/resetdata confirm reset my data");
  fireAlbumTimers();
  await settle();
  await drainChatRuns();
  assert.equal(archived, archivedBefore + 1);
  assert.equal(models.length, 0);
});

test("real rapid handler delivers incomplete notices without question punctuation and retains sets", async () => {
  resetWork();
  const notice = "Coaching took too long. Your recorded sets are still kept for this session.";
  modelWork = async () => ({ text: notice, incomplete: true });
  await dispatch("50", "bench 60x12");
  await drainChatRuns();
  assert.ok(replies.some((reply) => reply.chatId === "50" && reply.text === "Noted."));
  assert.ok(replies.some((reply) => reply.chatId === "50" && reply.text === notice));
  assert.equal(savedLedgers["50"].ledger.entries.length, 1);
  assert.match(JSON.stringify(savedLedgers["50"].ledger), /bench/);
});

test("real done handler retains its ledger and session clock on incomplete work then clears both on success", async () => {
  resetWork();
  await dispatch("51", "bench 60x12");
  await drainChatRuns();
  const notice = "I stopped waiting for the model. Your workout is still available to finish.";
  modelWork = async () => ({ text: notice, incomplete: true });
  await dispatch("51", "done");
  const incomplete = models.at(-1).userMessage;
  assert.match(incomplete, /bench/);
  assert.match(incomplete, /Session context: first log at/);
  assert.match(JSON.stringify(savedLedgers["51"].ledger), /bench/);
  assert.ok(replies.some((reply) => reply.chatId === "51" && reply.text === notice));

  modelWork = async () => ({ text: "Workout saved." });
  await dispatch("51", "done");
  const completed = models.at(-1).userMessage;
  assert.match(completed, /bench/);
  assert.match(completed, /Session context: first log at/);
  assert.equal(
    completed.match(/first log at ([^,]+)/)[1],
    incomplete.match(/first log at ([^,]+)/)[1],
  );
  assert.equal(savedLedgers["51"], undefined);

  await dispatch("51", "done");
  assert.equal(models.at(-1).userMessage, "done");
});

test("real incomplete done blocks the next set until reply cleanup settles and preserves both sets", async () => {
  resetWork();
  await dispatch("52", "bench 60x12");
  await drainChatRuns();
  const delivered = deferred();
  const notice = "The model did not finish. Your session remains available.";
  modelWork = async (call) =>
    call.userMessage.startsWith("done") ? { text: notice, incomplete: true } : undefined;
  sendWork = async (chatId, text) => {
    if (chatId === "52" && text === notice) await delivered.promise;
  };
  const finishing = dispatch("52", "done");
  await until(() => replies.some((reply) => reply.chatId === "52" && reply.text === notice));
  const nextSet = dispatch("52", "row 30x10");
  await settle();
  assert.equal(models.length, 2);
  assert.equal(
    replies.filter((reply) => reply.chatId === "52" && reply.text === "Noted.").length,
    1,
  );
  assert.equal(savedLedgers["52"].ledger.entries.length, 1);
  assert.match(JSON.stringify(savedLedgers["52"].ledger), /bench/);

  delivered.resolve();
  await Promise.all([finishing, nextSet]);
  await drainChatRuns();
  const retained = savedLedgers["52"].ledger;
  assert.equal(retained.entries.length, 2);
  assert.match(JSON.stringify(retained), /bench/);
  assert.match(JSON.stringify(retained), /row/);
});

test("real bare foodlib command reads the saved library directly without a model or media work", async () => {
  resetWork();
  typingWork = () => new Promise(() => {});
  downloadWork = () => {
    throw new Error("No media work expected");
  };
  await dispatch("42", "/foodlib@SyntheticBot");
  assert.equal(libraryReads, 1);
  assert.equal(models.length, 0);
  assert.ok(replies.some((reply) => reply.text.includes("Synthetic food")));
});

test("real unknown slash commands reject locally instead of starting an agent run", async () => {
  resetWork();
  typingWork = () => {
    throw new Error("No typing action or model work expected");
  };
  await dispatch("42", "/command");
  assert.equal(models.length, 0);
  assert.ok(
    replies.some(
      (reply) => /I don't know "\/command"/.test(reply.text) && /\/commands/.test(reply.text),
    ),
  );
  // A bot-suffixed variant must reject the same way.
  await dispatch("42", "/cmmands@SyntheticBot");
  assert.equal(models.length, 0);
  assert.ok(replies.some((reply) => /I don't know "\/cmmands"/.test(reply.text)));
});

test("real goals command maps to the profile prompt and appends the user's words", async () => {
  resetWork();
  await dispatch("42", "/goals");
  assert.equal(models.length, 1);
  assert.match(models[0].userMessage, /^Update my profile \(PERSONAL\.md\)/);
  await dispatch("42", "/goals lower back first, bodyweight skills over barbell");
  assert.equal(models.length, 2);
  assert.match(models[1].userMessage, /preserv/i);
  assert.match(models[1].userMessage, /lower back first, bodyweight skills over barbell$/);
});

test("real slow foodlib read releases intake so commands remain responsive", async () => {
  resetWork();
  const lookup = deferred();
  libraryWork = () => lookup.promise;
  const request = dispatch("42", "/foodlib");
  await until(() => libraryReads === 1);
  await dispatch("42", "/commands");
  assert.ok(replies.some((reply) => reply.text.startsWith("**Bot Commands**")));
  assert.equal(models.length, 0);
  lookup.resolve("**Food Library**\nLookup finished.");
  await request;
  assert.ok(replies.some((reply) => reply.text.includes("Lookup finished.")));
});

test("real foodlib questions and attached label photos retain the coaching path", async () => {
  resetWork();
  await dispatch("42", "/foodlib which food has the most protein?");
  assert.equal(libraryReads, 0);
  assert.equal(models.length, 1);
  assert.match(models[0].userMessage, /which food has the most protein/);
  await dispatch("42", "/foodlib", { photo: photo() });
  assert.equal(libraryReads, 0);
  assert.equal(models.length, 2);
  assert.equal(models[1].attachments.length, 1);
});

test("real bare progress command prefetches once and keeps one tool-disabled coaching review", async () => {
  resetWork();
  await dispatch("42", "/progress@SyntheticBot");
  assert.equal(progressReads, 1);
  assert.equal(models.length, 1);
  assert.equal(models[0].toolsEnabled, false);
  assert.equal(models[0].userMessage, "Precomputed synthetic progress facts.");
  assert.equal(models[0].modelTier, "standard");
});

test("real progress waits for an accepted save while commands remain responsive", async () => {
  resetWork();
  const save = deferred();
  modelWork = async (call) => {
    if (call.userMessage === "bench 60x12") await save.promise;
  };
  await dispatch("42", "bench 60x12");
  await until(() => models.length === 1);
  const review = dispatch("42", "/progress");
  await settle();
  assert.equal(progressReads, 0);
  await dispatch("42", "/commands");
  assert.ok(replies.some((reply) => reply.text.startsWith("**Bot Commands**")));
  save.resolve();
  await review;
  await drainChatRuns();
  assert.equal(progressReads, 1);
  assert.equal(models.length, 2);
  assert.equal(models[1].toolsEnabled, false);
});

test("real progress flushes a buffered workout photo before reading progress facts", async () => {
  resetWork();
  await dispatch("42", "", {
    text: undefined,
    caption: "Workout log photo",
    photo: photo(),
    media_group_id: "progress-album",
  });
  const readOrder = [];
  modelWork = async (call) => {
    if (call.attachments?.length) readOrder.push("photo saved");
  };
  progressWork = async () => {
    readOrder.push("facts read");
    return { text: "Recorded facts.", prompt: "Precomputed synthetic progress facts." };
  };
  await dispatch("42", "/progress");
  await drainChatRuns();
  fireAlbumTimers();
  assert.deepEqual(readOrder, ["photo saved", "facts read"]);
  assert.equal(models.length, 2);
  assert.equal(models[1].toolsEnabled, false);
});

test("real progress shows factual results when coaching is incomplete or fails", async () => {
  for (const outcome of ["incomplete", "throws"]) {
    resetWork();
    modelWork = async () => {
      if (outcome === "throws") throw new Error("private-failure-fixture");
      return { text: "Not finished.", incomplete: true };
    };
    await dispatch("42", "/progress");
    assert.equal(models.length, 1);
    assert.ok(replies.some((reply) => reply.text.includes("Synthetic recorded training")));
    assert.ok(replies.some((reply) => reply.text.includes("coaching review couldn't finish")));
    assert.ok(replies.every((reply) => !reply.text.includes("private-failure-fixture")));
  }
});

test("real progress does not ask the model to analyze empty or unavailable records", async () => {
  resetWork();
  progressWork = async () => ({ text: "No recognizable recorded sets in this window." });
  await dispatch("42", "/progress");
  assert.equal(progressReads, 1);
  assert.equal(models.length, 0);
  assert.ok(replies.some((reply) => reply.text.includes("No recognizable recorded sets")));
});

test("real progress questions and attached photos retain normal coaching tools", async () => {
  resetWork();
  await dispatch("42", "/progress why did my bench stall?");
  await dispatch("42", "/progress", { photo: photo() });
  assert.equal(progressReads, 0);
  assert.equal(models.length, 2);
  assert.equal(models[0].toolsEnabled, undefined);
  assert.equal(models[1].toolsEnabled, undefined);
  assert.equal(models[1].attachments.length, 1);
});

test("real progress retains private authorization before reading any records", async () => {
  resetWork();
  await dispatch("41", "/progress");
  await dispatch("42", "/progress", { chat: { id: 42, type: "group" } });
  assert.equal(progressReads, 0);
  assert.equal(models.length, 0);
  assert.equal(replies.length, 0);
});
