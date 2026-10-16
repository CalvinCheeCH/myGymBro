/** OpenAI Responses API engine, using the same prompt and restricted coach tools as Gemini. */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Attachment } from "../media/attachments.js";
import { buildSystemPrompt } from "./gemini.js";
import { type RunRecord, appendRunRecord, summariseUsage } from "./runlog.js";
import { executeCoachTool } from "./tooling.js";

const TTL_MS = config.sessionTtlHours * 60 * 60 * 1000;
const MAX_TURNS = 40;
type Conversation = { responseId: string; lastAccessed: number };
const conversations = new Map<string, Conversation>();

export function usesOpenAIFastModel(
  modelTier: "fast" | "standard" | undefined,
  attachmentCount: number,
): boolean {
  return modelTier === "fast" && attachmentCount === 0;
}

const TOOLS = [
  {
    type: "function",
    name: "run_script",
    description:
      "Run one approved helper script with an argument array. This does not invoke a shell.",
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          enum: [
            "calendar.mjs",
            "exercise-db.mjs",
            "notion.mjs",
            "progression.mjs",
            "publish-heatmap.mjs",
            "report-card.mjs",
            "send-photo.mjs",
            "setup-workspace.mjs",
          ],
        },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["script", "args"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_file",
    description:
      "Read an approved non-secret project, profile, or knowledge file by relative path.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "write_file",
    description: "Write an approved profile, persona, logging-style, or knowledge file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_knowledge",
    description: "List loose files in the knowledge folder that have not been imported yet.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "move_knowledge",
    description: "Move an imported loose knowledge file into knowledge/processed/.",
    parameters: {
      type: "object",
      properties: { filename: { type: "string" } },
      required: ["filename"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(config.openaiHistoryFile), { recursive: true });
    const tmp = `${config.openaiHistoryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(conversations), null, 2));
    fs.renameSync(tmp, config.openaiHistoryFile);
  } catch (err) {
    console.warn("[openai] Could not persist conversation ids:", (err as Error).message);
  }
}

try {
  const saved = JSON.parse(fs.readFileSync(config.openaiHistoryFile, "utf8")) as Record<
    string,
    Conversation
  >;
  for (const [chatId, entry] of Object.entries(saved)) {
    if (entry.responseId && Date.now() - entry.lastAccessed < TTL_MS)
      conversations.set(chatId, entry);
  }
} catch {
  // Missing or invalid local state starts fresh.
}

export function clearOpenAIHistory(chatId: string): void {
  if (conversations.delete(chatId)) persist();
}

export function evictExpiredOpenAI(): void {
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const [chatId, entry] of conversations) {
    if (entry.lastAccessed < cutoff) {
      conversations.delete(chatId);
      removed++;
    }
  }
  if (removed) persist();
}

function messageInput(text: string, attachments?: Attachment[]) {
  const supported = (attachments ?? []).filter((a) =>
    ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"].includes(a.mediaType),
  );
  if (!supported.length) return text;
  return [
    ...(text.trim() ? [{ type: "input_text", text }] : []),
    ...supported.map((a) =>
      a.mediaType === "application/pdf"
        ? {
            type: "input_file",
            filename: "attachment.pdf",
            file_data: `data:${a.mediaType};base64,${a.data}`,
          }
        : { type: "input_image", image_url: `data:${a.mediaType};base64,${a.data}` },
    ),
  ];
}

async function createResponse(body: Record<string, unknown>): Promise<any> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `OpenAI API ${response.status}: ${payload?.error?.message ?? response.statusText}`,
    );
  return payload;
}

export async function runOpenAIAgent(opts: {
  userMessage: string;
  chatId: string;
  userLabel?: string;
  modelTier?: "fast" | "standard";
  attachments?: Attachment[];
  onProgress?: (text: string) => void;
}): Promise<{ text: string; sessionId?: string }> {
  const { chatId, userMessage, userLabel, attachments } = opts;
  const now = new Date().toLocaleString("en-GB", { timeZone: config.timezone });
  const useFastModel = usesOpenAIFastModel(opts.modelTier, attachments?.length ?? 0);
  const model = useFastModel ? config.openaiModelFast : config.openaiModel;
  const instructions = buildSystemPrompt(chatId, useFastModel ? "fast" : "standard");
  let conversation = conversations.get(chatId);
  if (conversation && Date.now() - conversation.lastAccessed > TTL_MS) {
    conversations.delete(chatId);
    persist();
    conversation = undefined;
  }
  if (conversation) {
    conversation.lastAccessed = Date.now();
    persist();
  }
  const context = `[Telegram chat ${chatId}${userLabel ? ` | ${userLabel}` : ""} | local time: ${now} (${config.timezone})]\n${userMessage}`;
  let input: unknown = messageInput(context, attachments);
  let previousResponseId = conversation?.responseId;
  const toolCounts: Record<string, number> = {};
  const startedAt = Date.now();
  const source = userLabel === "scheduled task" ? "scheduled" : "telegram";

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await createResponse({
        model,
        instructions,
        input,
        store: true,
        tools: TOOLS,
        reasoning: { effort: useFastModel ? "low" : config.reasoningEffort },
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      });
      previousResponseId = response.id;
      const calls = (response.output ?? []).filter((item: any) => item.type === "function_call");
      if (!calls.length) {
        const text = String(response.output_text ?? "").trim();
        if (!text) throw new Error("OpenAI returned no text response.");
        conversations.set(chatId, { responseId: response.id, lastAccessed: Date.now() });
        persist();
        const record: RunRecord = {
          ts: new Date().toISOString(),
          chatId,
          userLabel,
          source,
          modelTier: opts.modelTier ?? "standard",
          model,
          isError: false,
          numTurns: turn + 1,
          durationMs: Date.now() - startedAt,
          usage: summariseUsage(response.usage),
          toolCounts,
          attempt: 1,
          outcome: text,
        };
        void appendRunRecord(record);
        return { text, sessionId: `openai-${chatId}` };
      }
      const outputs = [];
      for (const call of calls) {
        const args = JSON.parse(call.arguments || "{}");
        toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
        const result = await executeCoachTool(call.name, args, chatId);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }
      input = outputs;
    }
    throw new Error(`OpenAI reached the ${MAX_TURNS}-turn tool limit.`);
  } catch (err) {
    void appendRunRecord({
      ts: new Date().toISOString(),
      chatId,
      userLabel,
      source,
      modelTier: opts.modelTier ?? "standard",
      model,
      isError: true,
      durationMs: Date.now() - startedAt,
      toolCounts,
      attempt: 1,
      outcome: (err as Error).message,
    });
    throw err;
  }
}
