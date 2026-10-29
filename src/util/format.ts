/**
 * Humanise a retry window for chat: provider quota messages report seconds
 * ("61355s"); a coach reply should say "about 17 hours". Returns null for
 * non-positive input so callers can fall back to their own wording.
 */
export function humanizeWaitSeconds(totalSeconds: number | null | undefined): string | null {
  if (!totalSeconds || totalSeconds <= 0) return null;
  if (totalSeconds >= 3600) {
    const hours = Math.max(1, Math.round(totalSeconds / 3600));
    return hours === 1 ? "about an hour" : `about ${hours} hours`;
  }
  if (totalSeconds >= 60) {
    const minutes = Math.max(1, Math.round(totalSeconds / 60));
    return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  }
  return "less than a minute";
}
