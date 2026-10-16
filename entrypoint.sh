#!/bin/bash
set -e

# Default every agent-state file onto the mounted volume so conversation state,
# schedules, profiles, history, run metrics, tokens, and pending workout sets all
# survive restarts. Environment values still win for remote/secret stores.
export SESSION_FILE="${SESSION_FILE:-/data/sessions.json}"
export SCHEDULE_FILE="${SCHEDULE_FILE:-/data/schedule.json}"
export PERSONAS_FILE="${PERSONAS_FILE:-/data/personas.json}"
export CUSTOM_PERSONAS_FILE="${CUSTOM_PERSONAS_FILE:-/data/PERSONAS.md}"
export RAPID_LEDGER_FILE="${RAPID_LEDGER_FILE:-/data/rapid-ledger.json}"
export RUN_LOG_FILE="${RUN_LOG_FILE:-/data/agent-runs.jsonl}"
export GEMINI_HISTORY_FILE="${GEMINI_HISTORY_FILE:-/data/gemini-history.json}"
export OPENAI_HISTORY_FILE="${OPENAI_HISTORY_FILE:-/data/openai-history.json}"
export GOOGLE_TOKEN_FILE="${GOOGLE_TOKEN_FILE:-/data/google-token.json}"

mkdir -p /data /data/.claude

# Start the agent.
exec node dist/index.js
