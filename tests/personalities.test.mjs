import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

// personalities.js reads its override file path from config at import time,
// so config is mocked with getters and a fresh module instance is loaded per
// test (via a cache-busting query).
// Requires --experimental-test-module-mocks (set on the npm test script).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-personas-"));

let personasFile = path.join(TMP_DIR, "personas.json");
let customPersonasFile = path.join(TMP_DIR, "PERSONAS.md");
let personalitiesEnabled = true;
let ownerChatId = "owner-1";
let ownerPersona = "arnold";

mock.module("../dist/config.js", {
  namedExports: {
    config: {
      get personasFile() {
        return personasFile;
      },
      get customPersonasFile() {
        return customPersonasFile;
      },
      get personalitiesEnabled() {
        return personalitiesEnabled;
      },
      get ownerChatId() {
        return ownerChatId;
      },
      get ownerPersona() {
        return ownerPersona;
      },
    },
  },
});

let instance = 0;
async function loadPersonas(opts = {}) {
  personasFile = path.join(TMP_DIR, `personas-${++instance}.json`);
  customPersonasFile = path.join(TMP_DIR, `PERSONAS-${instance}.md`);
  personalitiesEnabled = opts.enabled ?? true;
  ownerChatId = opts.owner ?? "owner-1";
  ownerPersona = opts.ownerPersona ?? "arnold";
  if (opts.seed) fs.writeFileSync(personasFile, JSON.stringify(opts.seed));
  if (opts.corrupt) fs.writeFileSync(personasFile, "{not json");
  return import(`../dist/agent/personalities.js?instance=${instance}`);
}

test("owner defaults to Arnold with no override", async () => {
  const personas = await loadPersonas();

  assert.equal(personas.pickPersonality("owner-1").id, "arnold");
  assert.equal(personas.getPersonaOverride("owner-1"), undefined);
});

test("setPersonaOverride wins over the env default, case-insensitively", async () => {
  const personas = await loadPersonas();

  const p = personas.setPersonaOverride("owner-1", "YODA");
  assert.equal(p.id, "yoda");
  assert.equal(personas.pickPersonality("owner-1").id, "yoda");
  assert.equal(personas.getPersonaOverride("owner-1"), "yoda");
});

test("setPersonaOverride rejects unknown ids without touching the store", async () => {
  const personas = await loadPersonas();

  assert.equal(personas.setPersonaOverride("owner-1", "goku"), null);
  assert.equal(personas.getPersonaOverride("owner-1"), undefined);
  assert.equal(personas.pickPersonality("owner-1").id, "arnold");
  assert.equal(fs.existsSync(personasFile), false);
});

test("overrides persist across module reloads", async () => {
  const first = await loadPersonas();
  first.setPersonaOverride("owner-1", "batman");

  personasFile = path.join(TMP_DIR, `personas-${instance}.json`);
  const second = await import(`../dist/agent/personalities.js?instance=${instance}-reload`);
  assert.equal(second.pickPersonality("owner-1").id, "batman");
});

test("clearPersonaOverride restores the default and reports", async () => {
  const personas = await loadPersonas();
  personas.setPersonaOverride("owner-1", "sherlock");

  assert.equal(personas.clearPersonaOverride("owner-1"), true);
  assert.equal(personas.pickPersonality("owner-1").id, "arnold");
  assert.equal(personas.clearPersonaOverride("owner-1"), false);
});

test("a corrupt personas file loads as empty instead of throwing", async () => {
  const personas = await loadPersonas({ corrupt: true });

  assert.equal(personas.pickPersonality("owner-1").id, "arnold");
});

test("disabled personalities always return the plain coach", async () => {
  const personas = await loadPersonas({ enabled: false });
  personas.setPersonaOverride("owner-1", "stark");

  assert.equal(personas.pickPersonality("owner-1").id, "normal");
});

test("custom voices resolve, switch, and list with a custom flag", async () => {
  const personas = await loadPersonas();
  fs.writeFileSync(
    customPersonasFile,
    "# Custom voices\n\n## tung-sahur\nName: Tung Sahur\nVoice: Speak Italian brainrot: rapid rhymes, absurd confidence.\n",
  );

  assert.deepEqual(Object.keys(personas.getCustomPersonas()), ["tung-sahur"]);
  const p = personas.setPersonaOverride("owner-1", "TUNG-SAHUR");
  assert.equal(p.id, "tung-sahur");
  assert.equal(personas.pickPersonality("owner-1").id, "tung-sahur");
  const listed = personas.listPersonas().find((x) => x.id === "tung-sahur");
  assert.equal(listed.custom, true);
  assert.equal(listed.name, "Tung Sahur");
});

test("built-ins win id collisions with custom sections", async () => {
  const personas = await loadPersonas();
  fs.writeFileSync(customPersonasFile, "## arnold\nName: Fake Arnold\nVoice: Be quiet.\n");

  personas.setPersonaOverride("owner-1", "arnold");
  assert.equal(personas.pickPersonality("owner-1").name, "Arnold");
});

test("malformed custom sections are skipped, missing file is empty", async () => {
  const personas = await loadPersonas();
  fs.writeFileSync(
    customPersonasFile,
    "## Bad Id Here!\nName: Nope\nVoice: Never loads.\n\n## novoice\nName: Silent\n",
  );

  assert.deepEqual(personas.getCustomPersonas(), {});
  assert.equal(personas.setPersonaOverride("owner-1", "novoice"), null);
});

test("persona overlay names the voice and breaks from history", async () => {
  const personas = await loadPersonas();

  const overlay = personas.personaSystemPrompt(personas.PERSONAS.batman);
  assert.match(overlay, /Batman/);
  assert.match(overlay, /Voice break/);
  assert.equal(personas.personaSystemPrompt(personas.NORMAL), "");
});
