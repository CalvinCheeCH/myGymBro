import fs from "node:fs";
import { Cron } from "croner";
import { enqueueChatRun } from "../agent/coordinator.js";
import { type ModelTier, runAgent } from "../agent/runner.js";
import { sendMessage } from "../channel/notify.js";
import { isAllowed } from "../channel/permissions.js";
import { config } from "../config.js";
import { flushVisualRefreshes, isVisualRefreshPaused } from "../notion/refresh.js";
import { writeJsonAtomic } from "../util/atomicfile.js";

/**
 * Cron-based scheduler for proactive coaching: morning session nudges, the weekly
 * plan, reminders. Tasks are persisted to a plain local JSON file.
 *
 * When a task fires, it runs the agent with the task's prompt and pushes the result
 * to the task's chat. Because the agent shares the chat's session, the reminder lands
 * in context with the ongoing conversation.
 */

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  chatId: string;
  enabled: boolean;
  modelTier?: ModelTier;
  /**
   * Version of the built-in prompt. When the shipped defaults improve, tasks
   * still carrying an older version get their prompt refreshed on startup
   * (chatId and enabled are always preserved; custom tasks have no version
   * and are never touched).
   */
  promptVersion?: number;
}

/** Bump when a default prompt changes so live installs pick it up on restart. */
export const DEFAULT_PROMPT_VERSION = 5;

const tasks = new Map<string, { task: ScheduledTask; job: Cron }>();
const SCHEDULE_FILE = config.scheduleFile;

/**
 * Default reminders seeded the first time the agent runs with no schedule file.
 * The user can edit, disable, or remove these by asking the agent in chat. Times
 * are interpreted in the configured timezone.
 */
function defaultTasks(): ScheduledTask[] {
  if (!config.ownerChatId) return [];
  const chatId = config.ownerChatId;
  return [
    {
      id: "morning-nudge",
      name: "Morning session nudge",
      cron: "0 11 * * *",
      prompt:
        "Good morning. Do two things, in order, and keep the whole message short and motivating. " +
        "1. Yesterday's coverage: pull yesterday's Workout Log and Meal Log rows (find-row --date with yesterday's YYYY-MM-DD, derived from my local time in your context note). Say plainly whether I trained and whether I logged food, with yesterday's calorie and protein totals against my PERSONAL.md targets. One or two lines, no lecture. " +
        "2. Today's session: tell me what today's training should be from my goals, weekly plan, and recent logs. " +
        "If yesterday is empty on both logs, say so in half a line and move on; the plan for today is the point.",
      chatId,
      enabled: true,
      modelTier: "standard",
      promptVersion: DEFAULT_PROMPT_VERSION,
    },
    {
      id: "weekly-plan",
      name: "Sunday report + plan",
      cron: "0 18 * * 0",
      prompt: `Weekly review day. Review the completed Sunday-to-Saturday reporting week, and use my actual training schedule and rest days from PERSONAL.md. Work through this in order. 1. Render one branded weekly card: \`node scripts/report-card.mjs --style card --period week --week-offset -1\`. Send the generated CARD PNG to chat ${chatId} with \`node scripts/send-photo.mjs --chat ${chatId} --file <CARD path> --caption "<the CAPTION line>"\`. 2. Use the TOP lines and REPORT block as source material for a concise progress review; do not dump the raw workout log into chat. Include training and nutrition adherence against my targets. One down week is noise with a cause, a pattern is programming. 3. Follow the weekly-plan skill to build next week's training plan with per-lift overload targets, save it to Notion (and calendar events if configured), and summarise it briefly. 4. If bodyweight tracking supports my stated goal in PERSONAL.md, ask for this morning's bodyweight in one line without assuming a target or bulking goal: when I reply, log it with \`node scripts/notion.mjs log --db "Body Stats" --set "Check-in=<today's DD/MM/YY>" --set "Date=<today's YYYY-MM-DD>" --set "Bodyweight (kg)=<number>" --set "Conditions=Morning fasted"\`.`,
      chatId,
      enabled: true,
      modelTier: "standard",
      promptVersion: DEFAULT_PROMPT_VERSION,
    },
  ];
}

/**
 * Refresh built-in prompts that predate the shipped version. Only the
 * prompt text (plus name/cron/tier) is replaced; the owner's chatId and
 * enabled flag are always preserved, and non-default tasks are untouched.
 * Exported for unit tests.
 */
export function refreshDefaultPrompts(loaded: ScheduledTask[]): ScheduledTask[] {
  const defaults = new Map(defaultTasks().map((t) => [t.id, t]));
  let changed = false;
  const out = loaded.map((task) => {
    const fresh = defaults.get(task.id);
    if (!fresh || (task.promptVersion ?? 0) >= DEFAULT_PROMPT_VERSION) return task;
    changed = true;
    console.log(
      `[scheduler] Refreshing default prompt: ${task.id} (v${task.promptVersion ?? 0} -> v${DEFAULT_PROMPT_VERSION})`,
    );
    return {
      ...task,
      name: fresh.name,
      cron: fresh.cron,
      prompt: fresh.prompt,
      modelTier: fresh.modelTier,
      promptVersion: DEFAULT_PROMPT_VERSION,
    };
  });
  if (changed) saveToDisk(out);
  return out;
}

// The task definitions, kept in memory whether or not croner is driving them.
// In webhook mode the external scheduler (Cloud Scheduler) fires them via
// /cron/run, so the in-process croner jobs are not started.
let definitions: ScheduledTask[] = [];

export async function initScheduler(): Promise<void> {
  let loaded = loadFromDisk();

  if (loaded.length === 0) {
    loaded = defaultTasks();
    if (loaded.length > 0) {
      saveToDisk(loaded);
      console.log(`[scheduler] Seeded ${loaded.length} default tasks`);
    }
  } else {
    loaded = refreshDefaultPrompts(loaded);
  }
  definitions = loaded;

  // Only run the in-process cron loop when long-polling. In webhook mode the
  // process is asleep most of the time, so an external scheduler drives reminders.
  if (config.mode === "polling") {
    for (const task of loaded) {
      if (task.enabled) startTask(task);
    }
    console.log(`[scheduler] Loaded ${loaded.length} tasks (${tasks.size} active, croner)`);
  } else {
    console.log(`[scheduler] Loaded ${loaded.length} tasks (webhook mode, external trigger)`);
  }
}

/** Look up a task definition by id (used by the /cron/run endpoint). */
export function getTask(id: string): ScheduledTask | undefined {
  return definitions.find((t) => t.id === id);
}

/** Run a task now: invoke the agent with its prompt and push the result. */
export async function executeTask(task: ScheduledTask): Promise<void> {
  // Stored polling tasks must respect recipients revoked since the last run.
  if (!isAllowed(task.chatId) || isVisualRefreshPaused()) return;
  console.log(`[scheduler] Running: ${task.name}`);
  const reportFailure = async (err: any) => {
    console.error(`[scheduler] Task ${task.name} failed:`, err.message);
    await sendMessage(task.chatId, `Scheduled task "${task.name}" failed: ${err.message}`).catch(
      () => {},
    );
  };
  try {
    await enqueueChatRun(task.chatId, async () => {
      try {
        if (!isAllowed(task.chatId) || isVisualRefreshPaused()) return;
        const response = await runAgent({
          userMessage: task.prompt,
          chatId: task.chatId,
          userLabel: "scheduled task",
          modelTier: task.modelTier ?? "standard",
        });
        await sendMessage(task.chatId, response.text || "(no output)");
      } catch (error) {
        await reportFailure(error);
      } finally {
        void flushVisualRefreshes(task.chatId);
      }
    });
  } catch (err: any) {
    await reportFailure(err);
  }
}

export function addTask(task: ScheduledTask): void {
  if (definitions.some((t) => t.id === task.id)) {
    console.warn(`[scheduler] Task id "${task.id}" already exists; replacing it.`);
  }
  const existing = tasks.get(task.id);
  existing?.job.stop();
  tasks.delete(task.id);
  definitions = [...definitions.filter((t) => t.id !== task.id), task];
  // Only start a live croner job in polling mode; webhook mode is fired externally.
  if (config.mode === "polling" && task.enabled) startTask(task);
  persist();
  console.log(`[scheduler] Added task: ${task.name} (${task.cron})`);
}

export function removeTask(taskId: string): boolean {
  const existed = definitions.some((t) => t.id === taskId);
  definitions = definitions.filter((t) => t.id !== taskId);
  const entry = tasks.get(taskId);
  if (entry) {
    entry.job.stop();
    tasks.delete(taskId);
  }
  if (!existed && !entry) return false;
  persist();
  console.log(`[scheduler] Removed task: ${taskId}`);
  return true;
}

export function listTasks(): ScheduledTask[] {
  return definitions;
}

function startTask(task: ScheduledTask): void {
  if (!task.enabled) return;
  const job = new Cron(task.cron, { timezone: config.timezone }, () => executeTask(task));
  tasks.set(task.id, { task, job });
}

function persist(): void {
  // definitions is the authoritative task list in both modes; add/remove keep it
  // in sync with the live croner jobs (polling mode) before this is called.
  saveToDisk(definitions);
}

function loadFromDisk(): ScheduledTask[] {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8")) as ScheduledTask[];
  } catch (err) {
    console.warn("[scheduler] Failed to read schedule file:", (err as Error).message);
    return [];
  }
}

function saveToDisk(all: ScheduledTask[]): void {
  try {
    writeJsonAtomic(SCHEDULE_FILE, all);
  } catch (err) {
    console.warn("[scheduler] Failed to persist schedule file:", (err as Error).message);
  }
}
