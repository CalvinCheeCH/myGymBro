import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function git(root, args, input, allowNoMatch = false) {
  const result = spawnSync("git", args, {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || (result.status !== 0 && !(allowNoMatch && result.status === 1))) {
    throw new Error("Git publication inspection failed; nothing was published.");
  }
  return result.stdout;
}

export function inspectPublication(root = process.cwd()) {
  const files = [
    ...new Set(git(root, ["ls-files", "-c", "-o", "--exclude-standard", "-z"]).split("\0")),
  ].filter(Boolean);
  const ignored = git(
    root,
    ["check-ignore", "--no-index", "-z", "--stdin"],
    `${files.join("\0")}\0`,
    true,
  )
    .split("\0")
    .filter(Boolean);
  const problems = ignored.map((file) => `Private/ignored file is tracked: ${file}`);
  const safeFiles = [];
  for (const file of files) {
    if (ignored.includes(file)) continue;
    const target = path.join(root, file);
    if (!fs.existsSync(target)) {
      try {
        if (fs.lstatSync(target).isSymbolicLink())
          problems.push(`Broken symlink cannot be published: ${file}`);
      } catch {}
      continue;
    }
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
    if (
      fs.lstatSync(target).isSymbolicLink() ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      problems.push(`Symlink or outside-workspace file cannot be published: ${file}`);
      continue;
    }
    safeFiles.push(file);
    if (
      [
        ...fs
          .readFileSync(target, "utf8")
          .matchAll(/(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)([^\s<>"'\\/]+)/g),
      ].some((match) => match[1] !== "node")
    ) {
      problems.push(`Personal machine path found: ${file}`);
    }
  }
  const metadata = git(root, ["log", "HEAD", "--format=%h%x09%ae%x09%ce"]);
  for (const line of metadata.trim().split("\n").filter(Boolean)) {
    const [commit, ...emails] = line.split("\t");
    if (
      emails.some(
        (email) => !/^(?:[^@]+@users\.noreply\.github\.com|noreply@github\.com)$/i.test(email),
      )
    ) {
      problems.push(
        `Commit ${commit} contains an author/committer email outside GitHub noreply addresses.`,
      );
    }
  }
  return { files: safeFiles, problems };
}

export function checkPublication(root = process.cwd()) {
  const inspection = inspectPublication(root);
  const scanner =
    process.platform === "win32" &&
    fs.existsSync(path.join(root, "data/security-tools/gitleaks.exe"))
      ? path.join(root, "data/security-tools/gitleaks.exe")
      : "gitleaks";
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "mygymbro-publication-"));
  try {
    for (const file of inspection.files) {
      const destination = path.join(snapshot, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, file), destination);
    }
    for (const args of [
      [
        "git",
        "--log-opts=HEAD",
        "--config",
        path.join(root, ".gitleaks.toml"),
        "--redact=100",
        "--no-banner",
        root,
      ],
      [
        "dir",
        "--config",
        path.join(root, ".gitleaks.toml"),
        "--redact=100",
        "--no-banner",
        snapshot,
      ],
    ]) {
      const result = spawnSync(scanner, args, { cwd: root, stdio: "inherit", windowsHide: true });
      if (result.error || result.status !== 0) {
        inspection.problems.push(
          "Gitleaks scan failed or is unavailable. Install the official scanner; never bypass this check.",
        );
      }
    }
  } finally {
    if (path.dirname(snapshot) === path.resolve(os.tmpdir())) {
      fs.rmSync(snapshot, { recursive: true, force: true });
    } else {
      inspection.problems.push("Unsafe temporary cleanup path; publication stopped.");
    }
  }
  for (const problem of inspection.problems) console.error(`[publication blocked] ${problem}`);
  if (!inspection.problems.length)
    console.log(
      `Publication checks passed for ${inspection.files.length} candidate files and HEAD history.`,
    );
  return inspection.problems.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!checkPublication()) process.exitCode = 1;
  } catch {
    console.error("Publication inspection failed. Nothing was published.");
    process.exitCode = 1;
  }
}
