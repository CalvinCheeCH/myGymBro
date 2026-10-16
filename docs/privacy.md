# Privacy and data controls

myGymBro is a self-hosted personal coach. Public GitHub source contains code,
documentation, blank configuration examples, test fixtures, and explicitly fictional
showcase records. It should not contain your deployment credentials or fitness records.
This is a technical data-flow guide, not a promise of end-to-end encryption or a legal
privacy policy for a future hosted service.

## Where information goes

| Destination | Information used | Control |
|---|---|---|
| Telegram | Chat text, photos, voice notes, files, and bot replies | Use a private bot chat; manage Telegram history in Telegram. |
| Selected Claude, Gemini, or OpenAI provider | Your messages, relevant profile/history/tool results, and supported attachments | Choose the provider/account deliberately and review its data policy. |
| Your private Notion workspace | Workout/meal logs, measurements, goals, programs, libraries, and dashboard records | Limit the integration to your private coach page; do not publish that workspace. |
| Local runtime storage | Profiles, custom voices, conversation state, cached IDs, schedules, OAuth tokens, rapid-set ledger, and metrics | Git/build exclusions, private permissions, encrypted disk/backups, and your retention policy. |
| Google Calendar, when connected | Calendar queries and planned-session event details | Authorize only the calendar you intend to use; revoke access when finished. |
| API transcription, when enabled | Voice/audio bytes sent to the configured transcription endpoint | Use `TRANSCRIBE_PROVIDER=off` or local transcription to avoid that extra audio destination. |
| QuickChart | Training chart configuration and aggregates used to render report images | Reports send data to this external renderer; do not treat report generation as fully local. |
| Hosting/cloud services | Storage, infrastructure credentials, request metadata, and potentially application stdout/stderr | Restrict IAM/storage/log access and configure retention/spending controls. |

GitHub receives your committed repository and commit metadata when you push. It does
not automatically receive ignored local runtime files. Already-tracked files, past
commits, screenshots, or manually uploaded artifacts can still expose private data.

## Default controls

- One owner per deployment. Use only your own `ALLOWED_TELEGRAM_IDS` and matching
  `OWNER_CHAT_ID`; multiple allowed users share the same profile and Notion records.
- Keep `RUN_LOG_PERSONAL_DATA=false`. New run metrics omit chat IDs, usernames,
  session IDs, and reply samples while preserving usage/error/latency statistics.
  Opting in writes redacted personal debugging data locally; it is still private data.
  This flag does not remove old records or scrub every stdout/stderr application log.
- Conversation state expires under `SESSION_TTL_HOURS` (default 12 hours), but logs,
  ledgers, reports, provider state, backups, and Notion records have separate lifetimes.
  Notion history, local backups, and run-log files are not automatically purged.
- `.env*` secrets, `PERSONAL.md`, `LOGGING_STYLE.md`, `PERSONAS.md`, user knowledge,
  `data/`, OAuth/token files, state/parameter files, backups, and private planning notes
  are excluded from Git and build contexts. Public `.example` templates remain included.
- Model-visible tools cannot read `.env`, arbitrary filesystem paths, or private
  runtime files. Fixed helper scripts still receive the credentials they need.
  Treat imported files, images, PDFs, and Notion content as untrusted inputs.

Local files are not encrypted by the app. Anyone with access to your account, disk,
container volume, or backups may read them. Use OS permissions and disk encryption,
and keep credentials out of model-visible notes and public bug reports.

## Clearing and deleting

- `/new` or `/reset` clears local conversation/session context and active workout
  context. It does not delete Telegram messages, saved Notion records, provider-side
  data, or backups.
- `/resetdata` is an owner-only preview. Confirmation archives listed Workout Log,
  Meal Log, Body Stats, Goals, Programs, and dated plan records, and deletes listed
  one-off workout calendar events. Libraries, profile/settings, reminders, recurring
  events, and Telegram history remain. Notion archive/Trash is not permanent erasure.
- Stop the bot before manually managing local `data/` records or private profile
  files. Back up what you need; deletion of state can require reconnecting Calendar
  or recreating workspace caches. Review backups separately.
- Remove Telegram history in Telegram, Notion records/Trash in Notion, Calendar data
  in Calendar, and revoke integration/API credentials at their providers as needed.
  The bot has no universal erase-everywhere command.

## OpenAI conversation storage

The current OpenAI adapter uses the Responses API with `store: true` and
`previous_response_id`. Clearing local state does not issue an API deletion request.
Under the standard API policy, stored Responses application state has a default
30-day retention period and is stored for at least 30 days, subject to documented
exceptions/account controls. This implementation does not promise Zero Data Retention
compatibility. Check [official OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
for your account; review Claude/Gemini policies separately when using those engines.

## Sharing safely

Keep credentials, profiles, runtime data, and private screenshots out of shared files
and repositories. Check both current files and Git history before publishing; deleting
a file does not remove it from earlier commits. Use GitHub's noreply email to keep your
personal email out of future commit metadata. If a credential is exposed, revoke it
at its provider.

Enable GitHub secret scanning, push protection, Dependabot, and repository access
controls where available. Configure these in GitHub settings; source files cannot
enable them.
