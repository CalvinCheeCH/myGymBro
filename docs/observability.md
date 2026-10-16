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
