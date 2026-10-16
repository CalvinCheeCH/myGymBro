/** Environment-driven configuration. All secrets come from env vars. */
export const config = {
  // Telegram
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),

  // Numeric Telegram user IDs allowed to talk to the bot.
  allowedUserIds: (process.env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Chat the bot sends proactive reminders to (usually your own user id).
  ownerChatId: process.env.OWNER_CHAT_ID ?? "",

  // Notion. Optional: when absent, Notion-backed features are disabled but the
  // bot still runs so you can chat to it.
  notionToken: process.env.NOTION_TOKEN ?? "",
  notionParentPageId: process.env.NOTION_PARENT_PAGE_ID ?? "",

  // Google Calendar. Optional: when absent, calendar features are disabled but
  // the bot still runs. The OAuth client id/secret come from Google Cloud
  // Console (Desktop app); the refresh token is minted once by
  // `scripts/google-auth.mjs` and lives in data/google-token.json, or in
  // GOOGLE_REFRESH_TOKEN for deployments backed by a secret store.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? "",
  googleTokenFile: process.env.GOOGLE_TOKEN_FILE ?? "./data/google-token.json",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID ?? "",

  // Claude subscription auth. The agent always runs on the subscription token
  // from `claude setup-token` (sk-ant-oat01-...), never a metered API key. The
  // SDK reads it from the environment; we surface it here to validate at startup.
  claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",

  // Gemini (Google AI Studio) alternative engine. When GEMINI_API_KEY is set and
  // no Claude token is present, the bot runs on Gemini instead of Claude: same
  // skills, same Notion tooling, same Telegram surface (see src/agent/gemini.ts).
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  // Context-based routing: heavy models coach, plan, advise, and see photos;
  // light models take quick transactional logs. Each is an ordered failover
  // chain tried left to right; quotas are per model, which is what makes
  // jumping between them such effective headroom.
  geminiSmartRouting: (process.env.GEMINI_SMART_ROUTING ?? "true") !== "false",
  geminiHistoryFile: process.env.GEMINI_HISTORY_FILE ?? "./data/gemini-history.json",
  // Defaults list only ids confirmed to exist for new free keys; at runtime the
  // engine asks the key for its full model list (ListModels) and appends every
  // other capable model it finds, so extra generations are used when available
  // instead of guessed at.
  geminiHeavyModels: buildGeminiChain(
    process.env.GEMINI_MODEL_HEAVY,
    ["gemini-2.0-flash", "gemini-3.6-flash", "gemini-3.6-flash-lite"],
    process.env.GEMINI_MODEL,
    process.env.GEMINI_MODEL_FALLBACKS,
  ),
  geminiLightModels: buildGeminiChain(
    process.env.GEMINI_MODEL_LIGHT,
    ["gemini-3.6-flash-lite", "gemini-2.0-flash"],
    process.env.GEMINI_MODEL_FAST,
  ),

  // OpenAI API is a third coaching engine. ChatGPT subscriptions do not include
  // API credits; this must be an API key from the OpenAI platform.
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-6.1-sol",
  openaiModelFast: process.env.OPENAI_MODEL_FAST ?? "gpt-6-luna",
  openaiHistoryFile: process.env.OPENAI_HISTORY_FILE ?? "./data/openai-history.json",

  // Agent identity and behaviour
  agentName: process.env.AGENT_NAME ?? "Coach",
  timezone: process.env.TIMEZONE ?? "Etc/UTC",

  // Persona overlays. When enabled, the owner chat gets the Arnold persona and
  // every other chat gets a stable random famous-character voice. The coach's
  // knowledge and safety rules are unchanged; only the tone differs. Set
  // PERSONALITIES_ENABLED=false to keep everyone on the plain coach.
  personalitiesEnabled: (process.env.PERSONALITIES_ENABLED ?? "true") !== "false",

  // The owner's persona: any persona id (e.g. "arnold", "yoda", "sherlock"),
  // "normal" for the plain coach, or "random" for a stable random character.
  ownerPersona: process.env.OWNER_PERSONA ?? "arnold",

  // Models. The main model for real coaching, the fast model for trivial logging.
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
  modelFast: process.env.CLAUDE_MODEL_FAST ?? "claude-haiku-4-5",

  // Route short, clearly-transactional logging messages to the cheaper fast model.
  // Off by default so behaviour is consistent out of the box (every message uses
  // CLAUDE_MODEL); opt in to save subscription usage on trivial logs.
  fastTierEnabled: (process.env.FAST_TIER_ENABLED ?? "false") === "true",

  // Reasoning effort for the standard model: low | medium | high | xhigh | max.
  // Lower means faster, cheaper replies with less deep thinking.
  reasoningEffort: (process.env.REASONING_EFFORT ?? "medium") as
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max",

  // Voice-note transcription: "local", "api", or "off". See docs/configuration.md.
  transcribeProvider: (process.env.TRANSCRIBE_PROVIDER ?? "local") as "local" | "api" | "off",
  transcribeApiUrl:
    process.env.TRANSCRIBE_API_URL ?? "https://api.openai.com/v1/audio/transcriptions",
  transcribeApiKey: process.env.TRANSCRIBE_API_KEY ?? "",
  transcribeModel: process.env.TRANSCRIBE_MODEL ?? "gpt-4o-transcribe",

  // Storage
  sessionFile: process.env.SESSION_FILE ?? "./data/sessions.json",
  scheduleFile: process.env.SCHEDULE_FILE ?? "./data/schedule.json",
  personasFile: process.env.PERSONAS_FILE ?? "./data/personas.json",
  customPersonasFile: process.env.CUSTOM_PERSONAS_FILE ?? "./PERSONAS.md",
  rapidLedgerFile: process.env.RAPID_LEDGER_FILE ?? "./data/rapid-ledger.json",
  // One JSONL line per agent run (metrics, tool counts, outcome sample). Read
  // back by /stats. See docs/observability.md.
  runLogFile: process.env.RUN_LOG_FILE ?? "./data/agent-runs.jsonl",
  // Personal identifiers and reply samples are excluded from metrics unless explicitly enabled.
  runLogPersonalData: process.env.RUN_LOG_PERSONAL_DATA === "true",
  sessionTtlHours: parsePositiveInteger("SESSION_TTL_HOURS", 12),

  // Transport. "polling" runs an always-on long-polling loop (simplest for local
  // and any always-on host). "webhook" runs an HTTP server that Telegram pushes
  // updates to, which is what lets the service scale to zero instances on a host
  // like Cloud Run. Defaults to webhook when PUBLIC_BASE_URL is set.
  mode: (process.env.MODE ?? (process.env.PUBLIC_BASE_URL ? "webhook" : "polling")) as
    | "polling"
    | "webhook",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  port: parsePort(process.env.PORT ?? "8080"),

  // Shared secret the external scheduler (e.g. Cloud Scheduler) must present to
  // call /cron/run. Required in webhook mode so the reminder endpoint is not open.
  cronSecret: process.env.CRON_SECRET ?? "",
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parsePositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive whole number; received ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number; received ${JSON.stringify(raw)}`);
  }
  return value;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(raw)}`);
  }
  return value;
}

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Resolve one Gemini chain from an explicit env list or a default, then merge
 * legacy knobs so old .env files keep working: GEMINI_MODEL(_FAST) becomes the
 * primary and GEMINI_MODEL_FALLBACKS appends, both deduped in order.
 */
function buildGeminiChain(
  explicit: string | undefined,
  defaults: string[],
  primary?: string,
  fallbacks?: string,
) {
  const list = explicit ? csv(explicit) : [...defaults];
  for (const m of [primary, ...(fallbacks ? csv(fallbacks) : [])]) {
    if (m && !list.includes(m)) {
      if (primary && m === primary) list.unshift(m);
      else list.push(m);
    }
  }
  return list;
}

/**
 * Provider precedence when multiple credentials are set: Claude, Gemini, OpenAI.
 */
export function pickEngine(): "claude" | "gemini" | "openai" {
  if (config.claudeOauthToken) return "claude";
  if (config.geminiApiKey) return "gemini";
  if (config.openaiApiKey) return "openai";
  return "claude";
}

/**
 * Validate configuration at startup, failing fast with a clear message rather than
 * letting a misconfiguration surface later as a 401 or a silently insecure deploy.
 * Provider-aware: at least one Claude, Gemini, or OpenAI credential is required.
 * Also covers webhook-mode settings
 * without which the service either cannot register its webhook or would expose an
 * unauthenticated /cron/run.
 */
export function checkClaudeAuth(): void {
  const validTelegramId = (id: string) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
  if (config.allowedUserIds.length === 0 || !config.allowedUserIds.every(validTelegramId)) {
    throw new Error(
      "ALLOWED_TELEGRAM_IDS must contain at least one positive numeric Telegram user ID.",
    );
  }
  if (
    config.ownerChatId &&
    (!validTelegramId(config.ownerChatId) || !config.allowedUserIds.includes(config.ownerChatId))
  ) {
    throw new Error(
      "OWNER_CHAT_ID must be a positive numeric ID included in ALLOWED_TELEGRAM_IDS.",
    );
  }
  const engine = pickEngine();
  if (engine === "gemini") {
    console.log(`[config] Engine: Gemini (${config.geminiModel}); Claude token not set`);
  } else if (engine === "openai") {
    console.log(
      `[config] Engine: OpenAI (${config.openaiModel}); Claude and Gemini credentials not set`,
    );
  } else if (!config.claudeOauthToken) {
    throw new Error(
      "No engine is configured. Either set CLAUDE_CODE_OAUTH_TOKEN (from `claude " +
        "setup-token`), GEMINI_API_KEY, or OPENAI_API_KEY to run the coach.",
    );
  } else {
    console.log("[config] Engine: Claude (subscription token)");
  }

  if (config.mode === "webhook") {
    if (!config.publicBaseUrl) {
      throw new Error(
        "MODE=webhook requires PUBLIC_BASE_URL (the service's public HTTPS URL) so the " +
          "Telegram webhook can be registered.",
      );
    }
    if (config.cronSecret.trim().length < 32) {
      throw new Error(
        "MODE=webhook requires a random CRON_SECRET of at least 32 characters to " +
          "authenticate /cron/run. Share it only with your scheduler.",
      );
    }
  }
}
