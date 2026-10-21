# Configuration

All configuration is via environment variables, loaded from `.env` locally
(`npm run dev`/`npm start` read it automatically) or injected by your host in
production. [`.env.example`](../.env.example) is the source of truth with inline
comments; this page explains each setting.

## Required

For a first local chat, fill in the Telegram settings and **one** model credential.
The [beginner guide](../README.md#quickstart-local) includes Gemini, Claude, and OpenAI setup steps.
You can leave Notion, Google Calendar, and webhook settings blank until you need them.

| Variable | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather). |
| `ALLOWED_TELEGRAM_IDS` | Comma-separated numeric user ids allowed to use the bot. Everyone else is ignored. Find yours via [@userinfobot](https://t.me/userinfobot). |
| `GEMINI_API_KEY` | Gemini credential from [Google AI Studio](https://aistudio.google.com/apikey). Choose provider billing/data terms appropriate for the personal information you send. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription token from `claude setup-token` (`sk-ant-oat01-...`). |
| `OPENAI_API_KEY` | OpenAI API key from [the API platform](https://platform.openai.com/api-keys). ChatGPT subscriptions do not include API usage; API billing is separate. |
| `OWNER_CHAT_ID` | Your numeric private-chat user ID, normally the same as `ALLOWED_TELEGRAM_IDS`. Enables default reminders; optional for chatting. |

For the simplest first run, keep `MODE=polling`, set `TIMEZONE` to your own timezone,
and use `TRANSCRIBE_PROVIDER=off`. This avoids public URL setup and an extra voice-model
download. After changing `.env`, restart the bot so it reads the new settings.

When multiple provider credentials are set, selection order is Claude, then Gemini, then
OpenAI. Use one key for the provider you want. The Claude subscription path requires
`CLAUDE_CODE_OAUTH_TOKEN`; an existing CLI login or `ANTHROPIC_API_KEY` alone does not
pass the bot's startup check. Leave `ANTHROPIC_API_KEY` unset to avoid overriding
subscription authentication. OpenAI coaching uses the Responses API and supports the
same restricted workspace tools and image/PDF attachments as the other engines. It uses
Responses API conversation continuation; OpenAI stores response objects for 30 days by
default. See the official [conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state).

## Gemini response limits

| Variable | Default | What it is |
|---|---|---|
| `GEMINI_REQUEST_TIMEOUT_MS` | `20000` | Maximum time for one interactive Gemini generation call, in milliseconds. A timed-out call is cancelled and another eligible model is tried within the remaining response budget. |
| `GEMINI_RESPONSE_TIMEOUT_MS` | `60000` | Interactive wall-time budget after the agent starts. Includes model calls, discovery, retries and tools; excludes earlier queue waiting and Telegram delivery. |

Both settings must be positive whole milliseconds, no greater than `2147483647`.
Model discovery has a five-second cap or the remaining budget, whichever is
shorter. The SDK advertises at least a ten-second server deadline to satisfy
Gemini, while a separate local cancellation signal still enforces any shorter
configured or remaining time limit. Interactive SDK retries are disabled; the
bot owns retry/fallback timing.
Scheduled tasks keep their existing policy.

A running workspace save is allowed to finish even if it crosses the response
budget. The coach then stops starting new steps, preserves completed tool results,
and reports that the full request is unfinished. Remaining tools from the same
model response receive explicit skipped results. Workout completion retains its
local set ledger on an incomplete reply, so a later continuation can use it.
These are safe work limits, not a guarantee of a full reply within 60 seconds:
queue waiting, a running save, and Telegram delivery can add time.

## Notion (optional but recommended)

| Variable | What it is |
|---|---|
| `NOTION_TOKEN` | Internal connection (integration) token from [Notion developer connections](https://app.notion.com/developers/connections). Blank disables all Notion persistence; the bot still chats. |
| `NOTION_PARENT_PAGE_ID` | The private page under which the workspace is built. Set this for beginner setup; copy the page ID from its link. Advanced installs can instead pin a Hub in `config/notion-hub.json`. |

Connect the page to your integration through its **Connections** menu or nothing is
visible to the agent. Notion is optional for trying the chat, but required for saving
workout and meal logs. Restart after adding the settings, then send `/setup` in Telegram.
See [notion-architecture.md](./notion-architecture.md) for what gets built.

## Google Calendar (optional)

Puts planned training sessions on your Google Calendar with native phone
reminders (so you do not need to rely on Telegram notifications), and lets the
coach plan around your real commitments.

| Variable | What it is |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth "Desktop app" client credentials from Google Cloud Console (enable the Calendar API and add yourself as a consent-screen test user first). Blank disables calendar sync; the bot still runs. |
| `GOOGLE_REFRESH_TOKEN` | Optional. For deployments without the token file: the `refresh_token` value from `data/google-token.json`, stored as a secret. |
| `GOOGLE_CALENDAR_ID` | Optional. Which calendar to write to. Defaults to the calendar chosen with `calendar.mjs use-calendar`, then `primary`. |
| `GOOGLE_TOKEN_FILE` | Optional. Path of the token store, default `./data/google-token.json`; the container defaults to `/data/google-token.json`. |
| `GOOGLE_CALENDAR_FILE` | Optional. Saves the calendar chosen with `use-calendar`. Defaults to `./data/google-calendar.json` locally and `/data/google-calendar.json` in the container. `GOOGLE_CALENDAR_ID` takes precedence. |

After setting the client id and secret, authorise once with
`node --env-file=.env scripts/google-auth.mjs`. See
[google-calendar-architecture.md](./google-calendar-architecture.md).

## Agent identity and behaviour

| Variable | Default | What it is |
|---|---|---|
| `AGENT_NAME` | `Coach` | What the coach calls itself (plain-coach mode). |
| `TIMEZONE` | `Etc/UTC` | Set your own IANA timezone for reminders, local dates, reports, and the message-header clock. UTC is the neutral fallback. |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model for real coaching, planning, and advice (and for everything unless the fast tier is enabled). Set to `claude-opus-4-8` for Opus. |
| `CLAUDE_MODEL_FAST` | `claude-haiku-4-5` | Cheaper model used for trivial logging messages, only when `FAST_TIER_ENABLED=true`. |
| `OPENAI_MODEL` | `gpt-6.1-sol` | OpenAI Responses API model. |
| `OPENAI_MODEL_FAST` | `gpt-6-luna` | OpenAI model for short transactional logs and session-end writes; uses low reasoning effort and a slimmed prompt. Coaching queries and messages with attachments use `OPENAI_MODEL`. |
| `FAST_TIER_ENABLED` | `false` | When `true`, short transactional logging messages on new chats route to `CLAUDE_MODEL_FAST` to save subscription usage. Off by default so every message uses `CLAUDE_MODEL` for consistent behaviour. |
| `REASONING_EFFORT` | `medium` | Thinking depth for the standard model: `low \| medium \| high \| xhigh \| max`. Lower is faster and cheaper. |
| `PERSONALITIES_ENABLED` | `true` | Persona overlays (owner gets Arnold, others a stable random character). `false` keeps everyone on the plain coach. See [customization.md](./customization.md). |

## Storage

| Variable | Default | What it is |
|---|---|---|
| `SESSION_FILE` | `./data/sessions.json` | Per-chat Claude session ids. |
| `OPENAI_HISTORY_FILE` | `./data/openai-history.json` | Per-chat OpenAI Responses API conversation ids and TTL timestamps. |
| `SCHEDULE_FILE` | `./data/schedule.json` | Reminder schedule. |
| `PERSONAS_FILE` | `./data/personas.json` | Per-chat persona overrides set via `/persona`. |
| `CUSTOM_PERSONAS_FILE` | `./PERSONAS.md` | Custom voices made with `/create` (gitignored). |
| `SESSION_TTL_HOURS` | `12` | How long a conversation stays warm before a fresh session starts. |

In the container the entrypoint defaults these file paths (plus
`RAPID_LEDGER_FILE`, `RUN_LOG_FILE`, `GEMINI_HISTORY_FILE`,
`GOOGLE_TOKEN_FILE`, and `GOOGLE_CALENDAR_FILE`) to `/data`. Mount that volume
to retain these files across container replacement. Explicit environment values
override these defaults: replace older relative storage paths with `/data/...`
when deploying. Caches, report images, and knowledge staging remain outside the
volume. See the [storage and migration requirements](./deployment.md#always-on-polling-mode-the-default).

## Transport mode

| Variable | Default | What it is |
|---|---|---|
| `MODE` | `polling` (or `webhook` if `PUBLIC_BASE_URL` is set) | `polling` long-polls Telegram (always-on hosts); `webhook` runs an HTTP server for scale-to-zero hosts. |
| `PUBLIC_BASE_URL` | (none) | Required in webhook mode: the service's public HTTPS URL. Startup fails fast if `MODE=webhook` and this is unset. |
| `PORT` | `8080` | HTTP port (health checks, webhook, scheduler). |
| `CRON_SECRET` | (none) | Required in webhook mode: bearer secret an external scheduler sends to `POST /cron/run`. Startup fails fast if `MODE=webhook` and this is unset, so the reminder endpoint is never left unauthenticated. |

See [deployment.md](./deployment.md) for how the two modes map to hosts.

## Optional integrations

| Variable | Default | What it is |
|---|---|---|
| `TRANSCRIBE_PROVIDER` | `local` | Voice-note transcription: `local` (Whisper on your bot's host, needs RAM), `api` (sends audio to an OpenAI-compatible endpoint, needs a key), or `off` (disable voice). Telegram carries the audio, and transcribed text goes to your coaching provider. |
| `WHISPER_MODEL` | `Xenova/whisper-base` | Local model when `TRANSCRIBE_PROVIDER=local`. `whisper-tiny` faster, `whisper-small` more accurate. |
| `TRANSCRIBE_API_KEY` | (none) | Required for `api`. The transcription provider's key (e.g. your OpenAI key). This is separate from your Claude auth. |
| `TRANSCRIBE_API_URL` | OpenAI `/audio/transcriptions` | OpenAI-compatible transcription URL. Point at another provider (e.g. Groq) if preferred. |
| `TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Model for the `api` provider. `gpt-4o-transcribe` tops accuracy benchmarks; `gpt-4o-mini-transcribe` is cheaper. |
| `EXERCISE_DB_URL` | free-exercise-db raw JSON | Override only if you self-host the exercise dataset. |

> **Deployments:** local Whisper forces a large, always-paid instance (the model
> sits in memory for every request, voice or not), so on scale-to-zero hosts set
> `TRANSCRIBE_PROVIDER=api` (OpenAI `gpt-4o-transcribe` by default) and keep the
> instance small (~1 GiB). Reserve `local` for self-hosting where you have the RAM.
| `EXERCISE_DB_IMAGE_BASE` | free-exercise-db images | Override only if you self-host the exercise images. |

## Reminders

With `OWNER_CHAT_ID` set, two reminders are seeded by default: a morning session
nudge (11:00) and the Sunday weekly plan (18:00), in `TIMEZONE`. The coach cannot
add, change, or remove reminder jobs through chat. To customise them, stop the bot,
edit the tasks in `SCHEDULE_FILE`, and restart. In webhook mode, also configure
the external scheduler to trigger each task (see [deployment.md](./deployment.md)).
