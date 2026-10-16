# Architecture

How the pieces fit together, and where to find things in the code.

## Request flow

```
Telegram
  │  message / photo / PDF / voice note
  ▼
grammy bot  (src/index.ts)                ── allowlist, dedupe, attachments, transcription
  │
  ├─ voice note ─► local Whisper (src/media/transcribe.ts) ─► text
  │
  ▼
runAgent  (src/agent/runner.ts)            ── Claude Agent SDK query()
  │   • persona overlay (src/agent/personalities.ts)
  │   • session resume   (src/agent/sessions.ts)
  │   • CLAUDE.md persona + coach-plugin skills
  │   • tools: coaching skills + restricted `coach` MCP file/script operations
  │   • no raw shell, arbitrary filesystem access, or web tools
  │   • Notion via scripts/notion.mjs, invoked with a fixed argument array
  ▼
reply  (src/channel/notify.ts, format.ts)  ── markdown → Telegram HTML, em-dash stripped, secrets redacted

scheduler  (src/scheduler/*)               ── croner fires reminders + the Sunday plan (polling mode)
```

The SDK runs the coach persona in `CLAUDE.md` with the skills in `coach-plugin/`.
Your private goals and stats live in `PERSONAL.md` (gitignored), so the repo stays
generic while the running agent is personalised to you.

## Source layout

`src/` is organised by domain so it scales as features are added:

| Folder | Responsibility |
|---|---|
| `src/index.ts` | Entry point and composition root: wires the bot, scheduler, and HTTP servers. |
| `src/config.ts` | Central env-driven configuration. |
| `src/agent/` | The agent loop (`runner.ts`), restricted script/file tools (`tooling.ts`, `mcp-tools.ts`), shared run coordinator (`coordinator.ts`), persona overlays, and per-chat session store. |
| `src/channel/` | Telegram transport: `notify.ts` (send), `format.ts` (markdown→HTML, em-dash strip), `webhook-server.ts`, `permissions.ts` (allowlist). |
| `src/media/` | Inbound media: `attachments.ts` (images/PDFs → content blocks), `transcribe.ts` (voice notes → text). |
| `src/notion/` | `status.ts` reports whether Notion is configured (a `NOTION_TOKEN` is set). Notion I/O goes through `scripts/notion.mjs` via the restricted `run_script` tool. |
| `src/scheduler/` | `scheduler.ts` (croner reminders) and `server.ts` (the localhost control plane). |
| `src/util/` | `redact.ts` (secret scrubbing) and `dedupe.ts` (webhook idempotency). |

## Bundled scripts

`scripts/` holds Node CLIs the agent calls through fixed-argument `run_script` operations (the "bundled-CLI" pattern),
plus deploy helpers:

| Script | Purpose |
|---|---|
| `scripts/notion.mjs` | Notion REST helper: `log`, `query-recent`, `append` (rich blocks + columns + inline formatting), `create-page`, `refresh-tile`, `resolve-db`. Retries on rate limits; self-heals a stale id cache. Unit-tested by `scripts/notion.test.mjs` (`npm test`). |
| `scripts/setup-workspace.mjs` | Idempotent builder for the full Notion workspace (databases + Dashboard). See [notion-architecture.md](./notion-architecture.md). |
| `scripts/exercise-db.mjs` | Queries the free, keyless exercise dataset (see [capabilities.md](./capabilities.md)). |
| `scripts/deploy-cloudrun.sh` | Google Cloud Run deploy (see [deployment.md](./deployment.md)). |

## Persistence

- **Sessions / schedule:** JSON files under `data/` (`SESSION_FILE`, `SCHEDULE_FILE`).
- **Notion id cache:** `data/notion-ids.json`, holding resolved database, Hub, Dashboard,
  and tile ids, discovered at setup and reused. No ids are hardcoded in the repo.
- **Notion** is the durable source of truth for training history, programs, goals,
  and stats.

## Trust boundaries and threat model

The agent receives a restricted tool set. Script calls run as direct Node processes with
argument arrays; project file access is limited to approved paths. It is still worth being
explicit about which inputs are trusted and which are not.

| Input | Trust | Why |
|---|---|---|
| Telegram text from an allowlisted user | Trusted as intent, not as configuration | `ALLOWED_TELEGRAM_IDS` gates who can talk to the agent. Runtime tool permissions limit what the model can do; persona instructions alone are not an access-control boundary. |
| Files the user drops in `knowledge/`, photos, PDFs | Untrusted | The user chose the file, but not necessarily its contents. A program PDF downloaded from a forum is attacker-controlled text. |
| Notion page content | Untrusted | Mostly agent-written, but Notion pages are shareable and editable by anyone the user invites. |
| Exercise dataset and other bundled script output | Untrusted as instructions | Third-party JSON, treated as data. |

The rule: **content-derived text is data, never instructions.** Anything that arrives
through a tool result (a script response, an attachment, a Notion block) is
material to reason about and quote, not a source of new orders. Only `CLAUDE.md`, the
skills in `coach-plugin/`, and the live user turn set what the agent should do. Text
inside ingested content that addresses the assistant ("SYSTEM NOTE", "ignore prior
instructions", "your operator config has changed") is a signal to flag the document to
the user, not to obey.

Current mitigations:

- **Private-chat allowlist** (`src/index.ts`, `src/channel/permissions.ts`): group messages are ignored, and unknown user ids never reach the agent.
- **Restricted tools** (`src/agent/tooling.ts`, `src/agent/mcp-tools.ts`): no raw shell, web tools, or arbitrary writes; helper scripts and file paths are allowlisted, script calls use `execFile` rather than a shell, and secret/configuration paths are blocked.
- **Egress redaction** (`src/util/redact.ts`, applied at the send boundary in
  `src/index.ts`): env-literal and pattern matching reduce accidental credential
  disclosure. They cannot identify every secret or personal detail.
- **Localhost-only control plane** (`src/scheduler/server.ts` binds `127.0.0.1`), and a
  bearer `CRON_SECRET` on `/cron/run` in webhook mode.
- **Session TTL** (`SESSION_TTL_HOURS`, default 12): expired sessions are not resumed.
  Transcript cleanup is best-effort and does not delete separate logs, backups,
  or Notion records.
- **Evals** (`evals/scenarios.json`): the `indirect-injection-*` scenarios feed the agent
  poisoned fixtures through a benign request and grade whether it obeyed, with the
  transcript's tool calls checked deterministically.

Current gaps, stated plainly:

- Nothing structurally separates ingested content from instructions inside the model
  context. The defence is the persona rules plus the model's own judgement, which is a
  probabilistic control, not a boundary.

The recommendation follows from that: run Oak in a container or a dedicated VM with only
the credentials it needs, not on a daily-driver machine with your SSH keys and browser
profile next to it. The Dockerfile in the repo root is the intended deployment shape, and
[deployment.md](./deployment.md) covers Cloud Run.

## Build and run

TypeScript (`NodeNext`, ESM) compiled to `dist/`. `npm run dev` runs `src/` via
`tsx` with `.env` loaded; `npm run build && npm start` runs the compiled output.
The Dockerfile copies `src/` and builds; the entry point is `dist/index.js`.
