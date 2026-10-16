import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectPublication } from "./check-publication.mjs";

function repository(t, email = "tester@users.noreply.github.com") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Test Maintainer");
  git("config", "user.email", email);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\ndata/\n");
  fs.writeFileSync(path.join(root, "README.md"), "Public example\n");
  git("add", ".gitignore", "README.md");
  git("commit", "-qm", "Public fixture");
  return { root, git };
}

test("public files and noreply history pass; private untracked files stay excluded", (t) => {
  const { root } = repository(t);
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE=test-only\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "USER node\nWORKDIR /home/node\n");
  assert.deepEqual(inspectPublication(root).problems, []);
  assert.ok(!inspectPublication(root).files.includes(".env"));
});

test("force-added private files block publication without revealing values", (t) => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE=do-not-print-this\n");
  git("add", "-f", ".env");
  const result = inspectPublication(root);
  assert.ok(result.problems.some((message) => message.includes(".env")));
  assert.ok(result.problems.every((message) => !message.includes("do-not-print-this")));
});

test("personal author metadata blocks publication without printing email", (t) => {
  const { root } = repository(t, "private-person@example.org");
  const result = inspectPublication(root);
  assert.ok(result.problems.some((message) => message.includes("author/committer")));
  assert.ok(result.problems.every((message) => !message.includes("private-person@example.org")));
});

test("new public candidates with personal machine paths are caught", (t) => {
  const { root } = repository(t);
  fs.writeFileSync(
    path.join(root, "metadata.json"),
    JSON.stringify({ source: ["C:", "Users", "PrivateName", "image.png"].join("/") }),
  );
  assert.ok(inspectPublication(root).problems.some((message) => message.includes("metadata.json")));
});

test("pre-push guard rejects unaudited internal refs before scanning or uploading", (t) => {
  const { root, git } = repository(t);
  const execPath = git("--exec-path").toString().trim();
  const shell =
    process.platform === "win32" ? path.resolve(execPath, "..", "..", "..", "bin", "sh.exe") : "sh";
  const hook = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));
  const sha = git("rev-parse", "HEAD").toString().trim();
  const result = spawnSync(shell, [hook], {
    cwd: root,
    input: `refs/codex/private ${sha} refs/heads/published ${"0".repeat(40)}\n`,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /current audited branch/);
});
