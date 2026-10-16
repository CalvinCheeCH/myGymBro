import assert from "node:assert/strict";
import { test } from "node:test";

// runner.js transitively loads config, which requires TELEGRAM_BOT_TOKEN at
// import time, so provide a dummy before importing and pull classifyQuery in
// dynamically (after the env is set).
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
const {
  applyRapidMessage,
  classifyQuery,
  emptyRapidLedger,
  extractExerciseName,
  isAmendment,
  isCorrectionConfirm,
  isRapidFireLog,
  isSessionFinal,
  renderRapidLedger,
} = await import("../dist/agent/runner.js");
const { isMealLog } = await import("../dist/agent/classify.js");

test("short transactional log lines route to the fast tier", () => {
  assert.equal(classifyQuery("did 5x5 squats at 80kg"), "fast");
  assert.equal(classifyQuery("logged bench 3x8 60kg"), "fast");
});

test("meal logs stay fast even though they mention food nouns", () => {
  assert.equal(classifyQuery("log meal prep chicken rice"), "fast");
  assert.equal(classifyQuery("just ate nasi lemak"), "fast");
  assert.equal(classifyQuery("dinner 800 cal"), "fast");
  assert.equal(classifyQuery("breakfast roti canai telur"), "fast");
});

test("first-person meal logs and named eating occasions stay fast without becoming workout logs", () => {
  for (const message of [
    "i ate overnight oats",
    "I had breakfast",
    "I just had a sandwich",
    "I drank milk",
    "my lunch: rice and chicken",
    "lunch was a sandwich",
    "finished dinner",
    "completed lunch",
    "logged meal",
    "done with dinner",
  ]) {
    assert.equal(isMealLog(message), true, message);
    assert.equal(classifyQuery(message), "fast", message);
  }
});

test("meal questions and workout completion retain their existing routes", () => {
  for (const message of [
    "I ate oats, should I add protein?",
    "I had lunch but my stomach is in pain",
    "lunch ideas for cutting",
    "finished dinner, what should I eat tomorrow?",
    "I ate overnight oats is that enough",
    "I had lunch can I work out now",
  ]) {
    assert.equal(isMealLog(message), false, message);
    assert.equal(classifyQuery(message), "standard", message);
  }
  for (const message of ["done", "finished bench 60x12", "logged squats 80kg 5x5"]) {
    assert.equal(isMealLog(message), false, message);
    assert.equal(classifyQuery(message), "fast", message);
  }
});

test("bare set notation routes fast for rapid-fire logging", () => {
  assert.equal(classifyQuery("db bench 60x12"), "fast");
  assert.equal(classifyQuery("12x10"), "fast");
  assert.equal(classifyQuery("35x14, 35x12"), "fast");
});

test("session-end keywords route fast (single write happens on the light chain)", () => {
  assert.equal(classifyQuery("done"), "fast");
  assert.equal(classifyQuery("settle"), "fast");
  assert.equal(classifyQuery("selesai"), "fast");
});

test("coaching and advice questions stay on the standard tier", () => {
  assert.equal(classifyQuery("what should I train today?"), "standard");
  assert.equal(classifyQuery("plan my week"), "standard");
  assert.equal(classifyQuery("my knee is in pain"), "standard");
});

test("a log-shaped message that mentions a coaching topic stays standard", () => {
  // "did" prefix, but "progress" pulls it back to standard (conservative default).
  assert.equal(classifyQuery("did my progress improve this month?"), "standard");
});

test("log-shaped questions stay standard via the question override", () => {
  assert.equal(classifyQuery("dinner ideas for cutting?"), "standard");
  assert.equal(classifyQuery("ate burger, should i feel bad?"), "standard");
  assert.equal(classifyQuery("what does 5x5 mean"), "standard");
  assert.equal(classifyQuery("log my workout plan for next week"), "standard");
});

test("anything unrecognised defaults to standard", () => {
  assert.equal(classifyQuery("hey coach"), "standard");
});

test("isSessionFinal: exact keywords, loose burials, negation guard", () => {
  assert.equal(isSessionFinal("done"), true);
  assert.equal(isSessionFinal("Settle"), true);
  assert.equal(isSessionFinal("selesai"), true);
  assert.equal(isSessionFinal("Yup that's the end, done"), true);
  assert.equal(isSessionFinal("The end"), true);
  assert.equal(isSessionFinal("not done yet"), false);
  assert.equal(isSessionFinal("done, one more set"), false);
  assert.equal(isSessionFinal("done 3x10 bench"), true);
  assert.equal(isSessionFinal("bench 60x12"), false);
});

test("isRapidFireLog: workout sets only, meals excluded", () => {
  assert.equal(isRapidFireLog("Db benchpress 10x12"), true);
  assert.equal(isRapidFireLog("12x12,12x12"), true);
  assert.equal(isRapidFireLog("did squats 80kg 5x5"), true);
  assert.equal(isRapidFireLog("ate nasi lemak"), false);
  assert.equal(isRapidFireLog("log nasi lemak"), false);
  assert.equal(isRapidFireLog("breakfast roti canai"), false);
  assert.equal(isRapidFireLog("bench 60x12?"), false);
  assert.equal(isRapidFireLog("done"), false);
});

test("typo corrections stay on the rapid path", () => {
  assert.equal(classifyQuery("15x12*"), "fast");
  assert.equal(isRapidFireLog("15x12*"), true);
  assert.equal(classifyQuery("sorry it should be 15x12"), "fast");
  assert.equal(isRapidFireLog("sorry it should be 15x12"), true);
  assert.equal(isSessionFinal("sorry it should be 15x12"), false);
});

test("isCorrectionConfirm: only explicit fix confirmations get delivered", () => {
  assert.equal(isCorrectionConfirm("Fixed: DB press now 15x12, was 15x1."), true);
  assert.equal(isCorrectionConfirm("Corrected: roti canai, not roti telur."), true);
  assert.equal(isCorrectionConfirm("Updated: protein 28g, was 22g."), true);
  assert.equal(isCorrectionConfirm("Noted."), false);
  assert.equal(isCorrectionConfirm("Got it."), false);
  assert.equal(isCorrectionConfirm("Set logged."), false);
  assert.equal(isCorrectionConfirm("I fixed the dashboard tile too"), false);
  assert.equal(isCorrectionConfirm("Sorry, what weight was that?"), false);
});

test("isAmendment: star suffix and apology phrasing, nothing else", () => {
  assert.equal(isAmendment("15x12*"), true);
  assert.equal(isAmendment("15x12 * "), true);
  assert.equal(isAmendment("sorry it should be 15x12"), true);
  assert.equal(isAmendment("Sry should be 5x9"), true);
  assert.equal(isAmendment("my bad, that was 14kg"), true);
  assert.equal(isAmendment("35x12"), false);
  assert.equal(isAmendment("db press 15x12"), false);
  assert.equal(isAmendment("done"), false);
});

test("extractExerciseName: names survive, filler does not", () => {
  assert.equal(extractExerciseName("Db press 15x1"), "Db press");
  assert.equal(extractExerciseName("Bicep curls 5x10"), "Bicep curls");
  assert.equal(extractExerciseName("12x10"), null);
  assert.equal(extractExerciseName("Sry should be 5x9"), null);
  assert.equal(extractExerciseName("did squats 80kg 5x5"), "squats");
});

test("applyRapidMessage: appends, inherits exercise, amends in place", () => {
  let l = emptyRapidLedger();
  let r = applyRapidMessage(l, "Bicep curls 5x10");
  assert.equal(r.amended, false);
  assert.equal(r.ledger.entries.length, 1);
  assert.equal(r.ledger.currentExercise, "Bicep curls");
  l = r.ledger;
  r = applyRapidMessage(l, "5x1");
  assert.equal(r.amended, false);
  assert.equal(r.ledger.entries.length, 2);
  assert.equal(r.ledger.entries[1].exercise, "Bicep curls");
  l = r.ledger;
  r = applyRapidMessage(l, "5x12*");
  assert.equal(r.amended, true);
  assert.equal(r.ledger.entries.length, 2);
  assert.deepEqual(
    r.ledger.entries.map((e) => e.raw),
    ["Bicep curls 5x10", "5x12"],
  );
  l = r.ledger;
  r = applyRapidMessage(l, "Sry should be 5x9");
  assert.equal(r.amended, true);
  assert.equal(r.ledger.entries.length, 2);
  assert.equal(r.ledger.entries[1].raw, "Sry should be 5x9");
});

test("applyRapidMessage: amend on empty ledger degrades to push, names switch exercise", () => {
  let r = applyRapidMessage(emptyRapidLedger(), "15x12*");
  assert.equal(r.amended, false);
  assert.equal(r.ledger.entries.length, 1);
  r = applyRapidMessage(r.ledger, "Lat pulldown 23x12");
  assert.equal(r.ledger.currentExercise, "Lat pulldown");
  assert.equal(r.ledger.entries[1].exercise, "Lat pulldown");
  r = applyRapidMessage(r.ledger, "did bench 60x8");
  assert.equal(r.ledger.currentExercise, "bench");
});

test("renderRapidLedger: grouped authoritative block", () => {
  let l = emptyRapidLedger();
  l = applyRapidMessage(l, "Bicep curls 5x10").ledger;
  l = applyRapidMessage(l, "5x12").ledger;
  const out = renderRapidLedger(l);
  assert.match(out, /### Bicep curls/);
  assert.match(out, /- Bicep curls 5x10/);
  assert.match(out, /Do NOT re-derive/);
});
