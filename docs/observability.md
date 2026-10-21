# Usage and run logs

Send `/stats` in your private bot chat to see recorded activity from the last seven
days. The reply includes run and error counts, recorded turns, median and 95th
percentile run durations, Telegram versus scheduled activity, and the most-used
tools. It reads local records without calling an AI provider.

These are recorded AI runs, including retry attempts, rather than a count of every
Telegram message. Commands answered without an AI call do not add an agent run.
Missing or unreadable records can make the summary incomplete.

## Cost reporting

The cost total includes only positive per-run costs reported by the provider.
When some runs have no reported cost, `/stats` says how many. When none report a
cost, it displays `subscription (no per-run cost reported)`; this does not mean
usage was free. Use your provider's billing records for actual charges.

## Log location and contents

Records are stored as JSON Lines in `./data/agent-runs.jsonl`. Set `RUN_LOG_FILE`
to use another location. The default `data/` folder is ignored by Git; protect
any custom path and its backups yourself.

Depending on the provider and result, a record can include its timestamp, source,
model and tier, success/error status, retry attempt, turn count, duration, token
usage, reported cost, tool counts, and permission-denial count. Fields unavailable
from a provider are omitted.

## Privacy and retention

Keep `RUN_LOG_PERSONAL_DATA=false`, the default. New records then omit chat IDs,
usernames, session IDs, and reply samples while retaining usage metrics.

Setting it to `true` includes those identifiers and a reply or error sample of up
to 200 characters. Secret redaction is applied, but redaction is not anonymization:
identifiers and fitness information can remain. The setting affects new records;
it does not remove existing personal data or control other application logs.

Run logs have no automatic retention limit. Stop the bot before deleting or
archiving the configured log, and manage backup copies separately. Session expiry
and `/new` do not delete this history. See [Privacy and data controls](./privacy.md)
for storage, retention, and deletion boundaries.

## Response-stage timings

Run `npm run timings` from the project folder after sending a Telegram query to
inspect the latest completed request. No AI call is made by this command.

Bare `/foodlib` reads the saved library directly. Its trace contains a
`notion_read` span and Telegram delivery, with no agent or model requests.
The read has a ten-second timeout; Notion or network failures return a retry
message. Requests with extra questions still use the coach.

Private JSONL records are written to `./data/response-timings.jsonl`; set
`RESPONSE_TIMING_FILE` to use another location. Each update gets a random local
request ID. Records contain numeric stage durations, fixed operation names,
model IDs, and failure flags. They exclude Telegram/chat/user IDs, message text,
file paths, tool arguments/results, and raw errors. Protect custom log paths and
backups; these logs have no automatic retention limit.

The spans distinguish intake, same-chat (`chat_wait`) and shared provider-slot
(`provider_slot_wait`) waits, prompt preparation,
Gemini model discovery and requests, approved tools, retry sleeps, media work,
Notion saved-plan reads, and Telegram sends/acknowledgements. The other engines
have an overall agent span; their internal provider calls are not broken down.
Nested spans overlap: the agent span includes model, tool, and retry time, so
adding every displayed row does not give the total response time. `queue_wait`
remains the combined total of its nested chat and provider-slot wait spans.

`firstReplyAcceptedMs` and `lastReplyAcceptedMs` measure Telegram accepting a
message, not delivery to your phone. A quick acknowledgement is not confirmation
that a record was saved. `totalMs` includes retained background logging and album
work; optional dashboard refreshes are excluded. Album siblings are merged under
the originating album request; siblings can have wait-only timing records.

For ordinary messages, `telegramDeliveryLagMs` approximates the time from
Telegram's message timestamp to bot intake, with one-second timestamp precision.
It is omitted for button callbacks because the original card's timestamp does
not describe when a button was tapped. A restart or abrupt process kill can lose
unfinished request timings.

Polling admits up to 32 handlers while preserving ordered per-chat preparation
and queued saves. Session resets, voice switches, and workout completion remain
barriers so later work cannot be cleared by an older operation. Excess updates
stay with Telegram until capacity is available. Polling confirms only a completed
prefix of updates and deduplicates running updates by ID. While an older request
is unfinished, newer requests can be admitted from Telegram's first 100 pending
updates; larger backlogs wait for that prefix to finish. Duplicate delivery can
still occur after a crash between a save and its confirmation, as with ordinary
Telegram polling. See the [Telegram polling API](https://core.telegram.org/bots/api#getupdates).
Interactive Gemini quota retries
share a two-second sleep budget; longer retry hints put that model on cooldown
while another eligible model is tried. If every candidate is unavailable, the
bot reports capacity instead of spending minutes sleeping. Scheduled retries
keep their existing policy.

Interactive Gemini calls also have a 20-second per-call deadline and a 60-second
response budget by default. A model timeout appears as a failed `model_request`
span; completed tool work is retained. The budget starts after queue admission,
and a tool already running is allowed to finish before the queue is released.
See [Gemini response limits](./configuration.md#gemini-response-limits).
