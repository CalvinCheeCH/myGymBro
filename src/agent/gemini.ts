/**
 * Gemini engine: an alternative agent backend with the same contract as the
 * Claude runner (runAgent opts in, AgentResponse out). Selected automatically
 * when GEMINI_API_KEY is set without a Claude token, and before OpenAI, so one codebase
 * serves both engines and upstream parity is kept for Claude users.
 *
 * Design notes:
 *  - One tool, `bash`: runs a shell command in the project root. Everything the
 *    Claude engine does with Bash/Read/Write/Glob/Grep goes through this single
 *    tool here (Notion helpers, PERSONAL.md edits, knowledge imports).
 *  - No plugin/skill subsystem exists on this side, so the full coaching brain
 *    (CLAUDE.md persona, every coach-plugin skill including reference files,
 *    PERSONAL.md) is assembled into the system prompt each run. The bundled
 *    Regional food references ship inside the log-meal skill folder and apply
 *    only when the user's food or context matches.
 *  - Conversation state is real message history per chat, persisted with the
 *    same TTL discipline as Claude session ids, trimmed to bound tokens.
 *  - The SDK (@google/genai) is imported lazily so Claude-only deployments never
 *    load it.
 */

import fs from "node:fs";
import path from "node:path";
import { config, pickEngine } from "../config.js";
import type { Attachment } from "../media/attachments.js";
import { personaSystemPrompt, pickPersonality } from "./personalities.js";
import { type RunRecord, appendRunRecord, summariseUsage } from "./runlog.js";
import { PROJECT_ROOT, SCRIPT_NAMES, executeCoachTool } from "./tooling.js";

export interface AgentResponse {
  text: string;
  sessionId?: string;
}

/** True when this process should route runs to the Gemini engine. */
export function useGemini(): boolean {
  return pickEngine() === "gemini";
}

// ─── prompt assembly ─────────────────────────────────────────────────────────

/** Loose Gemini content shapes (the SDK's own types stay inside the lazy import). */
export interface PromptPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
export interface PromptContent {
  role: "user" | "model";
  parts: PromptPart[];
}

/** Every markdown file under a directory, recursive, sorted for determinism. */
function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out.sort();
}

/** Pure assembler: the whole coaching brain as one system instruction string. */
export function assembleSystemPrompt(inputs: {
  claudeMd: string;
  personalMd?: string;
  loggingStyle?: string;
  skills: Array<{ relPath: string; body: string }>;
  personaAppend: string;
  agentName: string;
}): string {
  const sections: string[] = [];
  sections.push(
    [
      "# Engine notes",
      "",
      `You are ${inputs.agentName}, running as the AI engine inside the myGymBro`,
      "Telegram bot. The instructions below were written for a multi-tool coding",
      "assistant, so apply these substitutions:",
      "- You have restricted workspace tools, not a shell. Use `run_script` with one approved helper script and an argument array for Notion, calendar, reports, progression, and exercise lookups.",
      '  For example: script="notion.mjs", args=["query-recent", "--db", "Workout Log"]. For meals, `log-meal` saves the meal and returns authoritative daily totals in one call. Pass complete data in one call. Retry a rejected write only when the helper confirms nothing was written. After an uncertain or partial write, inspect the existing row first; never blindly repeat an additive meal.',
      "  Dashboard, nutrition, and heatmap refreshes are queued for after your reply. A queued display does not confirm that records were saved; confirm logging only from successful data writes and authoritative totals.",
      "  Use `read_file` and `write_file` for approved profile and knowledge files. Use `list_knowledge` and `move_knowledge` when importing knowledge. Do not attempt shell syntax, arbitrary commands, or unsupported file paths.",
      "- There is no web fetch/search tool. Say plainly when something would need",
      "  live web access instead of pretending.",
      '- The "Skills" listed in these instructions are not invocable plugins;',
      "  their full text is included below as playbook sections. Follow the",
      "  relevant playbook when the situation matches.",
      "- All other rules stand unchanged: persona, tone, safety boundaries,",
      "  Telegram markdown formatting, Notion workflows, never fabricating data.",
    ].join("\n"),
  );

  sections.push(`# Coach instructions (CLAUDE.md)\n\n${inputs.claudeMd.trim()}`);
  if (inputs.personalMd?.trim()) {
    sections.push(`# The user's profile (PERSONAL.md)\n\n${inputs.personalMd.trim()}`);
  }
  if (inputs.loggingStyle?.trim()) {
    sections.push(
      `# The user's personal logging shorthand (LOGGING_STYLE.md)\n\nParse every exercise or meal log with this file FIRST; it overrides generic interpretation.\n\n${inputs.loggingStyle.trim()}`,
    );
  }
  for (const skill of inputs.skills) {
    sections.push(`# Skill playbook: ${skill.relPath}\n\n${skill.body.trim()}`);
  }
  if (inputs.personaAppend.trim()) {
    sections.push(`# Voice overlay\n\n${inputs.personaAppend.trim()}`);
  }
  return sections.join("\n\n---\n\n");
}

/** Skills kept in the light-tier prompt: quick logging needs nothing else. */
const LIGHT_TIER_SKILLS = new Set(["log-workout", "log-meal"]);

/** Read everything the system prompt needs from disk. Best-effort on PERSONAL.md. */
export function buildSystemPrompt(chatId: string, tier: "fast" | "standard" = "standard"): string {
  const read = (p: string) => {
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      return "";
    }
  };
  const claudeMd = read(path.join(PROJECT_ROOT, "CLAUDE.md"));
  const personalMd = read(path.join(PROJECT_ROOT, "PERSONAL.md"));
  const loggingStyle = read(path.join(PROJECT_ROOT, "LOGGING_STYLE.md"));

  const skillsDir = path.join(PROJECT_ROOT, "coach-plugin", "skills");
  let skills = markdownFiles(skillsDir).map((full) => ({
    relPath: path.relative(PROJECT_ROOT, full).split(path.sep).join("/"),
    body: read(full),
  }));
  if (tier === "fast") {
    // Light tier handles one quick log; a slim prompt is the single biggest
    // latency and input-token saving available on free-tier quotas.
    skills = skills.filter((s) =>
      [...LIGHT_TIER_SKILLS].some((name) => s.relPath.includes(`/skills/${name}/`)),
    );
  }

  const personaAppend = personaSystemPrompt(pickPersonality(chatId));
  return assembleSystemPrompt({
    claudeMd,
    personalMd,
    loggingStyle,
    skills,
    personaAppend,
    agentName: config.agentName,
  });
}

// ─── attachments + history helpers (pure, unit-tested) ──────────────────────

const SUPPORTED_IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Map inbound attachments to Gemini inlineData parts (images and PDFs). */
export function attachmentsToParts(attachments?: Attachment[]): PromptPart[] {
  const parts: PromptPart[] = [];
  for (const att of attachments ?? []) {
    if (SUPPORTED_IMAGE.has(att.mediaType) || att.mediaType === "application/pdf") {
      parts.push({ inlineData: { mimeType: att.mediaType, data: att.data } });
    }
  }
  return parts;
}

/**
 * Bound conversation size while keeping the history structurally valid for the
 * API: starts on a plain user entry (not an orphaned half-exchange), and never
 * ends on a dangling function call awaiting its response.
 */
export function trimHistory(history: PromptContent[], maxEntries = 60): PromptContent[] {
  const h = history.length > maxEntries ? history.slice(-maxEntries) : history.slice();
  const isBareResponses = (c: PromptContent) =>
    c.role === "user" && c.parts.length > 0 && c.parts.every((p) => p.functionResponse);
  // Drop leading entries until the head is a real user turn. One loop, not
  // separate passes: a mid-exchange cut can leave model(call) -> user(resp) ->
  // model(call) at the head, and stopping after the first strip would leave an
  // orphaned function call first, which the API rejects with 400 ("function
  // call turn comes immediately after a user turn or after a function
  // response turn"). A bare user turn alone never starts a valid history.
  while (h.length) {
    const first = h[0];
    if (first.role !== "user" || isBareResponses(first)) {
      h.shift();
      continue;
    }
    break;
  }
  const endsDangling = () =>
    h.length > 0 &&
    h[h.length - 1].role === "model" &&
    h[h.length - 1].parts.some((p) => p.functionCall);
  while (endsDangling()) h.pop();
  return h;
}

/** Pull the reply text out of a generateContent response across SDK variants. */
export function responseText(response: any): string {
  const candidates = response?.candidates ?? [];
  const parts = candidates[0]?.content?.parts ?? [];
  return parts
    .filter((p: any) => typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();
}

/**
 * Model output parts to store back into conversation history, ready to be
 * replayed on the next generateContent call. Copied VERBATIM on purpose: Gemini
 * 3 attaches an encrypted thoughtSignature to function-call parts (and some
 * text parts), and the API rejects follow-up requests that replay a call
 * without its original signature. Only internal reasoning summaries (parts
 * flagged `thought`) are dropped; they are never meant to be sent back.
 */
export function sanitizeModelParts(parts: PromptPart[]): PromptPart[] {
  const kept: PromptPart[] = [];
  for (const p of parts ?? []) {
    if (!p) continue;
    if (p.functionCall) {
      kept.push(p);
    } else if (typeof p.text === "string" && !(p as any).thought) {
      kept.push(p);
    }
  }
  return kept;
}

// ─── per-chat history store ──────────────────────────────────────────────────

const HISTORY_FILE = config.geminiHistoryFile;
const TTL_MS = config.sessionTtlHours * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 60;

const sessions = new Map<string, { history: PromptContent[]; lastAccessed: number }>();

// ─── sticky last-good model ────────────────────────────────────────────────
//
// Failover walks the chain, but the walk itself costs seconds per overloaded
// model. Remembering which model answered last per tier lets the next run
// start there instead of re-walking from the top every time. Best-effort and
// self-healing: if the sticky pick fails, normal failover takes over and the
// new winner replaces it.
const LAST_GOOD_FILE = path.join(PROJECT_ROOT, "data", "gemini-last-good.json");

function loadLastGood(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(LAST_GOOD_FILE, "utf-8"));
    if (data && typeof data === "object") return data as Record<string, string>;
  } catch {
    // Missing or corrupt: start fresh, it rebuilds on the next success.
  }
  return {};
}

function rememberGoodModel(tier: string, model: string): void {
  try {
    const data = loadLastGood();
    if (data[tier] === model) return;
    data[tier] = model;
    fs.mkdirSync(path.dirname(LAST_GOOD_FILE), { recursive: true });
    const tmp = `${LAST_GOOD_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, LAST_GOOD_FILE);
  } catch {
    // Never let bookkeeping break a run.
  }
}

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    const cutoff = Date.now() - TTL_MS;
    let loaded = 0;
    for (const [key, entry] of Object.entries(data)) {
      const e = entry as { history: PromptContent[]; lastAccessed: number };
      if (e.lastAccessed >= cutoff && Array.isArray(e.history)) {
        sessions.set(key, e);
        loaded++;
      }
    }
    if (loaded > 0) console.log(`[gemini] Restored ${loaded} conversations from disk`);
  } catch (err) {
    console.warn("[gemini] Failed to load history:", (err as Error).message);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const tmp = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions), null, 2));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (err) {
    console.warn("[gemini] Failed to persist history:", (err as Error).message);
  }
}

loadFromDisk();

/** Touch-and-return the chat's live history, or undefined when expired/new. */
function getHistory(chatId: string): PromptContent[] | undefined {
  const entry = sessions.get(chatId);
  if (!entry) return undefined;
  if (Date.now() - entry.lastAccessed > TTL_MS) {
    sessions.delete(chatId);
    saveToDisk();
    return undefined;
  }
  entry.lastAccessed = Date.now();
  return trimHistory(entry.history, MAX_HISTORY_ENTRIES);
}

function commitHistory(chatId: string, history: PromptContent[]): void {
  sessions.set(chatId, {
    history: trimHistory(history, MAX_HISTORY_ENTRIES),
    lastAccessed: Date.now(),
  });
  saveToDisk();
}

/** Drop a chat's conversation (the /new command). */
export function clearGeminiHistory(chatId: string): void {
  if (sessions.delete(chatId)) saveToDisk();
}

/** Evict expired conversations. Called from the same interval as sessions.ts. */
export function evictExpiredGemini(): void {
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const [key, entry] of sessions) {
    if (entry.lastAccessed < cutoff) {
      sessions.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[gemini] Evicted ${removed} expired conversations`);
    saveToDisk();
  }
}

// Typed workspace operations replace the former raw-shell tool.
const WORKSPACE_DECLARATIONS: any[] = [
  {
    name: "run_script",
    description:
      "Run one approved helper script with an array of arguments. This does not invoke a shell.",
    parameters: {
      type: "OBJECT",
      properties: {
        script: { type: "STRING", enum: [...SCRIPT_NAMES] },
        args: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["script", "args"],
    },
  },
  {
    name: "read_file",
    description: "Read an approved non-secret project/profile/knowledge file by relative path.",
    parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write an approved profile, persona, logging-style, or knowledge file.",
    parameters: {
      type: "OBJECT",
      properties: { path: { type: "STRING" }, content: { type: "STRING" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_knowledge",
    description: "List loose files in the knowledge folder that have not been imported yet.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "move_knowledge",
    description: "Move an imported loose knowledge file into knowledge/processed/.",
    parameters: {
      type: "OBJECT",
      properties: { filename: { type: "STRING" } },
      required: ["filename"],
    },
  },
];

// ─── error classification ────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isQuotaError(msg: string): boolean {
  return /resource.?exhausted|quota|rate.?limit|\b429\b/i.test(msg);
}

/** The model id itself is gone or unavailable to this key (404-class). */
export function isModelUnavailableError(msg: string): boolean {
  return /\b404\b|not.?found|not_found|no longer available|does not exist/i.test(msg);
}

/** The model is up but shedding load (503-class, "high demand"). */
export function isOverloadedError(msg: string): boolean {
  return /\b503\b|overloaded|high demand|model is currently|unavailable/i.test(msg);
}

/** A per-day (not per-minute) quota exhaustion: retrying today is pointless. */
export function isPerDayQuota(msg: string): boolean {
  return /per[_-]?day|GenerateRequestsPerDay/i.test(msg);
}

// Models that hit a per-day cap, with the epoch ms when they may be tried
// again. Persisted so a restart does not re-walk into the same dead model;
// pruned on load. Per-minute quotas are NOT recorded (the retry window
// handles those).
const QUOTA_DEAD_FILE = path.join(PROJECT_ROOT, "data", "gemini-quotas.json");

function loadQuotaDead(): Record<string, number> {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_DEAD_FILE, "utf-8"));
    if (data && typeof data === "object") {
      const now = Date.now();
      const live: Record<string, number> = {};
      for (const [model, until] of Object.entries(data)) {
        if (typeof until === "number" && until > now) live[model] = until;
      }
      return live;
    }
  } catch {
    // Missing or corrupt: nothing is dead, failover decides everything.
  }
  return {};
}

function rememberQuotaDead(model: string, untilMs: number): void {
  try {
    const data = loadQuotaDead();
    data[model] = untilMs;
    fs.mkdirSync(path.dirname(QUOTA_DEAD_FILE), { recursive: true });
    const tmp = `${QUOTA_DEAD_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, QUOTA_DEAD_FILE);
  } catch {
    // Never let bookkeeping break a run.
  }
}

function isTransientError(msg: string): boolean {
  return /etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|overload|\b50[234]\b|unavailable|timeout/i.test(
    msg,
  );
}

/** Extract the "retry in Xs"/"retry in Xm Ys" hint from a quota error, if any. */
export function parseRetrySeconds(msg: string): number | null {
  const at = msg.search(/retry/i);
  if (at === -1) return null;
  const tail = msg.slice(at);
  // Minute form first ("1m5s"), then bare seconds ("22.496439837s").
  const minutes = /(\d+)\s*m\s*(\d+(?:\.\d+)?)\s*s/i.exec(tail);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  const seconds = /(\d+(?:\.\d+)?)\s*s\b/i.exec(tail);
  return seconds ? Number(seconds[1]) : null;
}

/**
 * Order the models one run may use. Configured entries that exist on this key
 * come first (env order respected), then every other chat-capable Gemini model
 * the key can see, scored per tier: heavy prefers flash then pro, light prefers
 * lite variants, and both end on "anything with budget". Non-chat models
 * (TTS, image gen, audio, embeddings, veo/lyria, robotics...) are excluded,
 * preview ids are deprioritised, and the appended tail is capped so a drained
 * primary never cascades through fifty models.
 */
const NON_CHAT_MODEL =
  /(tts|image|audio|live|veo|lyria|embedding|aqa|robotics|computer-use|deep-research|antigravity|nano-banana|omni|gemma|2\.5-flash|2\.5-pro)/i;
const PREVIEW_MODEL = /preview/i;
const MAX_FALLBACK_MODELS = 6;

export function resolveRunModels(
  configured: string[],
  discovered: string[] | null,
  tier: "fast" | "standard",
  lastGood?: string | null,
  deadModels?: string[],
): string[] {
  if (!discovered?.length) return configured;
  const dead = new Set(deadModels ?? []);
  const known = configured.filter((m) => discovered.includes(m) && !dead.has(m));
  const rest = discovered.filter(
    (m) =>
      !known.includes(m) &&
      !dead.has(m) &&
      m.toLowerCase().startsWith("gemini") &&
      !NON_CHAT_MODEL.test(m),
  );
  const score = (id: string) => {
    const l = id.toLowerCase();
    let s: number;
    if (l.includes("lite")) s = tier === "fast" ? 0 : 3;
    else if (l.includes("flash")) s = tier === "fast" ? 1 : 0;
    else if (l.includes("pro")) s = tier === "fast" ? 3 : 1;
    else s = 2;
    // Generation penalty (owner policy: proven older generations first for
    // speed; the newest stays reachable in the tail for heavy work). Older
    // flash generations answer faster and carry higher free-tier RPM, so each
    // major generation costs half a rank: 2.0-flash sorts before 3.6-flash,
    // which sorts before 3.8-flash, without disturbing lite/flash/pro order.
    const gen = /gemini-(\d+)/.exec(l);
    if (gen) s += Number(gen[1]) * 0.5;
    return s + (PREVIEW_MODEL.test(l) ? 10 : 0);
  };
  rest.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  const headroom = Math.max(0, MAX_FALLBACK_MODELS - known.length);
  let models = [...known, ...rest.slice(0, headroom)];
  // Everything is dead: trying anyway beats an empty chain (quotas reset).
  if (models.length === 0) {
    models = [...configured.filter((m) => discovered.includes(m)), ...rest.slice(0, headroom)];
  }
  // Start where the last run succeeded: skips the failover walk when the same
  // models are still healthy, costs one wasted attempt when they are not.
  if (lastGood && models.includes(lastGood)) {
    return [lastGood, ...models.filter((m) => m !== lastGood)];
  }
  return models;
}

// ─── model discovery ─────────────────────────────────────────────────────────

let availableModelsCache: Set<string> | null = null;

/**
 * Ask the key which models it can actually use (ListModels), cached for the
 * process lifetime. Guessing model names is how chains end up full of 404s;
 * this replaces guesses with reality. Returns null when listing fails, in
 * which case the configured chain is trusted as-is.
 */
async function getAvailableModels(ai: any): Promise<Set<string> | null> {
  if (availableModelsCache) return availableModelsCache;
  try {
    const names = new Set<string>();
    const page = await ai.models.list({ config: { pageSize: 200 } });
    for await (const m of page) {
      const id = String(m?.name ?? "").replace(/^models\//, "");
      const methods = (m as any)?.supportedGenerationMethods as string[] | undefined;
      if (id && (!methods || methods.includes("generateContent"))) names.add(id);
    }
    if (names.size > 0) {
      availableModelsCache = names;
      console.log(`[gemini] ${names.size} model(s) visible to this key`);
    }
    return availableModelsCache;
  } catch (err) {
    console.warn("[gemini] Could not list models:", (err as Error).message);
    return null;
  }
}

// ─── the run loop ────────────────────────────────────────────────────────────

/**
 * Run one incoming message through Gemini with the bash tool, mirroring the
 * Claude runner's contract (including retry behaviour and run logging).
 */
export async function runGeminiAgent(opts: {
  userMessage: string;
  chatId: string;
  userLabel?: string;
  modelTier?: "fast" | "standard";
  attachments?: Attachment[];
  onProgress?: (text: string) => void;
}): Promise<AgentResponse> {
  const { userMessage, chatId, userLabel, attachments, onProgress } = opts;
  const modelTier = opts.modelTier ?? "standard";
  // Context-based routing: heavy models coach, plan, advise, and see photos;
  // light models take quick transactional logs. Attachments always go heavy.
  // GEMINI_SMART_ROUTING=false pins everything to the heavy chain.
  const chain =
    config.geminiSmartRouting && modelTier === "fast" && (attachments?.length ?? 0) === 0
      ? config.geminiLightModels
      : config.geminiHeavyModels;
  const maxTurns = modelTier === "fast" ? 15 : 40;

  const now = new Date().toLocaleString("en-GB", { timeZone: config.timezone });
  const contextNote = `[Telegram chat ${chatId}${userLabel ? ` | ${userLabel}` : ""} | local time: ${now} (${config.timezone})]`;

  const persona = pickPersonality(chatId);

  const source = userLabel === "scheduled task" ? "scheduled" : "telegram";
  const startedAt = Date.now();
  const toolCounts: Record<string, number> = {};
  const systemPrompt = buildSystemPrompt(chatId, modelTier);

  const priorHistory = getHistory(chatId) ?? [];
  /** Parts for the new user turn: description text plus any images/PDFs. */
  const newParts: PromptPart[] = [];
  if (userMessage.trim()) newParts.push({ text: `${contextNote}\n${userMessage}` });
  else newParts.push({ text: contextNote });
  newParts.push(...attachmentsToParts(attachments));

  // Working copy; committed to the store once the full exchange completes.
  const history: PromptContent[] = [...priorHistory, { role: "user", parts: newParts }];

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  // Reality first: intersect the configured chain with what this key can
  // actually call, then append the rest of the key's models as deep fallbacks.
  // The last model that answered for this tier goes first (sticky): it skips
  // the failover walk while those models stay healthy. Models under a
  // remembered per-day cap are excluded until it lifts.
  const discovered = await getAvailableModels(ai);
  const lastGood = loadLastGood()[modelTier] ?? null;
  const deadModels = Object.keys(loadQuotaDead());
  const models = resolveRunModels(
    chain,
    discovered ? [...discovered] : null,
    modelTier,
    lastGood,
    deadModels,
  );
  console.log(
    `[gemini] Starting query (${models.join(" -> ")}, ${modelTier}, persona=${persona.id}):`,
    userMessage.slice(0, 100),
  );

  // Free-tier quotas are per model, so a drained primary hands the run to the
  // next model in the chain instead of failing. `model` is the current attempt.
  modelLoop: for (const model of models) {
    for (let attempt = 0; ; attempt++) {
      let turns = 0;
      try {
        for (; turns < maxTurns; turns++) {
          const response: any = await ai.models.generateContent({
            model,
            contents: history,
            config: {
              systemInstruction: systemPrompt,
              tools: [{ functionDeclarations: WORKSPACE_DECLARATIONS }],
              temperature: 0.7,
            },
          });

          // Keep the model's own parts (signatures included) for replay, and read
          // the calls out of them so we never reconstruct a signature-less call.
          const rawParts = response?.candidates?.[0]?.content?.parts ?? [];
          const modelParts = sanitizeModelParts(rawParts);
          const calls = modelParts.map((p) => p.functionCall).filter(Boolean) as Array<{
            name: string;
            args?: Record<string, unknown>;
          }>;
          const text = responseText(response);

          if (!calls.length) {
            history.push({ role: "model", parts: modelParts.length ? modelParts : [{ text }] });
            commitHistory(chatId, history);
            const record: RunRecord = {
              ts: new Date().toISOString(),
              chatId,
              userLabel,
              source,
              modelTier,
              model,
              isError: false,
              numTurns: turns + 1,
              durationMs: Date.now() - startedAt,
              usage: summariseUsage({
                input_tokens: response?.usageMetadata?.promptTokenCount,
                output_tokens:
                  (response?.usageMetadata?.candidatesTokenCount ?? 0) +
                  (response?.usageMetadata?.thoughtsTokenCount ?? 0),
              }),
              toolCounts,
              attempt: attempt + 1,
              outcome: text,
            };
            void appendRunRecord(record);
            rememberGoodModel(modelTier, model);
            return { text, sessionId: `gemini-${chatId}` };
          }

          // Model wants tools: replay its exact parts, execute the calls, feed
          // results back as the next user turn.
          history.push({ role: "model", parts: modelParts });
          const resultParts: PromptPart[] = [];
          for (const call of calls) {
            toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
            const response_ = await executeCoachTool(call.name, call.args ?? {}, chatId, {
              deferVisuals: true,
            });
            resultParts.push({
              functionResponse: { name: call.name, response: response_ },
            });
          }
          history.push({ role: "user", parts: resultParts });
        }

        // Ran out of turns without a final text answer.
        const fallback =
          "I ran out of steps before finishing that. Try again, or break it into a smaller ask.";
        history.push({ role: "model", parts: [{ text: fallback }] });
        commitHistory(chatId, history);
        void appendRunRecord({
          ts: new Date().toISOString(),
          chatId,
          userLabel,
          source,
          modelTier,
          model,
          isError: true,
          numTurns: maxTurns,
          durationMs: Date.now() - startedAt,
          toolCounts,
          attempt: attempt + 1,
          outcome: "max turns reached",
        });
        return { text: fallback, sessionId: `gemini-${chatId}` };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error("[gemini] generateContent threw:", msg);

        // Quota drained. Google's retry hint here is usually a per-minute window
        // (tens of seconds): wait once on the same model rather than spending
        // another model's budget, but only before any tool has run. Longer or
        // repeated exhaustion fails over to the next model in the chain.
        if (isQuotaError(msg)) {
          // Per-day caps are remembered so later runs skip the dead model
          // instead of burning an attempt on it every time. Per-minute
          // windows use the wait below; they clear on their own.
          if (isPerDayQuota(msg)) {
            rememberQuotaDead(model, Date.now() + 24 * 3600 * 1000);
            console.warn(`[gemini] ${model} hit a per-day cap; parked for 24h`);
          }
          const retryS = parseRetrySeconds(msg);
          if (
            retryS != null &&
            retryS <= 30 &&
            Object.keys(toolCounts).length === 0 &&
            attempt < MAX_ATTEMPTS - 1
          ) {
            const waitMs = Math.ceil(retryS * 1000) + 500;
            console.warn(
              `[gemini] ${model} rate window is ${retryS}s; waiting then retrying same model`,
            );
            await sleep(waitMs);
            continue;
          }

          const next = models[models.indexOf(model) + 1];
          if (next) {
            console.warn(`[gemini] ${model} hit its quota; failing over to ${next}`);
            continue modelLoop;
          }
          commitHistory(chatId, history.slice(0, -1)); // nothing will answer it
          return {
            text: "All my configured Gemini models are at capacity right now. Free-tier limits reset within minutes to a day; try again shortly.",
            sessionId: undefined,
          };
        }

        // Server-side overload (503/UNAVAILABLE, "high demand"): the model is
        // hot right now but a sibling usually is not. Fail over immediately:
        // retrying the same hot model is what the transient branch would do,
        // slowly, three times, before giving up without ever trying the next
        // model in the chain.
        if (isOverloadedError(msg)) {
          const next = models[models.indexOf(model) + 1];
          if (next) {
            console.warn(`[gemini] ${model} overloaded; failing over to ${next}`);
            continue modelLoop;
          }
          commitHistory(chatId, history.slice(0, -1)); // nothing will answer it
          return {
            text: "All my configured Gemini models are at capacity right now. Free-tier limits reset within minutes to a day; try again shortly.",
            sessionId: undefined,
          };
        }

        // This model id does not exist for this key (bad guess or retired id):
        // skip to the next candidate rather than dying on it.
        if (isModelUnavailableError(msg)) {
          const next = models[models.indexOf(model) + 1];
          if (next) {
            console.warn(`[gemini] ${model} unavailable (${msg.slice(0, 140)}); trying ${next}`);
            continue modelLoop;
          }
        }

        // Network blips and transient server errors. Before any tool ran,
        // retry the same model: nothing executed yet, so nothing duplicates.
        // After tools ran, fail over instead: the next model inherits the
        // completed tool results from history, while dying here would throw
        // away a run that already did its work (e.g. cards sent, reply lost).
        if (isTransientError(msg) && attempt < MAX_ATTEMPTS - 1) {
          if (Object.keys(toolCounts).length === 0) {
            const waitMs = Math.min(2 ** attempt, 8) * 1000;
            console.warn(
              `[gemini] transient error; retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${waitMs}ms`,
            );
            await sleep(waitMs);
            continue;
          }
          const next = models[models.indexOf(model) + 1];
          if (next) {
            console.warn(`[gemini] ${model} transient after tools ran; failing over to ${next}`);
            continue modelLoop;
          }
        }

        void appendRunRecord({
          ts: new Date().toISOString(),
          chatId,
          userLabel,
          source,
          modelTier,
          model,
          isError: true,
          numTurns: turns,
          durationMs: Date.now() - startedAt,
          toolCounts,
          attempt: attempt + 1,
          outcome: msg,
        });
        throw err;
      }
    }
  }
  // Unreachable: every chain iteration ends in a return or a throw.
  throw new Error("Gemini engine exhausted its model chain.");
}
