/**
 * Friendly failure explanations and the error-classification primitives that
 * back them. The raw error already hit the console with full detail; these
 * translations keep the user oriented without exposing internals. The engine
 * (agent/gemini.ts) reuses the same predicates for its failover walk, so there
 * is one source of truth for what counts as quota, overload, or transient.
 */
import { humanizeWaitSeconds } from "../util/format.js";

export function isQuotaError(msg: string): boolean {
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

/** Extract the "retry in Xs"/"retry in Xh Ym Zs" hint from a quota error, if any. */
export function parseRetrySeconds(msg: string): number | null {
  const at = msg.search(/retry/i);
  if (at === -1) return null;
  const tail = msg.slice(at);
  // Hour form first ("17h2m35s" — its "2m35s" tail must never be read alone),
  // then minute form ("1m5s"), then bare seconds ("22.496439837s"), then
  // bare hours ("4h").
  const hoursMinutes = /(?:(\d+)\s*h\s*)?(\d+)\s*m\s*(\d+(?:\.\d+)?)\s*s/i.exec(tail);
  if (hoursMinutes) {
    return (
      Number(hoursMinutes[1] ?? 0) * 3600 + Number(hoursMinutes[2]) * 60 + Number(hoursMinutes[3])
    );
  }
  const hours = /(\d+)\s*h\b/i.exec(tail);
  if (hours) return Number(hours[1]) * 3600;
  const seconds = /(\d+(?:\.\d+)?)\s*s\b/i.exec(tail);
  return seconds ? Number(seconds[1]) : null;
}

export function classifyError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("workspace reset"))
    return "Workspace reset is in progress. Send your message again when it finishes.";
  if (lower.includes("usage limit") || lower.includes("credit balance is too low"))
    return "I have hit the Claude subscription usage limit. It resets on a rolling window, so try again shortly.";
  if (lower.includes("max_turns") || lower.includes("max turns"))
    return "That request got too involved for one go. Try breaking it into smaller asks.";
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "That took too long and timed out. Worth trying again.";
  if (lower.includes("notion"))
    return "I am having trouble reaching Notion right now. Check the integration token and that the page is shared with it, then try again.";

  // Gemini-specific failures. Per-model daily caps drain quietly, and 503/504
  // bursts come in waves; the retry window is usually stated in the error.
  if (isQuotaError(msg)) {
    const reset = humanizeWaitSeconds(parseRetrySeconds(msg));
    if (isPerDayQuota(msg)) {
      return `Gemini's free daily quota is used up${reset ? ` — it resets in ${reset}` : ""}. Your last message did not go through, so send it again after the reset.`;
    }
    return `Gemini is rate limiting me right now${reset ? `; it clears in ${reset}` : ""}. Send that again in a moment and I'll handle it.`;
  }
  if (isOverloadedError(msg))
    return (
      "Every Gemini model is overloaded right now. That usually clears in minutes; " +
      "try again shortly."
    );
  if (/\b504\b|deadline expired/i.test(msg))
    return "That request ran past its time limit before a model could finish. Worth trying again right away.";
  return "Something went wrong handling that. I have logged the details. Try again in a moment.";
}
