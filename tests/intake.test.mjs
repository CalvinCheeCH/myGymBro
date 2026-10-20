import assert from "node:assert/strict";
import { test } from "node:test";

let instance = 0;
const loadIntake = () => import(`../dist/channel/intake.js?instance=${++instance}`);
const settle = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("same-chat preparation stays ordered and release admits the next update before work finishes", async () => {
  const { withChatIntake, releaseChatIntake } = await loadIntake();
  const preparation = deferred();
  const model = deferred();
  const order = [];
  const first = withChatIntake("42", async () => {
    order.push("first preparing");
    await preparation.promise;
    order.push("first admitted");
    releaseChatIntake();
    await model.promise;
    order.push("first finished");
    return "first result";
  });
  const second = withChatIntake("42", async () => {
    order.push("second preparing");
    releaseChatIntake();
    return "second result";
  });
  await settle();
  assert.deepEqual(order, ["first preparing"]);
  preparation.resolve();
  assert.equal(await second, "second result");
  assert.deepEqual(order, ["first preparing", "first admitted", "second preparing"]);
  model.resolve();
  assert.equal(await first, "first result");
  assert.equal(order.at(-1), "first finished");
});

test("one chat's preparation does not block another chat", async () => {
  const { withChatIntake } = await loadIntake();
  const wait = deferred();
  const order = [];
  const first = withChatIntake("first", async () => {
    order.push("first");
    await wait.promise;
  });
  await withChatIntake("second", async () => order.push("second"));
  assert.deepEqual(order, ["first", "second"]);
  wait.resolve();
  await first;
});

test("normal completion releases intake when no explicit admission release was needed", async () => {
  const { withChatIntake } = await loadIntake();
  const wait = deferred();
  const order = [];
  const first = withChatIntake("42", async () => {
    order.push("first");
    await wait.promise;
    return "done";
  });
  const second = withChatIntake("42", async () => order.push("second"));
  await settle();
  assert.deepEqual(order, ["first"]);
  wait.resolve();
  assert.equal(await first, "done");
  await second;
  assert.deepEqual(order, ["first", "second"]);
  await withChatIntake("42", async () => order.push("third"));
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("failed preparation releases the next update and still rejects its caller", async () => {
  const { withChatIntake } = await loadIntake();
  const wait = deferred();
  const first = withChatIntake("42", async () => {
    await wait.promise;
    throw new Error("expected preparation failure");
  });
  const rejected = assert.rejects(first, /expected preparation failure/);
  const second = withChatIntake("42", async () => "next");
  wait.resolve();
  await rejected;
  assert.equal(await second, "next");
});

test("synchronous exceptions release the admission gate", async () => {
  const { withChatIntake } = await loadIntake();
  const first = withChatIntake("42", () => {
    throw new Error("expected sync failure");
  });
  await assert.rejects(first, /expected sync failure/);
  assert.equal(await withChatIntake("42", async () => "next"), "next");
});

test("an older task's repeated release and finally cannot unlock a newer task", async () => {
  const { withChatIntake, releaseChatIntake } = await loadIntake();
  const oldRun = deferred();
  const secondAdmission = deferred();
  const order = [];
  const first = withChatIntake("42", async () => {
    releaseChatIntake();
    await oldRun.promise;
    releaseChatIntake();
    order.push("first finished");
  });
  const second = withChatIntake("42", async () => {
    order.push("second preparing");
    await secondAdmission.promise;
    releaseChatIntake();
    order.push("second admitted");
  });
  const third = withChatIntake("42", async () => order.push("third preparing"));
  await settle();
  assert.deepEqual(order, ["second preparing"]);
  oldRun.resolve();
  await first;
  await settle();
  assert.deepEqual(order, ["second preparing", "first finished"]);
  secondAdmission.resolve();
  await Promise.all([second, third]);
  assert.deepEqual(order, [
    "second preparing",
    "first finished",
    "second admitted",
    "third preparing",
  ]);
});

test("release outside an intake context does not release another task's gate", async () => {
  const { withChatIntake, releaseChatIntake } = await loadIntake();
  const wait = deferred();
  const first = withChatIntake("42", async () => wait.promise);
  let started = false;
  const second = withChatIntake("42", async () => {
    started = true;
  });
  await settle();
  releaseChatIntake();
  await settle();
  assert.equal(started, false);
  wait.resolve();
  await Promise.all([first, second]);
  assert.equal(started, true);
});
