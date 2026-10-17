import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";

const script = fs.readFileSync(new URL("../scripts/deploy-cloudrun.sh", import.meta.url), "utf8");
const gitBash = "C:/Program Files/Git/bin/bash.exe";
const bash = process.platform === "win32" && fs.existsSync(gitBash) ? gitBash : "bash";

function variables(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return Object.fromEntries(
    args[index + 1].split(",").map((entry) => {
      const equals = entry.indexOf("=");
      return [entry.slice(0, equals), entry.slice(equals + 1)];
    }),
  );
}

test("Cloud Run bootstrap keeps configuration when switching to webhook mode", () => {
  const result = spawnSync(
    bash,
    [
      "--noprofile",
      "--norc",
      "-c",
      `gcloud() {
        printf 'GCLOUD' >&2
        printf '\\t%s' "$@" >&2
        printf '\\n' >&2
        case "$1 $2 $3" in
          "builds submit --tag"|"run deploy fitcoach-agent"|"run services update"|"scheduler jobs create") ;;
          "run services describe") printf '%s' 'https://synthetic-service.example' ;;
          "secrets versions access") printf '%s' 'synthetic-cron-secret' ;;
          *) return 99 ;;
        esac
      }
${script}`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const calls = result.stderr
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("\t").slice(1));
  const deployIndex = calls.findIndex(([first, second]) => first === "run" && second === "deploy");
  const describeIndex = calls.findIndex(
    ([first, second, third]) => first === "run" && second === "services" && third === "describe",
  );
  const updateIndex = calls.findIndex(
    ([first, second, third]) => first === "run" && second === "services" && third === "update",
  );
  assert.ok(deployIndex >= 0 && deployIndex < describeIndex && describeIndex < updateIndex);
  const deploy = calls[deployIndex];
  assert.equal(deploy.filter((arg) => arg === "--set-env-vars").length, 1);
  const bootstrap = variables(deploy, "--set-env-vars");
  assert.deepEqual(bootstrap, {
    MODE: "polling",
    HOME: "/data",
    TIMEZONE: "Etc/UTC",
    AGENT_NAME: "Coach",
    TRANSCRIBE_PROVIDER: "off",
    SESSION_FILE: "/data/sessions.json",
    SCHEDULE_FILE: "/data/schedule.json",
    ALLOWED_TELEGRAM_IDS: "YOUR_TELEGRAM_ID",
    OWNER_CHAT_ID: "YOUR_TELEGRAM_ID",
  });
  const update = calls[updateIndex];
  assert.ok(!update.includes("--set-env-vars"));
  assert.deepEqual(variables(update, "--update-env-vars"), {
    MODE: "webhook",
    PUBLIC_BASE_URL: "https://synthetic-service.example",
  });
  const jobs = calls.filter(([first]) => first === "scheduler");
  assert.equal(jobs.length, 2);
  for (const args of jobs) {
    assert.equal(args[args.indexOf("--uri") + 1], "https://synthetic-service.example/cron/run");
  }
});
