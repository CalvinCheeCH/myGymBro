import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-tooling-"));
for (const file of [
  "README.md",
  "docs/alias.md",
  "knowledge/program.txt",
  "data/report-card.png",
]) {
  const target = path.join(workspace, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "synthetic security fixture");
}
fs.mkdirSync(path.join(workspace, "knowledge/processed"));
fs.mkdirSync(path.join(workspace, "knowledge/linked"));
fs.mkdirSync(path.join(workspace, "data/report-cards"));
fs.mkdirSync(path.join(workspace, "data/linked"));

let executions = [];
let scriptError;
mock.module("node:child_process", {
  namedExports: {
    execFile: (_file, args, _options, callback) => {
      executions.push(args);
      callback(scriptError, "synthetic output; no subprocess started", "");
    },
  },
});
mock.module("node:url", {
  namedExports: {
    fileURLToPath: (url) =>
      String(url).endsWith("/dist/agent/tooling.js")
        ? path.join(workspace, "dist/agent/tooling.js")
        : fileURLToPath(url),
  },
});
const { executeCoachTool, PROJECT_ROOT } = await import("../dist/agent/tooling.js");
assert.equal(PROJECT_ROOT, workspace);

beforeEach(() => {
  executions = [];
  scriptError = undefined;
});
after(() => {
  assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()));
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("duplicate file, output and recipient flags never reach a helper", async () => {
  for (const [script, args] of [
    ["notion.mjs", ["append", "--file", "README.md", "--file", "../private-canary"]],
    ["notion.mjs", ["create", "--body-file", "README.md", "--body-file", ".env"]],
    ["report-card.mjs", ["--out", "data/report.png", "--out", "../private-canary"]],
    ["send-photo.mjs", ["--chat", "42", "--chat", "99", "--file", "data/report.png"]],
  ]) {
    const result = await executeCoachTool("run_script", { script, args }, "42");
    assert.match(result.error, /Duplicate --/);
  }
  assert.equal(executions.length, 0);
});

test("approved reads, repeated Notion properties and generated image paths still work", async () => {
  const read = await executeCoachTool("read_file", { path: "README.md" }, "42");
  assert.equal(read.content, "synthetic security fixture");
  for (const [script, args] of [
    [
      "notion.mjs",
      ["create", "--set", "Name=Squat", "--set", "Reps=5", "--body-file", "README.md"],
    ],
    ["report-card.mjs", ["--out", "data/report.png"]],
    ["send-photo.mjs", ["--chat", "42", "--file", "data/report.png"]],
  ]) {
    const result = await executeCoachTool("run_script", { script, args }, "42");
    assert.equal(typeof result.output, "string");
  }
  assert.equal(executions.length, 3);
});

test("weekly plans and nutrition sync use the approved helper and keep its private-file boundary", async () => {
  for (const args of [
    ["weekly-plan", "--action", "show", "--week", "2026-10-11"],
    ["weekly-plan", "--action", "save", "--week", "2026-10-11", "--md", "Synthetic weekly plan"],
    ["weekly-plan", "--action", "save", "--week", "2026-10-11", "--file", "README.md"],
    ["sync-nutrition"],
  ]) {
    const result = await executeCoachTool("run_script", { script: "notion.mjs", args }, "42");
    assert.equal(typeof result.output, "string");
  }
  assert.equal(executions.length, 4);
  for (const file of [".env", "data/report-card.png", "../private-canary"]) {
    const result = await executeCoachTool(
      "run_script",
      { script: "notion.mjs", args: ["weekly-plan", "--action", "save", "--file", file] },
      "42",
    );
    assert.equal(typeof result.error, "string");
  }
  assert.equal(executions.length, 4);
});

test("dashboard refresh preserves helper failure status for the reset completion notice", async () => {
  const request = { script: "notion.mjs", args: ["sync-dashboard"] };
  const success = await executeCoachTool("run_script", request, "42");
  assert.equal(success.error, undefined);
  assert.equal(success.exitCode, undefined);
  scriptError = Object.assign(new Error("synthetic Notion failure"), { code: 1 });
  const failure = await executeCoachTool("run_script", request, "42");
  assert.equal(failure.exitCode, 1);
  assert.equal(executions.length, 2);
});

test("credential and infrastructure secret files are unavailable inside readable directories", async () => {
  for (const secretPath of [
    "infra/azure/main.parameters.json",
    "infra/gcp/terraform.tfvars",
    "infra/gcp/terraform.tfvars.json",
    "infra/gcp/terraform.tfstate.backup",
    "infra/gcp/.terraform/state.json",
    "infra/gcp/.TERRAFORM/state.json",
    "knowledge/credentials.json",
    "knowledge/client_secret_example.json",
    "docs/google-token.json",
    "docs/token.json",
    "docs/tokens.json",
    "docs/credentials.tfrc.json",
    "docs/.terraformrc",
    "docs/private.key",
    "docs/private.pem",
    "docs/private.p12",
    "docs/private.pfx",
  ]) {
    const read = await executeCoachTool("read_file", { path: secretPath }, "42");
    assert.match(read.error, /Only non-secret files/);
  }
});

test("an alias cannot expose a blocked file or route a new write into a blocked directory", async () => {
  const realpath = fs.realpathSync;
  const redirected = mock.method(fs, "realpathSync", (target) => {
    if (target === path.join(workspace, "docs/alias.md")) return path.join(workspace, ".env");
    if (target === path.join(workspace, "knowledge/linked")) return path.join(workspace, "scripts");
    if (target === path.join(workspace, "knowledge/program.txt")) {
      return path.join(workspace, "scripts/notion.mjs");
    }
    return realpath(target);
  });
  try {
    const read = await executeCoachTool("read_file", { path: "docs/alias.md" }, "42");
    assert.match(read.error, /Path resolves outside/);
    const write = await executeCoachTool(
      "write_file",
      { path: "knowledge/linked/new.md", content: "synthetic" },
      "42",
    );
    assert.match(write.error, /Path resolves outside/);
    assert.equal(fs.existsSync(path.join(workspace, "knowledge/linked/new.md")), false);
    const overwrite = await executeCoachTool(
      "write_file",
      { path: "knowledge/program.txt", content: "cannot replace trusted helpers" },
      "42",
    );
    assert.match(overwrite.error, /Path resolves outside/);
    assert.equal(
      fs.readFileSync(path.join(workspace, "knowledge/program.txt"), "utf8"),
      "synthetic security fixture",
    );
  } finally {
    redirected.mock.restore();
  }
});

test("read aliases must remain in readable domains", async () => {
  const realpath = fs.realpathSync;
  const redirected = mock.method(fs, "realpathSync", (target) =>
    target === path.join(workspace, "docs/alias.md")
      ? path.join(workspace, "config/notion-hub.json")
      : realpath(target),
  );
  try {
    const result = await executeCoachTool("read_file", { path: "docs/alias.md" }, "42");
    assert.match(result.error, /Path resolves outside/);
  } finally {
    redirected.mock.restore();
  }
});

test("report and photo aliases cannot escape data, including report defaults and archive directories", async () => {
  const realpath = fs.realpathSync;
  let redirectedPath = path.join(workspace, "data/report-card.png");
  const redirected = mock.method(fs, "realpathSync", (target) =>
    target === redirectedPath ? path.join(workspace, "scripts/notion.mjs") : realpath(target),
  );
  try {
    for (const [script, args] of [
      ["report-card.mjs", []],
      ["report-card.mjs", ["--out", "data/report-card.png"]],
      ["send-photo.mjs", ["--chat", "42", "--file", "data/report-card.png"]],
    ]) {
      const result = await executeCoachTool("run_script", { script, args }, "42");
      assert.match(result.error, /Path resolves outside/);
    }
    for (const alias of ["data/report-cards", "data/linked"]) {
      redirectedPath = path.join(workspace, alias);
      const result = await executeCoachTool(
        "run_script",
        { script: "report-card.mjs", args: ["--out", "data/linked/new.png"] },
        "42",
      );
      assert.match(result.error, /Path resolves outside/);
    }
    assert.equal(executions.length, 0);
  } finally {
    redirected.mock.restore();
  }
});

test("dangling links cannot create outside files, while the container profile link remains writable", async () => {
  const profile = path.join(workspace, "PERSONAL.md");
  const danglingFile = path.join(workspace, "knowledge/dangling.md");
  const danglingDirectory = path.join(workspace, "knowledge/dangling-directory");
  const lstat = fs.lstatSync;
  const readlink = fs.readlinkSync;
  const fakeLinks = new Map([
    [danglingFile, path.join(path.dirname(workspace), "outside-coach-canary.md")],
    [danglingDirectory, path.join(path.dirname(workspace), "outside-coach-canary-dir")],
    [profile, path.resolve(path.parse(workspace).root, "data", "PERSONAL.md")],
  ]);
  const statMock = mock.method(fs, "lstatSync", (target, options) =>
    fakeLinks.has(target) ? { isSymbolicLink: () => true } : lstat(target, options),
  );
  const linkMock = mock.method(
    fs,
    "readlinkSync",
    (target) => fakeLinks.get(target) ?? readlink(target),
  );
  try {
    for (const target of ["knowledge/dangling.md", "knowledge/dangling-directory/new.md"]) {
      const result = await executeCoachTool(
        "write_file",
        { path: target, content: "synthetic" },
        "42",
      );
      assert.match(result.error, /Path resolves outside/);
      assert.equal(fs.existsSync(path.join(workspace, target)), false);
    }
    const result = await executeCoachTool(
      "write_file",
      { path: "PERSONAL.md", content: "synthetic profile" },
      "42",
    );
    assert.equal(typeof result.output, "string");
    assert.equal(fs.readFileSync(profile, "utf8"), "synthetic profile");
  } finally {
    statMock.mock.restore();
    linkMock.mock.restore();
  }
});

test("knowledge imports validate their destination before moving a file", async () => {
  const realpath = fs.realpathSync;
  const redirected = mock.method(fs, "realpathSync", (target) =>
    target === path.join(workspace, "knowledge/processed")
      ? path.join(path.dirname(workspace), "outside-coach-canary")
      : realpath(target),
  );
  try {
    const result = await executeCoachTool("move_knowledge", { filename: "program.txt" }, "42");
    assert.match(result.error, /Path resolves outside/);
    assert.equal(fs.existsSync(path.join(workspace, "knowledge/program.txt")), true);
    assert.equal(fs.existsSync(path.join(workspace, "knowledge/processed/program.txt")), false);
  } finally {
    redirected.mock.restore();
  }
  const write = await executeCoachTool(
    "write_file",
    { path: "knowledge/processed", content: "cannot replace the import directory" },
    "42",
  );
  assert.match(write.error, /Only PERSONAL/);
  const moved = await executeCoachTool("move_knowledge", { filename: "program.txt" }, "42");
  assert.equal(typeof moved.output, "string");
  assert.equal(fs.existsSync(path.join(workspace, "knowledge/processed/program.txt")), true);
});
