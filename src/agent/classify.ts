/**
 * Lightweight query classifier shared by both engines.
 *
 * Routes short, clearly transactional logging messages (e.g. "did 5x5 squats at
 * 80kg", "ate chicken and rice just now") to the light tier, and keeps everything that
 * smells like coaching, planning, or advice on the heavy tier. Conservative by
 * design: when in doubt, return "standard". Photos and PDFs are upgraded to
 * standard by the callers (vision needs the stronger models).
 */

export type ModelTier = "fast" | "standard";

const STANDARD_PATTERNS = [
  /\b(plan|recommend|suggest|advise|advice|should i|what.?should|why|how do|how should|design|review|analyse|analyze|explain|motivate|feeling|tired|sore|injur|pain|diet|nutrition|macro|calorie|meal|eat|goal|progress|report|compare|trend)\b/,
];

const FAST_PREFIXES = [
  /^(log|logged|did|done|completed|finished|just did|just ate|just had|add)\b/,
  /^(ate|had|drank|drink|makan|minum|dah)\b/,
  /^(breakfast|lunch|dinner|supper|snack)\b/,
  /^(settle|settled|selesai|siap|that'?s all|that is all|end)\b/,
];

/**
 * Words that turn a log-shaped message into a question or coaching request.
 * Food nouns (meal, eat, calorie, macro, diet) are deliberately NOT here: "log
 * meal" or "dinner 800 cal" are logs and stay fast. Anything asking, planning,
 * hurting, or reviewing goes standard even when it starts with a log prefix
 * (e.g. "did my progress improve?", "dinner ideas for cutting?").
 */
const QUESTION_OVERRIDE =
  /[?]|\b(should i|what should|can i|could i|would i|do i|did i|am i|is (?:it|this|that)|does (?:it|this|that)|what|why|how|review|analys|analyze|explain|plan|recommend|suggest|advis|advice|injur|pain|sore|tired|feeling|goal|progress|report|compare|trend|motivat|idea|ideas|tip|tips|enough|safe|question)\b/;

/** Bare "60x12" style set notation: almost always a between-sets rapid log. */
const SET_NOTATION = /\b\d+(\.\d+)?\s*[x×]\s*\d+\b/i;

/** Meal logs use the light tier without opening or completing a workout clock. */
export function isMealLog(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (lower.length >= 200 || QUESTION_OVERRIDE.test(lower) || SET_NOTATION.test(lower))
    return false;
  return (
    /^(?:i\s+)?(?:just\s+)?(?:ate|had|drank|drink|makan|minum|dah)\b/.test(lower) ||
    /^(?:my\s+)?(?:breakfast|lunch|dinner|supper|snack)\b/.test(lower) ||
    /^(?:i\s+)?(?:log|logged|add|finished|completed|done)\s+(?:with\s+)?(?:my\s+)?(?:meal|breakfast|lunch|dinner|supper|snack|food|eating)\b/.test(
      lower,
    )
  );
}

export function classifyQuery(text: string): ModelTier {
  const lower = text.toLowerCase().trim();
  const short = lower.length < 200;
  const questionLike = QUESTION_OVERRIDE.test(lower);

  if (isMealLog(lower)) return "fast";

  // Short log-shaped messages go fast unless they ask something. FAST wins
  // over STANDARD here on purpose: "log meal prep" is a log, not advice.
  if (short && !questionLike && FAST_PREFIXES.some((p) => p.test(lower))) {
    return "fast";
  }

  // A session-end buried in a short message ("yup that's the end, done") is
  // still just a mechanical Notion write: keep it on the cheap chain.
  if (short && !questionLike && /\b(done|settle|selesai|siap)\b/.test(lower)) {
    return "fast";
  }

  for (const pattern of STANDARD_PATTERNS) {
    if (pattern.test(lower)) return "standard";
  }

  if (short && !questionLike && SET_NOTATION.test(lower)) {
    return "fast";
  }

  return "standard";
}

/** Session-end keywords as the whole message: the full write + reply path. */
const SESSION_FINAL_EXACT =
  /^(done|settle|settled|end|selesai|siap|that'?s all|that is all)[.!]*$/i;
/** ... or buried in a short message ("yup that's the end, done"). */
const SESSION_FINAL_LOOSE = /\b(done|settled?|selesai|siap|the end)\b/i;
/** ... unless negated or continued ("not done yet", "one more set"). */
const SESSION_FINAL_NEG =
  /\b(not|n't|never|yet|more|continue|keep going|almost|one more|another|feeling|tired|sore|pain|injur)\b/i;

/**
 * True when the user is closing the session, so the run must execute the full
 * write loop and reply (never ack-and-background). "The end" matches loosely
 * on purpose; the negation guard keeps "not done yet" on the normal path.
 */
export function isSessionFinal(text: string): boolean {
  const t = text.trim();
  if (SESSION_FINAL_EXACT.test(t)) return true;
  return t.length < 80 && SESSION_FINAL_LOOSE.test(t) && !SESSION_FINAL_NEG.test(t);
}

/**
 * True for agent correction confirmations ("Fixed: ...", "Corrected: ...").
 * Contract with the logging skills: amendment confirmations MUST start with
 * one of these prefixes so the host can tell them apart from bare acks.
 * The host delivers them (unlike "Noted." dupes) because the user explicitly
 * asked for a change and needs to hear it landed.
 */
export function isCorrectionConfirm(text: string): boolean {
  return /^\s*(fixed|corrected|updated)\s*:/i.test(text);
}

/**
 * True for between-sets workout logs only ("db bench 60x12", "12x12"): safe
 * to ack instantly and accumulate in the background. Meal logs are excluded
 * on purpose: they need their estimate reply, so they take the normal path.
 */
export function isRapidFireLog(text: string): boolean {
  const t = text.trim();
  if (!t.length || t.length >= 200 || t.includes("?")) return false;
  return /^(did|just did|completed|finished|logged)\b/i.test(t) || SET_NOTATION.test(t);
}

/**
 * Deterministic rapid-set ledger. Background runs each see the full chat, but
 * the model has proven unreliable at aggregating amendments across messages
 * (it appends instead of replacing, and values drift). So the host tracks
 * sets structurally per chat: every rapid message becomes one ledger entry,
 * and an amendment replaces the previous entry instead of appending. Entries
 * keep the user's raw text (the agent still parses each line with the usual
 * notation rules, which work per message); the ledger only guarantees ORDER
 * and REPLACEMENT. On "done" it is injected as authoritative and the agent
 * must not re-derive sets from chat history.
 */
export interface RapidEntry {
  /** Exercise name if the message named one, else "" (inherits at render). */
  exercise: string;
  /** Raw message text minus any amend marker. */
  raw: string;
}
export interface RapidLedger {
  entries: RapidEntry[];
  currentExercise: string;
}
export function emptyRapidLedger(): RapidLedger {
  return { entries: [], currentExercise: "" };
}

/** Trailing `*` ("15x12*") or apology/correction phrasing ("sorry, ..."). */
const AMEND_MARKER = /\*\s*$/;
const SORRY_PATTERN =
  /\b(sorry|sry|should be|meant|my bad|typo|wrong|mistake|oops|actually|correction|fix this)\b/i;

export function isAmendment(text: string): boolean {
  const t = text.trim();
  return AMEND_MARKER.test(t) || SORRY_PATTERN.test(t);
}

/** Words that are filler, never an exercise name. */
const FILLER_WORDS =
  /\b(sorry|sry|should|be|meant|my|bad|typo|oops|actually|correction|fix|fixed|just|now|the|a|an|per|set|rep|reps|last|previous|that|this|it|for|me|was|is|to|of|please|pls|hey|coach|mate|bro|bos|aba|did|just|completed|finished|logged|log|add)\b/gi;
const DID_VERBS = /^(did|just did|completed|finished|logged|log|add)\b/i;

/** Leading did-verbs stripped ("did squats 80kg" keeps "squats 80kg"). */
function stripDidVerbs(t: string): string {
  return t.replace(DID_VERBS, "").trim();
}

/**
 * Best-effort exercise name from a rapid message, or null when it names none
 * ("12x10" inherits whoever came before). Strips pairs, markers, filler, and
 * lone weights ("squats 80kg" keeps "squats").
 */
export function extractExerciseName(text: string): string | null {
  let t = text.trim().replace(/\*\s*$/, "");
  t = t.replace(/(\d+(?:\.\d+)?)\s*(?:kg|lb)?\s*x\s*\d+/gi, " ");
  t = stripDidVerbs(t);
  t = t.replace(/\b\d+(?:\.\d+)?\s*(?:kg|lb)\b/gi, " ");
  t = t.replace(FILLER_WORDS, " ");
  t = t
    .replace(/[,.:;!?()[\]"'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || !/[a-zA-Z]/.test(t)) return null;
  return t;
}

/**
 * Fold one rapid message into the ledger. Returns the new ledger plus whether
 * it amended (replaced the previous entry). A message with no pairs only
 * updates the current exercise label. An amendment with an empty ledger
 * degrades to a plain push so nothing is ever silently dropped.
 */
export function applyRapidMessage(
  ledger: RapidLedger,
  text: string,
): { ledger: RapidLedger; amended: boolean } {
  const t = text.trim();
  const hasPairs = SET_NOTATION.test(t);
  const name = extractExerciseName(t);
  if (!hasPairs) {
    if (name) return { ledger: { ...ledger, currentExercise: name }, amended: false };
    return { ledger, amended: false };
  }
  const raw = t.replace(/\*\s*$/, "").trim();
  const exercise = name ?? ledger.currentExercise;
  const entry: RapidEntry = { exercise, raw };
  if (isAmendment(t) && ledger.entries.length > 0) {
    return {
      ledger: { entries: [...ledger.entries.slice(0, -1), entry], currentExercise: exercise },
      amended: true,
    };
  }
  return {
    ledger: { entries: [...ledger.entries, entry], currentExercise: exercise },
    amended: false,
  };
}

/** Render the ledger for Done-context injection, grouped like the Notion body. */
export function renderRapidLedger(ledger: RapidLedger): string {
  const lines = [
    "[Session sets ledger — authoritative, amendments already applied. " +
      "Do NOT re-derive sets from chat history; compute Volume/Top Set/totals from this list only:",
  ];
  let open = "";
  for (const e of ledger.entries) {
    if (e.exercise && e.exercise !== open) {
      open = e.exercise;
      lines.push(`### ${open}`);
    }
    lines.push(`- ${e.raw}`);
  }
  lines.push("]");
  return lines.join("\n");
}
