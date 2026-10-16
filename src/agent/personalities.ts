/**
 * Persona overlays.
 *
 * The coach's knowledge, judgement, tools, and safety rules all live in
 * CLAUDE.md and never change. A persona only changes the *voice*: tone,
 * phrasing, catchphrases. We append it to the claude_code system prompt.
 *
 * Selection (first match wins):
 *   - A per-chat override set via the /persona command (persisted in
 *     personasFile, survives restarts and /new clears).
 *   - The owner (config.ownerChatId) uses OWNER_PERSONA (config.ownerPersona).
 *   - Any other chat gets one character, chosen deterministically from its chat
 *     id so the personality is stable for that user across the conversation
 *     (not re-rolled every message).
 *   - "normal" is the no-overlay baseline (the plain coach) and is used as the
 *     fallback when personalities are disabled.
 */
import fs from "node:fs";
import { config } from "../config.js";
import { writeJsonAtomic } from "../util/atomicfile.js";

export interface Personality {
  id: string;
  /** Display name for logs. */
  name: string;
  /** The voice instruction appended to the system prompt. */
  voice: string;
}

/** The plain coach. No overlay text. */
export const NORMAL: Personality = {
  id: "normal",
  name: "Normal coach",
  voice: "",
};

/** Reserved for the owner. */
export const ARNOLD: Personality = {
  id: "arnold",
  name: "Arnold",
  voice:
    "Speak as Arnold Schwarzenegger the bodybuilding-and-Terminator icon: big, " +
    "warm, booming Austrian energy. Call the user things like 'my friend'. Push " +
    "hard and positive ('Come on, one more rep!', 'No pain, no gain', 'Do it " +
    "now!'). Occasional playful Terminator nods ('I'll be back', 'Come with me " +
    "if you want to lift') are welcome but keep them rare. Total belief in the " +
    "user.",
};

/**
 * Famous characters from outside the fitness world. Distinct, recognisable
 * voices; keep them clean and good-natured.
 */
export const CHARACTER_POOL: Personality[] = [
  {
    id: "yoda",
    name: "Yoda",
    voice:
      "Speak as Yoda from Star Wars: inverted, object-subject-verb phrasing " +
      "('Strong today, your squats are'), calm, wise, a little cryptic. Frame " +
      "training as discipline and the Force. 'Do or do not, there is no try.'",
  },
  {
    id: "sherlock",
    name: "Sherlock Holmes",
    voice:
      "Speak as Sherlock Holmes: precise, deductive, faintly superior. Treat " +
      "the user's training data as clues you reason from ('Observe: your bench " +
      "has stalled three weeks running, the deduction is obvious'). Crisp, " +
      "Victorian diction. Call the user 'my dear Watson' on occasion.",
  },
  {
    id: "stark",
    name: "Tony Stark",
    voice:
      "Speak as Tony Stark / Iron Man: quick, cocky, sarcastic, genius energy. " +
      "Tease the user, then back it with sharp, correct advice. Pop-culture " +
      "quips, casual confidence. Never mean, always in their corner.",
  },
  {
    id: "gandalf",
    name: "Gandalf",
    voice:
      "Speak as Gandalf: grand, theatrical, wise wizard cadence. Frame the plan " +
      "as a quest and rest days as gathering strength. 'A session arrives " +
      "precisely when it means to.' Warm gravitas.",
  },
  {
    id: "dwight",
    name: "Dwight Schrute",
    voice:
      "Speak as Dwight Schrute from The Office: intense, literal, self-serious, " +
      "oddly confident, fond of 'Fact:' statements and survivalist analogies. " +
      "Deeply committed to the user's gains as if running a beet farm boot camp.",
  },
  {
    id: "sparrow",
    name: "Captain Jack Sparrow",
    voice:
      "Speak as Captain Jack Sparrow: rambling, roguish, charming, slightly " +
      "tipsy logic that lands on the right point. 'But why is the protein gone?' " +
      "Call training a voyage and the user 'mate'. Savvy?",
  },
  {
    id: "batman",
    name: "Batman",
    voice:
      "Speak as Batman: terse, brooding, low and intense. Short declarative " +
      "lines. Discipline, training in the shadows, no excuses. Rare dry humour. " +
      "'Reps are a tool. Tonight, you use them.'",
  },
];

/** Every selectable persona by id (normal + arnold + the character pool). */
export const PERSONAS: Record<string, Personality> = Object.fromEntries(
  [NORMAL, ARNOLD, ...CHARACTER_POOL].map((p) => [p.id, p]),
);

/** Simple stable hash of a string to a non-negative integer. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** A stable random pick from the character pool, keyed by chat id. */
function randomCharacter(chatId: string): Personality {
  if (CHARACTER_POOL.length === 0) return NORMAL;
  return CHARACTER_POOL[hashString(chatId) % CHARACTER_POOL.length];
}

// ─── Per-chat overrides (the /persona command) ──────────────────────────
// chatId -> persona id ("random" allowed as a sentinel). Persisted so the
// choice survives restarts; independent of conversation state, so /new and
// session expiry never clear it.

const overrides = new Map<string, string>();

function loadOverrides(): void {
  try {
    if (!fs.existsSync(config.personasFile)) return;
    const data = JSON.parse(fs.readFileSync(config.personasFile, "utf-8"));
    for (const [chatId, personaId] of Object.entries(data)) {
      if (typeof personaId === "string" && (PERSONAS[personaId] || personaId === "random")) {
        overrides.set(chatId, personaId);
      }
    }
  } catch (err) {
    console.warn("[personas] Failed to load overrides from disk:", (err as Error).message);
  }
}

function saveOverrides(): void {
  try {
    writeJsonAtomic(config.personasFile, Object.fromEntries(overrides));
  } catch (err) {
    console.warn("[personas] Failed to persist overrides to disk:", (err as Error).message);
  }
}

// Restore overrides on module load
loadOverrides();

/** The stored override id for a chat ("random" possible), or undefined. */
export function getPersonaOverride(chatId: string): string | undefined {
  return overrides.get(chatId);
}

/**
 * Set a chat's persona override. Accepts any built-in or custom id
 * (case-insensitive) or "random". Returns the resolved Personality, or null
 * when unknown (the stored override is left untouched).
 */
export function setPersonaOverride(chatId: string, personaId: string): Personality | null {
  const choice = personaId.trim().toLowerCase();
  const resolved = choice === "random" ? randomCharacter(chatId) : resolvePersona(choice);
  if (!resolved) return null;
  overrides.set(chatId, choice);
  saveOverrides();
  return resolved;
}

/** Drop a chat's override so env defaults apply again. Returns had-override. */
export function clearPersonaOverride(chatId: string): boolean {
  const existed = overrides.delete(chatId);
  if (existed) saveOverrides();
  return existed;
}

// ─── Custom personas (the /create command) ────────────────────────────
// User-written voices in PERSONAS.md (gitignored, personal like PERSONAL.md):
//
//   ## tung-sahur
//   Name: Tung Sahur
//   Voice: <2-4 sentences of voice instruction>
//
// Read fresh on every lookup: a file edited by hand or written by /create
// takes effect on the next message with no restart. Built-ins always win id
// collisions, so a custom section can never hijack e.g. "arnold".

const PERSONA_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Parse PERSONAS.md into id -> Personality. Skips malformed sections. */
export function getCustomPersonas(): Record<string, Personality> {
  const out: Record<string, Personality> = {};
  let text: string;
  try {
    text = fs.readFileSync(config.customPersonasFile, "utf-8");
  } catch {
    return out;
  }
  let id: string | null = null;
  let name = "";
  let voice: string[] = [];
  const flush = () => {
    if (id && PERSONA_ID.test(id) && voice.join(" ").trim()) {
      out[id] = { id, name: name.trim() || id, voice: voice.join(" ").trim() };
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      id = heading[1].trim().toLowerCase();
      name = "";
      voice = [];
      continue;
    }
    if (id === null) continue;
    if (/^name:/i.test(line)) {
      name = line.slice(5);
      continue;
    }
    if (/^voice:/i.test(line)) {
      voice.push(line.slice(6));
      continue;
    }
    if (line) voice.push(line);
  }
  flush();
  return out;
}

/** Built-in first, then custom. Returns undefined when unknown. */
export function resolvePersona(id: string): Personality | undefined {
  const choice = id.trim().toLowerCase();
  return PERSONAS[choice] ?? getCustomPersonas()[choice];
}

/** Every selectable voice, customs flagged. Powers the /persona list. */
export function listPersonas(): Array<Personality & { custom: boolean }> {
  const customs = getCustomPersonas();
  return [
    ...Object.values(PERSONAS).map((p) => ({ ...p, custom: false })),
    ...Object.values(customs)
      .filter((p) => !PERSONAS[p.id])
      .map((p) => ({ ...p, custom: true })),
  ];
}

/**
 * Pick the persona for a chat.
 *
 * A /persona override wins over everything (owner included). Otherwise the
 * owner's persona is set by OWNER_PERSONA (config.ownerPersona): any persona
 * id (e.g. "yoda"), "normal" for the plain coach, or "random" for a stable
 * random character. Defaults to Arnold. Any other chat without an override
 * gets a stable random character.
 */
export function pickPersonality(chatId: string): Personality {
  if (!config.personalitiesEnabled) return NORMAL;

  const override = getPersonaOverride(chatId);
  if (override === "random") return randomCharacter(chatId);
  const resolved = override ? resolvePersona(override) : undefined;
  if (resolved) return resolved;

  const isOwner = config.ownerChatId && chatId === config.ownerChatId;
  if (isOwner) {
    const choice = (config.ownerPersona || "arnold").toLowerCase();
    if (choice === "random") return randomCharacter(chatId);
    return resolvePersona(choice) ?? ARNOLD;
  }

  return randomCharacter(chatId);
}

/** The text to append to the system prompt, or "" for the normal coach. */
export function personaSystemPrompt(p: Personality): string {
  if (!p.voice) return "";
  return [
    "## Persona overlay",
    "",
    `For this conversation, take on the personality and voice of ${p.name}.`,
    p.voice,
    "",
    "This overlay changes only your tone, phrasing, and flavour. Every piece of " +
      "coaching judgement, training and nutrition knowledge, tool use, and the " +
      "safety rules above stay exactly the same. Stay in character, but never let " +
      "the bit make your advice wrong, unsafe, or confusing. If the user asks you " +
      "to drop the character, do so.",
    "",
    "Voice break: earlier messages in this conversation may carry a different " +
      "voice from a previous setting. Do not inherit their tone, catchphrases, " +
      "or mannerisms. This section alone decides how you sound now.",
  ].join("\n");
}
