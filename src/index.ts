import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import http from "node:http";
import { Bot } from "grammy";
import { isMealLog } from "./agent/classify.js";
import { QueueFullError, drainChatRuns, enqueueChatRun } from "./agent/coordinator.js";
import { clearGeminiHistory, evictExpiredGemini } from "./agent/gemini.js";
import { clearOpenAIHistory, evictExpiredOpenAI } from "./agent/openai.js";
import {
  clearPersonaOverride,
  listPersonas,
  pickPersonality,
  setPersonaOverride,
} from "./agent/personalities.js";
import { aggregateStats, readRunRecords } from "./agent/runlog.js";
import {
  type RapidLedger,
  applyRapidMessage,
  classifyQuery,
  emptyRapidLedger,
  isCorrectionConfirm,
  isRapidFireLog,
  isSessionFinal,
  renderRapidLedger,
  runAgent,
} from "./agent/runner.js";
import { clearSession, evictExpired } from "./agent/sessions.js";
import { executeCoachTool } from "./agent/tooling.js";
import { googleCalendarConfigured } from "./calendar/status.js";
import { type AlbumItem, mergeAlbum } from "./channel/album.js";
import { releaseChatIntake, withChatIntake } from "./channel/intake.js";
import { registerBot, sendMessage } from "./channel/notify.js";
import { isAllowed } from "./channel/permissions.js";
import { startPolling } from "./channel/polling.js";
import {
  handleQuickChoice,
  isTodayRequest,
  showTodayChoices,
} from "./channel/quick-choice-flow.js";
import { choiceReplyContext, parseQuickChoices, quickChoices } from "./channel/quick-choices.js";
import { telegramApiTransformer } from "./channel/telegram-api.js";
import { registerTelegramWebhook, startWebhookServer } from "./channel/webhook-server.js";
import { checkClaudeAuth, config } from "./config.js";
import { type Attachment, isSupportedAttachment } from "./media/attachments.js";
import { transcribeAudio, transcriptionAvailable, warmupTranscriber } from "./media/transcribe.js";
import { readFoodLibrary } from "./notion/food-library.js";
import {
  flushVisualRefreshes,
  isVisualRefreshPaused,
  withVisualRefreshPaused,
} from "./notion/refresh.js";
import { type ResetSnapshot, archiveResetData, prepareReset } from "./notion/reset.js";
import { notionConfigured } from "./notion/status.js";
import { initScheduler } from "./scheduler/scheduler.js";
import { startSchedulerServer } from "./scheduler/server.js";
import { writeJsonAtomic } from "./util/atomicfile.js";
import {
  flushTimings,
  measureTiming,
  retainTimingUntil,
  startTiming,
  withResponseTiming,
  withoutTiming,
} from "./util/timing.js";

const bot = new Bot(config.telegramBotToken);

bot.api.config.use(telegramApiTransformer);

registerBot(bot);

// Serialize preparation only; release after reserving ordered agent work.
bot.use(async (ctx, next) => {
  const chatId = ctx.chat ? String(ctx.chat.id) : "";
  const userId = ctx.from?.id;
  if (ctx.chat?.type !== "private" || !userId || chatId !== String(userId) || !isAllowed(userId))
    return;
  await withResponseTiming(
    ctx.callbackQuery ? "callback" : "message",
    async () => {
      const finishIntakeWait = startTiming("intake_wait");
      await withChatIntake(chatId, async () => {
        finishIntakeWait();
        await next();
      });
    },
    ctx.message?.date,
  );
});

function admitChatRun<T>(chatId: string, task: () => Promise<T>, releaseIntake = true): Promise<T> {
  const run = enqueueChatRun(chatId, task);
  if (releaseIntake) releaseChatIntake();
  return run;
}

// ─── Command shortcuts ───────────────────────────────────────────────
//
// Coaching commands map to prompts; saved-data commands use direct reads.

const COMMAND_PROMPTS: Record<string, string> = {
  start:
    "Introduce yourself briefly as my fitness coach and tell me how to use you: I can log workouts in plain language, ask what to train, ask for a weekly plan, ask for nutrition advice, or use /report for a weekly card and /report monthly for a monthly review. Keep it short and welcoming.",
  help: "List what you can help me with: logging workouts (including photos of meals, food labels, or progress pictures), recommending today's session, planning my week, nutrition advice, weekly report cards (/report), monthly reviews (/report monthly), written progress reports (/progress), browsing my food library (/foodlib), switching voices (/persona) and making custom ones (/create), and reminders. Mention that /new starts a fresh conversation. Keep it concise.",
  setup:
    "Set up or repair my Notion training workspace, including its databases, Knowledge Base, canonical Exercise Library note, Training Calendar, and Dashboard. Run the idempotent workspace setup, then confirm what exists and how the exercise catalog is populated from my logged history.",
  log: "I want to log a workout. Ask me what I did if I have not already told you.",
  plan: "Build my training plan for the coming week and save it to Notion.",
  today: "What should I train today? Base it on my goals, my plan, and recent logs.",
  progress: "Give me a progress report from my logged workouts.",
  foodlib:
    'Show me a table of everything in my Food Library: run `node scripts/notion.mjs lookup --db "Food Library" --limit 50` with no --contains so it lists all rows, then render one row per food as: Name | Category | Protein | Calories. If the library is empty, say so in one line and offer to file the first label.',
  create:
    "Help me create a custom coach voice. First ask what it should sound like if I have not said yet (one round of questions at most: the vibe, an example line, a name for it). Then write it to PERSONAS.md in the repo root, creating the file if needed, using exactly this shape per voice: a `## <id>` heading where id is lowercase letters, numbers and dashes only, then a `Name:` line, then a `Voice:` line with 2-4 sentences of voice instruction, preserving every other section byte-for-byte. Rules: voice changes tone and delivery only, coaching judgement, knowledge, tools, and safety rules never change, and built-in ids (arnold, yoda, sherlock, stark, gandalf, dwight, sparrow, batman, normal) cannot be reused. Confirm in one line and tell me to try it with `/persona <id>`.",
};

// ─── /commands ───────────────────────────────────────────────────────
//
// Lists every slash command with a one-line description. Hardcoded like
// /stats: static, instant, no agent call, never paraphrased. Keep in sync
// with the Quick Commands tile in setup-workspace.mjs.

const BOT_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/log", desc: "log a workout (asks what you did)" },
  { cmd: "/today", desc: "see today's saved session or choose a workout" },
  { cmd: "/plan", desc: "build next week's plan to Notion" },
  { cmd: "/progress", desc: "progress report from your logs" },
  { cmd: "/report", desc: "weekly report card (/report monthly for monthly)" },
  { cmd: "/foodlib", desc: "browse saved foods and servings (no AI call)" },
  { cmd: "/stats", desc: "bot usage, last 7 days (no AI call)" },
  { cmd: "/new", desc: "clear chat, start fresh (/reset works too)" },
  { cmd: "/resetdata", desc: "preview and clear workout data and weekly plans (keeps libraries)" },
  { cmd: "/setup", desc: "(re)create the Notion workspace" },
  { cmd: "/start, /help", desc: "intro and what I can do" },
  { cmd: "/commands", desc: "this list" },
  { cmd: "/persona", desc: "list voices or switch yours" },
  { cmd: "/create", desc: "make a custom voice with me" },
];

function buildCommandsReply(): string {
  const lines = ["**Bot Commands**", ...BOT_COMMANDS.map((c) => `- ${c.cmd} — ${c.desc}`)];
  lines.push("Or just write naturally: log sets and meals, send meal photos, ask anything.");
  return lines.join("\n");
}

// ─── /persona ──────────────────────────────────────────────────────────
//
// List voices or switch yours. Instant and deterministic, no agent call:
// bare /persona shows every voice with the current one marked,
// "/persona <id>" switches (ids below, or "random"), "/persona clear"
// drops back to the configured default. The choice persists in
// data/personas.json across restarts and /new clears.

function personaListLines(currentId: string | null): string[] {
  return listPersonas().map(
    (p) =>
      `- ${p.id} — ${p.name}${p.custom ? " (custom)" : ""}${p.id === currentId ? " (current)" : ""}`,
  );
}

function validPersonaIds(): string {
  return [...listPersonas().map((p) => p.id), "random"].join(", ");
}

/** Fresh chat, same as /new: a voice switch must not inherit old voice turns. */
function freshChat(chatId: string): void {
  quickChoices.clear(chatId);
  clearSession(chatId);
  clearGeminiHistory(chatId);
  clearOpenAIHistory(chatId);
  sessionStarts.delete(chatId);
  clearRapidLedger(chatId);
}

function handlePersonaCommand(chatId: string, rest: string): string {
  const current = pickPersonality(chatId);
  const arg = rest.trim().toLowerCase();
  if (!arg) {
    return [
      `Current voice: **${current.name}**.`,
      ...personaListLines(current.id),
      "Switch with `/persona <id>`, roll the dice with `/persona random`, reset with `/persona clear`, or make your own with `/create`.",
    ].join("\n");
  }
  if (arg === "clear" || arg === "default" || arg === "reset") {
    const had = clearPersonaOverride(chatId);
    const now = pickPersonality(chatId);
    freshChat(chatId);
    return had
      ? `Back to your default voice: **${now.name}**. Started a fresh chat so it comes through clean.`
      : `No override was set; you're already on **${now.name}**.`;
  }
  const p = setPersonaOverride(chatId, arg);
  if (!p) {
    return `Don't know the voice "${rest.trim()}". Pick one of: ${validPersonaIds()}.`;
  }
  freshChat(chatId);
  return `Voice set: **${p.name}**. Started a fresh chat so the new voice comes through clean. It sticks across restarts until you change it.`;
}

// ─── /stats ──────────────────────────────────────────────────────────
//
// Deterministic, no LLM call: read the run log and summarise the last 7 days.
// The point is that the numbers come from recorded runs, not from the model's
// recollection, so they cannot be wrong in an interesting way.

const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildStatsReply(): string {
  const stats = aggregateStats(readRunRecords(Date.now() - STATS_WINDOW_MS));
  if (stats.runs === 0) {
    return "No agent runs recorded in the last 7 days yet. Send me something and this fills up.";
  }

  const lines = [
    "**Last 7 days**",
    `Runs: ${stats.runs} (${stats.errors} errored), ${stats.totalTurns} turns`,
    `Latency: p50 ${formatSeconds(stats.p50DurationMs)}, p95 ${formatSeconds(stats.p95DurationMs)}`,
  ];

  const sources = Object.entries(stats.bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  if (sources) lines.push(`Source: ${sources}`);

  const top = stats.topTools.slice(0, 3);
  if (top.length > 0) {
    const tools = top.map((t) => `${t.name} ${Math.round(t.share * 100)}%`).join(", ");
    lines.push(`Top tools: ${tools}`);
  }

  // Subscription auth does not price a run, so a zero total is expected there
  // and saying "$0.00" would read as a measurement rather than an absence.
  if (stats.totalCostUsd > 0) {
    const absent =
      stats.runsWithoutCost > 0
        ? ` (no cost reported on ${stats.runsWithoutCost} runs, subscription)`
        : "";
    lines.push(`Cost: $${stats.totalCostUsd.toFixed(2)}${absent}`);
  } else {
    lines.push("Cost: subscription (no per-run cost reported)");
  }

  return lines.join("\n");
}

// ─── Per-chat run chain ──────────────────────────────────────────────
//
// Rapid-fire sets are acked instantly ("Noted.") while the real agent run
// happens in the background. Without serialisation, a background run and the
// next message's run would read/append the same history file concurrently and
// one of them would silently lose messages. So EVERY agent run for a chat
// joins a per-chat promise chain: each run starts only after the previous one
// for that chat settled. A full queue rejects new work; each caller handles it.

// Wall-clock start of the current logging session per chat. Starts on any
// fast-tier message (sets, session starts like "hill run ... start", even a
// meal), because the next "done" may close a session. The duration suffix only
// attaches when a real set was logged (hasSets) or the clock is fresh (<90
// min), so a stray meal hours earlier can never inflate it; anything older
// than 6 h is discarded. In-memory on purpose: a restart simply re-times.
const sessionStarts = new Map<string, { start: number; hasSets: boolean }>();
const SESSION_CLOCK_MAX_MS = 6 * 3600 * 1000;
const SESSION_FRESH_MS = 90 * 60 * 1000;

// Deterministic rapid-set ledger per chat (see classify.ts for the amend
// semantics). Unlike the session clock it MUST survive restarts: the owner
// deliberately tests kill-and-resume mid-session. Same 6h staleness window.
const rapidLedgers = new Map<string, { ledger: RapidLedger; updatedAt: number }>();
const pendingDataResets = new Map<string, { createdAt: number; snapshot: ResetSnapshot }>();
const activeDataResets = new Set<string>();

function loadRapidLedgers(): void {
  try {
    if (!fs.existsSync(config.rapidLedgerFile)) return;
    const data = JSON.parse(fs.readFileSync(config.rapidLedgerFile, "utf-8"));
    for (const [chatId, entry] of Object.entries(data)) {
      const e = entry as { ledger?: RapidLedger; updatedAt?: number };
      if (Array.isArray(e?.ledger?.entries) && typeof e.updatedAt === "number") {
        rapidLedgers.set(chatId, {
          ledger: { entries: e.ledger.entries, currentExercise: e.ledger.currentExercise ?? "" },
          updatedAt: e.updatedAt,
        });
      }
    }
  } catch (err) {
    console.warn("[ledger] Failed to load rapid ledgers:", (err as Error).message);
  }
}

function saveRapidLedgers(): void {
  try {
    writeJsonAtomic(config.rapidLedgerFile, Object.fromEntries(rapidLedgers));
  } catch (err) {
    console.warn("[ledger] Failed to persist rapid ledgers:", (err as Error).message);
  }
}

function clearRapidLedger(chatId: string): void {
  if (rapidLedgers.delete(chatId)) saveRapidLedgers();
}

loadRapidLedgers();

// Session timing and rapid/background helpers (isSessionFinal,
// isRapidFireLog) live in agent/classify.ts so they are unit-testable; the
// per-chat chain below is the runtime half.

// ─── Message handling ────────────────────────────────────────────────

async function handle(opts: {
  chatId: string;
  userId: number;
  userLabel: string;
  text: string;
  attachments: Attachment[];
  replyTo: (text: string) => Promise<void>;
  typing: () => Promise<void>;
}) {
  const { chatId, userLabel, text, attachments, replyTo, typing } = opts;
  const isCurrentQuestion = quickChoices.begin(chatId, opts.userId);

  // Classify every message; each engine applies its own policy. Claude keeps the
  // fast tier opt-in via FAST_TIER_ENABLED. Gemini uses it for context-based
  // quota routing (heavy chain for coaching/planning, light chain for quick
  // logs) unless GEMINI_SMART_ROUTING=false. Attachments always go heavy:
  // vision needs the stronger models. Session-end writes go fast on purpose:
  // they are mechanical (gather context, one log --body, sum-day, sync), the
  // slim prompt keeps every instruction they need, and lite models are cheaper
  // and less demand-pressured than the flagships.
  const mealLog = isMealLog(text);
  const final = attachments.length === 0 && !mealLog && isSessionFinal(text);
  const modelTier = attachments.length === 0 ? (final ? "fast" : classifyQuery(text)) : "standard";

  // Rapid-fire path: ack in one Telegram send (hundreds of ms), accumulate in
  // the background on the per-chat chain. The background reply is delivered
  // only when it asks something (a parse question contains "?"); coaching
  // one-liners are suppressed so sets never double-ack.
  const rapid =
    attachments.length === 0 && modelTier === "fast" && !final && !mealLog && isRapidFireLog(text);

  // Session clock: any fast-tier message may open a session ("hill run ...
  // start" takes the normal path but still begins the workout). Refresh the
  // flag when sets stream in; expiry is enforced when "done" arrives.
  if (!final && modelTier === "fast" && !mealLog) {
    const cur = sessionStarts.get(chatId);
    if (cur && Date.now() - cur.start > SESSION_CLOCK_MAX_MS) {
      sessionStarts.delete(chatId);
    }
    const clock = sessionStarts.get(chatId);
    if (!clock) {
      sessionStarts.set(chatId, { start: Date.now(), hasSets: rapid });
    } else if (rapid) {
      clock.hasSets = true;
    }
  }

  if (rapid) {
    // Deterministic ledger first: amendments replace structurally, so even if
    // the model misreads history the set list stays exact. Persisted for
    // restart survival; applied before the ack so nothing is lost on failure.
    const stored = rapidLedgers.get(chatId);
    const base =
      stored && Date.now() - stored.updatedAt <= SESSION_CLOCK_MAX_MS
        ? stored.ledger
        : emptyRapidLedger();
    const applied = applyRapidMessage(base, text);
    rapidLedgers.set(chatId, { ledger: applied.ledger, updatedAt: Date.now() });
    saveRapidLedgers();
    const acknowledgement = replyTo("Noted.").catch(() => {});
    const reportFailure = async (err: any) => {
      console.error("[index] Background rapid-fire run failed:", err?.message);
      await replyTo(
        err instanceof QueueFullError
          ? "Your sets are kept in this workout's ledger. Coaching is busy; send done once it clears to save the session."
          : "Hmm, that last one may not have saved. Send it again and I will make sure it sticks.",
      ).catch(() => {});
    };
    const background = admitChatRun(chatId, async () => {
      await acknowledgement;
      try {
        if (isVisualRefreshPaused()) throw new Error("Workspace reset is in progress.");
        const response = await measureTiming("agent", () =>
          runAgent({
            userMessage: text,
            chatId,
            userLabel,
            modelTier,
            attachments,
            onProgress: undefined,
          }),
        );
        const responseText = isCurrentQuestion()
          ? response.text
          : parseQuickChoices(response.text).text;
        if (
          response.incomplete ||
          responseText?.includes("?") ||
          parseQuickChoices(responseText ?? "").choices ||
          isCorrectionConfirm(responseText ?? "")
        ) {
          await replyTo(responseText).catch(() => {});
        }
      } catch (error) {
        await reportFailure(error);
      } finally {
        void withoutTiming(() => flushVisualRefreshes(chatId));
      }
    }).catch(reportFailure);
    retainTimingUntil(background);
    await acknowledgement;
    return;
  }

  void typing().catch(() => {});

  // Keep a typing indicator alive while the agent works (it lasts ~5s per call).
  const typingTimer = setInterval(() => typing().catch(() => {}), 4500);

  // A session-end carries the measured wall-clock duration (first fast-tier
  // message to now) as context so Duration (min) is data, not a guess. It
  // attaches only when sets were logged or the clock is fresh: a lone meal
  // hours earlier must not inflate a workout. Kept on failure so a retry
  // measures the same session.
  let outbound = text;
  if (final) {
    const stored = rapidLedgers.get(chatId);
    if (
      stored &&
      stored.ledger.entries.length > 0 &&
      Date.now() - stored.updatedAt <= SESSION_CLOCK_MAX_MS
    ) {
      outbound += `\n\n${renderRapidLedger(stored.ledger)}`;
    }
    const sess = sessionStarts.get(chatId);
    if (sess) {
      const ageMs = Date.now() - sess.start;
      if (ageMs <= SESSION_CLOCK_MAX_MS && (sess.hasSets || ageMs <= SESSION_FRESH_MS)) {
        const mins = Math.max(1, Math.round(ageMs / 60000));
        const fmt = new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: config.timezone,
        });
        const at = (ts: number) => fmt.format(new Date(ts));
        outbound =
          `${outbound}\n\n[Session context: first log at ${at(sess.start)}, ` +
          `this message at ${at(Date.now())} (${config.timezone}). ` +
          `Set Duration (min) to ${mins}.]`;
      } else {
        sessionStarts.delete(chatId);
      }
    }
  }

  // Join the shared queue so messages and scheduled work cannot overlap a chat
  // session, and provider concurrency remains bounded.
  const reportFailure = async (err: any) => {
    clearInterval(typingTimer);
    console.error("[index] Agent error:", err?.message, err?.stack);
    await replyTo(
      err instanceof QueueFullError
        ? "I have too many requests queued. Please try again shortly."
        : classifyError(err?.message ?? "unknown error"),
    );
  };
  try {
    await admitChatRun(
      chatId,
      async () => {
        try {
          if (isVisualRefreshPaused()) throw new Error("Workspace reset is in progress.");
          const response = await measureTiming("agent", () =>
            runAgent({
              userMessage: outbound,
              chatId,
              userLabel,
              modelTier,
              attachments,
              onProgress: undefined,
            }),
          );
          const responseText = isCurrentQuestion()
            ? response.text
            : parseQuickChoices(response.text).text;
          await replyTo(responseText || "(no response)");
          if (final && !response.incomplete) sessionStarts.delete(chatId);
          if (final && !response.incomplete) clearRapidLedger(chatId);
        } catch (error) {
          await reportFailure(error);
        } finally {
          void withoutTiming(() => flushVisualRefreshes(chatId));
        }
      },
      !final,
    );
  } catch (err: any) {
    await reportFailure(err);
  } finally {
    clearInterval(typingTimer);
  }
}

function classifyError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("workspace reset"))
    return "Workspace reset is in progress. Send your message again when it finishes.";
  if (lower.includes("usage limit") || lower.includes("credit balance is too low"))
    return "I have hit the Claude subscription usage limit. It resets on a rolling window, so try again shortly.";
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "That took too long and timed out. Worth trying again.";
  if (lower.includes("max_turns") || lower.includes("max turns"))
    return "That request got too involved for one go. Try breaking it into smaller asks.";
  if (lower.includes("notion"))
    return "I am having trouble reaching Notion right now. Check the integration token and that the page is shared with it, then try again.";
  return "Something went wrong handling that. I have logged the details. Try again in a moment.";
}

// ─── Album buffer ──────────────────────────────────────────────────────

const ALBUM_WINDOW_MS = 2500;

interface BufferedMessage extends AlbumItem {
  chatId: string;
  userId: number;
  userLabel: string;
  typing: () => Promise<void>;
  replyTo: (text: string) => Promise<void>;
}

type BufferedAlbum = {
  items: BufferedMessage[];
  timer: NodeJS.Timeout;
  done: Promise<void>;
  resolve: () => void;
  finishWaits: Array<() => void>;
  run: ReturnType<typeof AsyncLocalStorage.snapshot>;
};
const albumBuffers = new Map<string, BufferedAlbum>();

function scheduleAlbum(key: string): NodeJS.Timeout {
  return setTimeout(() => {
    const work = flushAlbum(key);
    retainTimingUntil(work);
    void work.catch(() => console.warn("[album] Buffered message processing failed."));
  }, ALBUM_WINDOW_MS);
}

function bufferAlbum(key: string, item: BufferedMessage): void {
  let buf = albumBuffers.get(key);
  if (!buf) {
    let resolve!: () => void;
    const done = new Promise<void>((finish) => {
      resolve = finish;
    });
    buf = {
      items: [],
      timer: scheduleAlbum(key),
      done,
      resolve,
      finishWaits: [],
      run: AsyncLocalStorage.snapshot(),
    };
    albumBuffers.set(key, buf);
  } else {
    clearTimeout(buf.timer);
    buf.timer = scheduleAlbum(key);
  }
  buf.items.push(item);
  buf.finishWaits.push(startTiming("album_wait"));
  retainTimingUntil(buf.done);
}

function cancelBufferedAlbums(chatId: string): void {
  for (const [key, buf] of albumBuffers) {
    if (buf.items[0]?.chatId !== chatId) continue;
    clearTimeout(buf.timer);
    albumBuffers.delete(key);
    for (const finish of buf.finishWaits) finish();
    buf.resolve();
  }
}

function flushBufferedAlbums(chatId: string): void {
  for (const [key, buf] of albumBuffers) {
    if (buf.items[0]?.chatId !== chatId) continue;
    const work = flushAlbum(key);
    retainTimingUntil(work);
    void work.catch(() => console.warn("[album] Buffered message processing failed."));
  }
}

async function flushAlbum(key: string): Promise<void> {
  const buf = albumBuffers.get(key);
  if (!buf) return;
  clearTimeout(buf.timer);
  albumBuffers.delete(key);
  for (const finish of buf.finishWaits) finish();
  await buf.run(async () => {
    try {
      const first = buf.items[0];
      if (activeDataResets.has(first.chatId) || isVisualRefreshPaused()) return;
      const last = buf.items[buf.items.length - 1];
      const merged = mergeAlbum(buf.items);
      if (!merged.text.trim() && merged.attachments.length === 0) return;
      await handle({
        chatId: first.chatId,
        userId: first.userId,
        userLabel: first.userLabel,
        text: merged.text,
        attachments: merged.attachments,
        typing: last.typing,
        replyTo: last.replyTo,
      });
    } finally {
      buf.resolve();
    }
  });
}

// ─── Grammy wiring ───────────────────────────────────────────────────

// Claude caps a single image at ~5MB and PDFs share the request budget, so skip
// anything larger rather than failing the whole run on an oversized upload.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Download one Telegram file as a base64 attachment, or null on any failure. */
async function downloadAttachment(
  fileId: string,
  mediaType: string,
  declaredSize: number | undefined,
): Promise<Attachment | null> {
  try {
    if (declaredSize && declaredSize > MAX_ATTACHMENT_BYTES) return null;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) return null;
    return { mediaType, data: buf.toString("base64") };
  } catch (err) {
    console.warn("[index] Attachment download failed:", (err as Error).message);
    return null;
  }
}

/** Pull any usable image or PDF off an inbound message so the coach can see it. */
async function collectAttachments(msg: any): Promise<Attachment[]> {
  const out: Attachment[] = [];
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const att = await downloadAttachment(largest.file_id, "image/jpeg", largest.file_size);
    if (att) out.push(att);
  }
  if (msg.document) {
    const mime = msg.document.mime_type ?? "";
    if (isSupportedAttachment(mime)) {
      const att = await downloadAttachment(msg.document.file_id, mime, msg.document.file_size);
      if (att) out.push(att);
    }
  }
  return out;
}

/**
 * If the message is a voice note / audio, download and transcribe it locally.
 * Returns the transcript, "" if nothing intelligible, or null if not audio.
 */
async function transcribeVoiceNote(msg: any): Promise<string | null> {
  const media = msg.voice ?? msg.audio ?? msg.video_note;
  if (!media) return null;
  const att = await downloadAttachment(media.file_id, "audio/ogg", media.file_size);
  if (!att) return "";
  const bytes = Buffer.from(att.data, "base64");
  return await transcribeAudio(bytes);
}

bot.callbackQuery(/^qc:/, async (ctx) => {
  await handleQuickChoice(
    ctx,
    async (text) => {
      const userId = ctx.from!.id;
      await handle({
        chatId: String(ctx.chat!.id),
        userId,
        userLabel: ctx.from!.username ? `@${ctx.from!.username}` : `user ${userId}`,
        text,
        attachments: [],
        typing: () => ctx.replyWithChatAction("typing").then(() => undefined),
        replyTo: (out) => sendMessage(String(ctx.chat!.id), out),
      });
    },
    (chatId) => activeDataResets.has(chatId) || isVisualRefreshPaused(),
  );
});

bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const userId = ctx.from?.id;
  if (!userId || !isAllowed(userId)) {
    // Silently ignore strangers so a public bot is not chatty to everyone.
    return;
  }

  const chatId = String(ctx.chat.id);
  const userLabel = ctx.from?.username ? `@${ctx.from.username}` : `user ${userId}`;
  let text = ctx.message.text ?? ctx.message.caption ?? "";

  if (activeDataResets.has(chatId) || isVisualRefreshPaused()) {
    await ctx.reply("Workspace reset is in progress. Send your next message when it finishes.");
    return;
  }

  // Send a reply as Telegram HTML, falling back to plain text if Telegram rejects
  // the entities. All outbound text is scrubbed for secrets first. Defined before
  // command handling so the built-in commands answer through the same safe path.
  const replyTo = async (out: string) => {
    await sendMessage(chatId, out);
  };

  const pendingQuestion = text.startsWith("/") ? undefined : quickChoices.takeText(chatId, userId);
  if (text.startsWith("/")) quickChoices.clear(chatId);
  if (
    isTodayRequest(text) &&
    !ctx.message.photo &&
    !ctx.message.document &&
    !ctx.message.voice &&
    !ctx.message.audio
  ) {
    const today = showTodayChoices(
      chatId,
      userId,
      (id) => activeDataResets.has(id) || isVisualRefreshPaused(),
    );
    releaseChatIntake();
    await today;
    return;
  }

  // Map a leading slash command to its prompt or built-in action.
  if (text.startsWith("/")) {
    const commandToken = text.slice(1).split(/\s+/)[0];
    const cmd = commandToken.split("@")[0].toLowerCase();
    const rest = text.slice(commandToken.length + 1).trim();

    // /new clears the conversation so the next message starts fresh.
    if (cmd === "new" || cmd === "reset") {
      cancelBufferedAlbums(chatId);
      await enqueueChatRun(chatId, async () => {
        freshChat(chatId);
        await replyTo("Started a fresh session. Previous context is cleared.");
      });
      return;
    }

    if (cmd === "resetdata") {
      const ownerId =
        config.ownerChatId || (config.allowedUserIds.length === 1 ? config.allowedUserIds[0] : "");
      if (String(userId) !== ownerId || chatId !== String(userId)) {
        await replyTo("Only the bot owner can reset workspace data.");
        return;
      }

      if (rest.toLowerCase() === "cancel") {
        pendingDataResets.delete(chatId);
        await replyTo("Reset cancelled. No workspace data was changed.");
        return;
      }

      if (rest.toLowerCase() === "confirm reset my data") {
        const pending = pendingDataResets.get(chatId);
        if (!pending || Date.now() - pending.createdAt > 5 * 60 * 1000) {
          pendingDataResets.delete(chatId);
          await replyTo(
            "No active reset preview. Send /resetdata first to review what will be archived.",
          );
          return;
        }

        pendingDataResets.delete(chatId);
        cancelBufferedAlbums(chatId);
        activeDataResets.add(chatId);
        try {
          await withVisualRefreshPaused(() =>
            enqueueChatRun(chatId, async () => {
              freshChat(chatId);
              await replyTo(
                "Reset started. I’m archiving the previewed Notion rows, saved weekly plan entries, and older plan pages, then removing the previewed one-off workout events.",
              );
              const result = await archiveResetData(pending.snapshot);
              const total = Object.values(result.databases).reduce((sum, count) => sum + count, 0);
              const summary = Object.entries(result.databases)
                .map(([name, count]) => `${name}: ${count}`)
                .join("\n");
              const refreshed = await executeCoachTool(
                "run_script",
                { script: "notion.mjs", args: ["sync-dashboard"] },
                chatId,
              );
              const refreshWarning =
                refreshed.error || refreshed.exitCode
                  ? "\n\nThe reset completed, but page summaries did not finish refreshing. Displayed charts may still show old values. Ask me to refresh the dashboard when Notion is available."
                  : "";
              await replyTo(
                `Reset complete. Archived ${total} database row(s), ${result.weeklyPlanEntries} saved weekly plan ${result.weeklyPlanEntries === 1 ? "entry" : "entries"}, ${result.weeklyPlanPages} older weekly plan page(s), and deleted ${result.calendarEvents} one-off workout event(s).\n\nRows by database:\n${summary}\n\nMain workspace pages, Food Library, the Exercise Library, imported reference pages, recurring calendar events, bot settings, profile, and reminders were kept. Telegram messages were not changed; clear those in the Telegram app if you want them gone.${result.calendarConfigured ? "" : "\nGoogle Calendar was not configured, so calendar events were not checked or deleted."}${refreshWarning}`,
              );
            }),
          );
        } catch (err) {
          console.error("[resetdata] Notion reset failed:", (err as Error).message);
          await replyTo(
            `Reset stopped: ${(err as Error).message} Some Notion rows, plan entries, or older pages may already be archived, and some calendar events may already have been deleted. Check both services before retrying.`,
          );
        } finally {
          activeDataResets.delete(chatId);
        }
        return;
      }

      try {
        const { preview, snapshot } = await prepareReset();
        pendingDataResets.set(chatId, { createdAt: Date.now(), snapshot });
        const total = Object.values(preview.databases).reduce((sum, count) => sum + count, 0);
        const summary = Object.entries(preview.databases)
          .map(([name, count]) => `${name}: ${count}`)
          .join("\n");
        const planEntries = preview.weeklyPlanEntries.length
          ? preview.weeklyPlanEntries
              .map((entry) => `- ${entry.title} (under ${entry.parent})`)
              .join("\n")
          : "- No saved weekly plan entries found";
        const planPages = preview.weeklyPlanPages.length
          ? preview.weeklyPlanPages
              .map((page) => `- ${page.title} (under ${page.parent})`)
              .join("\n")
          : "- No older dated weekly plan pages found";
        const calendarEvents = preview.calendar.configured
          ? preview.calendar.events.length
            ? preview.calendar.events
                .map(
                  (event) =>
                    `- ${event.startsAt}: ${event.title}${event.tagged ? " (tagged weekly plan)" : " (matched as an older workout plan)"}`,
                )
                .join("\n")
            : "- No one-off workout plan events found; recurring events are kept"
          : "- Not configured; calendar events cannot be checked and will be skipped";
        await replyTo(
          `Reset preview (expires in 5 minutes)\n\nNotion rows to archive:\n${summary}\n\nSaved weekly plan entries to archive:\n${planEntries}\n\nOlder dated weekly plan pages to archive:\n${planPages}\n\nOne-off workout events to delete:\n${calendarEvents}\n\nMain workspace pages, Food Library, Exercise Library, imported reference pages, recurring calendar events, profile, settings, reminders, and Telegram messages are kept. Review the listed entries, pages, and events. To proceed, send exactly:\n/resetdata confirm reset my data\n\nSend /resetdata cancel to cancel.`,
        );
      } catch (err) {
        await replyTo(`Can't prepare reset preview: ${(err as Error).message}`);
      }
      return;
    }

    // /stats answers from the run log alone, with no agent call behind it.
    if (cmd === "stats") {
      await replyTo(buildStatsReply());
      return;
    }

    if (cmd === "foodlib" && !rest && !ctx.message.photo && !ctx.message.document) {
      void ctx.replyWithChatAction("typing").catch(() => {});
      const library = readFoodLibrary();
      releaseChatIntake();
      await replyTo(await library);
      return;
    }

    if (cmd === "report") {
      const period = rest.toLowerCase();
      if (period && period !== "monthly") {
        await replyTo(
          "Use /report for this week's card or /report monthly for the monthly review.",
        );
        return;
      }
      void ctx.replyWithChatAction("upload_photo").catch(() => {});
      try {
        const reportArgs = period === "monthly" ? ["--period", "month"] : ["--period", "week"];
        const generated = await executeCoachTool(
          "run_script",
          { script: "report-card.mjs", args: reportArgs },
          chatId,
        );
        if (generated.exitCode)
          throw new Error(String(generated.output ?? "Report generation failed."));
        const output = String(generated.output ?? "");
        const noReport = /^NO_REPORT (.+)$/m.exec(output)?.[1];
        if (noReport) {
          await replyTo(noReport);
          return;
        }
        const file = /^CARD (.+)$/m.exec(output)?.[1];
        const caption = /^CAPTION (.+)$/m.exec(output)?.[1];
        if (!file || !caption)
          throw new Error("The report was generated without an image or caption.");
        const sent = await executeCoachTool(
          "run_script",
          {
            script: "send-photo.mjs",
            args: ["--chat", chatId, "--file", file, "--caption", caption],
          },
          chatId,
        );
        if (sent.exitCode)
          throw new Error(String(sent.output ?? "Telegram could not send the report."));
      } catch (err) {
        console.error("[report] failed:", (err as Error).message);
        await replyTo(`I couldn't create the report: ${(err as Error).message}`);
      }
      return;
    }

    // /persona lists voices or switches yours: /persona, /persona <id>,
    // /persona clear. Instant and deterministic, no agent call behind it.
    if (cmd === "persona") {
      if (rest.trim()) {
        cancelBufferedAlbums(chatId);
        await enqueueChatRun(chatId, async () => {
          await replyTo(handlePersonaCommand(chatId, rest));
        });
      } else {
        await replyTo(handlePersonaCommand(chatId, rest));
      }
      return;
    }

    // /commands lists every command, with no agent call behind it.
    if (cmd === "commands") {
      await replyTo(buildCommandsReply());
      return;
    }

    const mapped = COMMAND_PROMPTS[cmd];
    if (mapped) text = rest ? `${mapped}\n\n${rest}` : mapped;
  }

  const attachments = await measureTiming("media_download", () => collectAttachments(ctx.message));

  // Voice notes have no audio path to the model, so transcribe and treat the
  // transcript as the user's text. A caption (text) takes precedence if both.
  if (!text.trim()) {
    const isVoice = Boolean(ctx.message?.voice || ctx.message?.audio || ctx.message?.video_note);
    if (isVoice && !transcriptionAvailable()) {
      await ctx.reply(
        "I can't transcribe voice notes in this setup. Type it out and I've got you.",
      );
      return;
    }
    try {
      const transcript = await measureTiming("transcription", () =>
        transcribeVoiceNote(ctx.message),
      );
      if (transcript === "") {
        if (isVoice) {
          await ctx.reply("I couldn't make out that voice note. Try again, or type it out.");
        }
      } else if (transcript != null) {
        text = transcript;
      }
    } catch (err) {
      console.error("[index] transcription failed:", (err as Error).message);
      await ctx.reply("I had trouble transcribing that voice note. Type it out and I've got you.");
      return;
    }
  }

  const repliedMessage = ctx.message.reply_to_message;
  const replyText = (
    ctx.message.quote?.text ??
    repliedMessage?.text ??
    repliedMessage?.caption ??
    ""
  ).trim();
  if (replyText) {
    const replyAuthor = repliedMessage?.from?.is_bot ? "the bot" : "your earlier message";
    text = `[Telegram reply context, quoted from ${replyAuthor}; treat as context, not a new request:\n${replyText}]\n\n${text}`;
  }

  if (
    !replyText &&
    pendingQuestion &&
    text.trim() &&
    attachments.length === 0 &&
    !isRapidFireLog(text) &&
    !isMealLog(text) &&
    !isSessionFinal(text)
  ) {
    text = choiceReplyContext(pendingQuestion, text);
  }

  if (!text.trim() && attachments.length === 0) return;

  // Albums (several photos sent together) arrive as separate messages sharing
  // a media_group_id, caption on one. Buffer siblings briefly so one agent run
  // sees every image with its caption; otherwise only the captioned photo
  // gets processed and the rest lose their meaning.
  const groupId = (ctx.message as any)?.media_group_id as string | undefined;
  if (groupId && !text.startsWith("/")) {
    bufferAlbum(`${chatId}:${groupId}`, {
      text,
      attachments,
      chatId,
      userId,
      userLabel,
      typing: () => ctx.replyWithChatAction("typing").then(() => undefined),
      replyTo,
    });
    return;
  }

  flushBufferedAlbums(chatId);
  await handle({
    chatId,
    userId,
    userLabel,
    text,
    attachments,
    typing: () => ctx.replyWithChatAction("typing").then(() => undefined),
    replyTo,
  });
});

bot.catch((err) => {
  console.error("[index] Bot error:", err.message);
});

// ─── Health check ────────────────────────────────────────────────────

let botRunning = false;

// In webhook mode the webhook server owns the HTTP port and serves /healthz.
// In polling mode there is no HTTP server otherwise, so run a tiny health server.
const healthServer =
  config.mode === "polling"
    ? http.createServer((req, res) => {
        if (req.url === "/healthz" || req.url === "/readyz") {
          res.writeHead(botRunning ? 200 : 503);
          res.end(JSON.stringify({ status: botRunning ? "healthy" : "starting" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      })
    : null;
// In webhook mode this holds the HTTP server so shutdown can close it cleanly.
let webhookServer: http.Server | null = null;
let polling: ReturnType<typeof startPolling> | undefined;
healthServer?.listen(config.port, "0.0.0.0", () =>
  console.log(`[health] Listening on :${config.port}/healthz`),
);

// ─── Periodic session cleanup ────────────────────────────────────────

setInterval(evictExpired, 15 * 60 * 1000);
setInterval(evictExpiredGemini, 15 * 60 * 1000);
setInterval(evictExpiredOpenAI, 15 * 60 * 1000);

// ─── Start ───────────────────────────────────────────────────────────

(async () => {
  checkClaudeAuth();
  startSchedulerServer();
  await initScheduler();
  await bot.init();
  if (notionConfigured()) {
    const refreshChat = config.ownerChatId || "startup";
    await executeCoachTool(
      "run_script",
      { script: "notion.mjs", args: ["sync-dashboard"] },
      refreshChat,
      { deferVisuals: true },
    );
    void flushVisualRefreshes(refreshChat);
  }

  if (config.mode === "webhook") {
    // Scale-to-zero path: Telegram pushes updates to the HTTP server, and an
    // external scheduler fires reminders. No long-polling loop runs.
    webhookServer = startWebhookServer(bot);
    await registerTelegramWebhook(bot);
    botRunning = true;
    console.log(
      `${config.agentName} is running (webhook mode). Notion ${notionConfigured() ? "enabled" : "disabled"}, ` +
        `Google Calendar ${googleCalendarConfigured() ? "enabled" : "disabled"}.`,
    );
    // No online ping here: in scale-to-zero the instance may start cold for any
    // request, so a startup message would fire on every cold start.
    return;
  }

  // Polling path: long-poll Telegram. Best for local and always-on hosts.
  botRunning = true;
  warmupTranscriber();
  console.log(
    `${config.agentName} is running (polling mode). Notion ${notionConfigured() ? "enabled" : "disabled"}, ` +
      `Google Calendar ${googleCalendarConfigured() ? "enabled" : "disabled"}.`,
  );
  if (config.ownerChatId) {
    const ownerPersona = pickPersonality(config.ownerChatId);
    const onlineName = ownerPersona.voice ? ownerPersona.name : config.agentName;
    sendMessage(config.ownerChatId, `${onlineName} is online and ready.`).catch(() => {});
  }
  // Remove any webhook left over from a previous webhook-mode deploy, or Telegram
  // will keep delivering there and getUpdates will conflict.
  await bot.api.deleteWebhook().catch(() => {});
  polling = startPolling(bot);
  await polling.done;
})();

// ─── Graceful shutdown ───────────────────────────────────────────────

async function shutdown() {
  console.log("[shutdown] Shutting down...");
  healthServer?.close();
  webhookServer?.close();
  await polling?.stop().catch(() => {});
  for (const key of [...albumBuffers.keys()]) await flushAlbum(key);
  await drainChatRuns();
  await flushTimings();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
