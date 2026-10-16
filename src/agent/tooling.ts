import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isVisualRefreshPaused, requestVisualRefresh } from "../notion/refresh.js";
import { redactSecrets } from "../util/redact.js";

const execFile = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const SCRIPT_NAMES = [
  "calendar.mjs",
  "exercise-db.mjs",
  "notion.mjs",
  "progression.mjs",
  "publish-heatmap.mjs",
  "report-card.mjs",
  "send-photo.mjs",
  "setup-workspace.mjs",
] as const;

export type CoachScript = (typeof SCRIPT_NAMES)[number];

const BLOCKED_SEGMENTS = new Set([
  ".git",
  ".claude",
  ".codex",
  ".agents",
  ".terraform",
  "node_modules",
  "dist",
  "data",
]);
const SECRET_FILE =
  /^(?:\.env(?:\.|$)|\.terraformrc$|credentials(?:\.tfrc)?\.json$|client_secret.*\.json$|google-token\.json$|tokens?\.json$)|\.(?:pem|key|p12|pfx|tfstate(?:\..*)?|tfvars(?:\.json)?|parameters\.json)$/i;
const READ_ROOT_FILES = new Set([
  "CLAUDE.md",
  "PERSONAL.md",
  "LOGGING_STYLE.md",
  "PERSONAS.md",
  "README.md",
  "SECURITY.md",
]);
const WRITE_ROOT_FILES = new Set(["PERSONAL.md", "LOGGING_STYLE.md", "PERSONAS.md"]);

function resolveProjectPath(input: unknown, allowData = false): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  const candidate = path.resolve(PROJECT_ROOT, input);
  const rel = path.relative(PROJECT_ROOT, candidate);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  if (
    segments.some(
      (segment) =>
        (BLOCKED_SEGMENTS.has(segment.toLowerCase()) &&
          !(allowData && segment.toLowerCase() === "data")) ||
        SECRET_FILE.test(segment),
    )
  ) {
    return null;
  }
  return candidate;
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

type FileAccess = "read" | "write" | "data" | "processed";

function isApprovedPath(candidate: string, access: FileAccess): boolean {
  if (!resolveProjectPath(candidate, access === "data")) return false;
  const rel = path.relative(PROJECT_ROOT, candidate);
  if (access === "data") return isWithin(path.join(PROJECT_ROOT, "data"), candidate);
  if (access === "processed") {
    return isWithin(path.join(PROJECT_ROOT, "knowledge", "processed"), candidate);
  }
  if (access === "write") {
    return (
      WRITE_ROOT_FILES.has(rel) ||
      (rel.startsWith(`knowledge${path.sep}`) &&
        rel !== `knowledge${path.sep}processed` &&
        !rel.startsWith(`knowledge${path.sep}processed${path.sep}`) &&
        rel !== `knowledge${path.sep}README.md` &&
        rel !== `knowledge${path.sep}.gitkeep`)
    );
  }
  return (
    READ_ROOT_FILES.has(rel) ||
    ["docs", "coach-plugin", "knowledge", "scripts", "src", "tests", "infra"].some((dir) =>
      rel.startsWith(`${dir}${path.sep}`),
    )
  );
}

function assertNoSymlinkEscape(
  candidate: string,
  access: FileAccess,
  allowExternalPersonal = false,
): void {
  const expectedPersonalTarget = path.resolve(path.parse(PROJECT_ROOT).root, "data", "PERSONAL.md");
  if (
    !fs.existsSync(candidate) &&
    fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()
  ) {
    const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
    if (!allowExternalPersonal || target !== expectedPersonalTarget) {
      throw new Error("Path resolves outside the approved project workspace.");
    }
  }
  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (
      !isApprovedPath(realCandidate, access) &&
      !(allowExternalPersonal && realCandidate === expectedPersonalTarget)
    ) {
      throw new Error("Path resolves outside the approved project workspace.");
    }
  }
  let parent = path.dirname(candidate);
  while (isWithin(PROJECT_ROOT, parent)) {
    if (
      !fs.existsSync(parent) &&
      fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()
    ) {
      throw new Error("Path resolves outside the approved project workspace.");
    }
    if (fs.existsSync(parent)) {
      const realTarget = path.resolve(fs.realpathSync(parent), path.relative(parent, candidate));
      if (!isApprovedPath(realTarget, access)) {
        throw new Error("Path resolves outside the approved project workspace.");
      }
    }
    if (parent === PROJECT_ROOT) break;
    parent = path.dirname(parent);
  }
}

function getReadablePath(input: unknown): string {
  const candidate = resolveProjectPath(input);
  if (!candidate) throw new Error("Only non-secret files inside the project are available.");
  const rel = path.relative(PROJECT_ROOT, candidate);
  if (!isApprovedPath(candidate, "read")) {
    throw new Error("That project path is not available to the coach.");
  }
  assertNoSymlinkEscape(candidate, "read", rel === "PERSONAL.md");
  return candidate;
}

function getWritablePath(input: unknown): string {
  const candidate = resolveProjectPath(input);
  if (!candidate) throw new Error("Only approved profile and knowledge files can be changed.");
  const rel = path.relative(PROJECT_ROOT, candidate);
  if (!isApprovedPath(candidate, "write")) {
    throw new Error(
      "Only PERSONAL.md, LOGGING_STYLE.md, PERSONAS.md, and knowledge files can be changed.",
    );
  }
  assertNoSymlinkEscape(candidate, "write", rel === "PERSONAL.md");
  return candidate;
}

function validateScriptArgs(script: CoachScript, args: string[], chatId: string): void {
  const command = args[0] ?? "";
  // Helpers disagree on first/last flag wins; security-sensitive flags must be unique.
  for (const flag of ["--file", "--body-file", "--out", "--chat"]) {
    if (args.indexOf(flag) !== args.lastIndexOf(flag)) {
      throw new Error(`Duplicate ${flag} arguments are not allowed.`);
    }
  }
  if (script === "notion.mjs" && command === "archive") {
    throw new Error("Archiving Notion rows is not available through the coach tool.");
  }
  if (script === "notion.mjs") {
    for (const flag of ["--file", "--body-file"]) {
      const index = args.indexOf(flag);
      if (index !== -1) getReadablePath(args[index + 1]);
    }
  }
  if (script === "report-card.mjs") {
    const outIndex = args.indexOf("--out");
    const outputPath = resolveProjectPath(
      outIndex === -1 ? "data/report-card.png" : args[outIndex + 1],
      true,
    );
    if (!outputPath || !isApprovedPath(outputPath, "data")) {
      throw new Error("Report cards can only be written under data/.");
    }
    assertNoSymlinkEscape(outputPath, "data");
    assertNoSymlinkEscape(path.join(PROJECT_ROOT, "data", "report-cards"), "data");
  }
  if (script === "send-photo.mjs") {
    const chatIndex = args.indexOf("--chat");
    const fileIndex = args.indexOf("--file");
    if (chatIndex === -1 || args[chatIndex + 1] !== chatId) {
      throw new Error("Photos can only be sent to the current private chat.");
    }
    if (fileIndex === -1) throw new Error("A report image path is required.");
    const imagePath = resolveProjectPath(args[fileIndex + 1], true);
    if (!imagePath || !isWithin(path.join(PROJECT_ROOT, "data"), imagePath)) {
      throw new Error("Only generated files under data/ can be sent as photos.");
    }
    assertNoSymlinkEscape(imagePath, "data");
  }
}

function queueVisualScript(script: CoachScript, args: string[], chatId: string): void {
  const key = script === "publish-heatmap.mjs" ? "heatmap" : "dashboard";
  const request =
    key === "dashboard" ? { script: "notion.mjs", args: ["sync-dashboard"] } : { script, args };
  requestVisualRefresh(chatId, key, async () => {
    const result = await runScript(request, chatId);
    if (result.exitCode) throw new Error(result.output);
  });
}

async function runScript(
  args: Record<string, unknown>,
  chatId: string,
  options: { deferVisuals?: boolean } = {},
): Promise<{ output: string; exitCode?: string | number; queued?: boolean }> {
  const script = args.script as CoachScript;
  const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (!SCRIPT_NAMES.includes(script)) throw new Error("That script is not available to the coach.");
  if (scriptArgs.length > 64 || scriptArgs.some((arg) => arg.length > 10_000)) {
    throw new Error("Script arguments exceed the workspace tool limits.");
  }
  validateScriptArgs(script, scriptArgs, chatId);
  const visual =
    script === "publish-heatmap.mjs" ||
    (script === "notion.mjs" && ["sync-dashboard", "sync-nutrition"].includes(scriptArgs[0]));
  if (options.deferVisuals && visual) {
    queueVisualScript(script, scriptArgs, chatId);
    return {
      queued: true,
      output:
        "Display refresh queued for after your reply. This confirms no saved records; confirm logging only from successful save and totals results.",
    };
  }
  const scriptPath = path.join(PROJECT_ROOT, "scripts", script);
  try {
    const { stdout, stderr } = await execFile(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim() || "(no output)";
    return { output: redactSecrets(output).slice(0, 20_000) };
  } catch (error) {
    const e = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    const output = `${e.stdout ?? ""}${e.stderr ? `\n${e.stderr}` : ""}`.trim() || e.message;
    return { exitCode: e.code ?? 1, output: redactSecrets(output).slice(0, 20_000) };
  } finally {
    // A meal can commit before a later body/totals request fails; refresh from current data.
    if (options.deferVisuals && script === "notion.mjs" && scriptArgs[0] === "log-meal") {
      queueVisualScript("notion.mjs", ["sync-dashboard"], chatId);
    }
  }
}

export async function executeCoachTool(
  name: string,
  args: Record<string, unknown>,
  chatId: string,
  options: { deferVisuals?: boolean } = {},
): Promise<Record<string, unknown>> {
  try {
    if (options.deferVisuals && isVisualRefreshPaused()) {
      return {
        error: "Workspace reset is in progress. Wait until it finishes before retrying this tool.",
      };
    }
    if (name === "run_script") return await runScript(args, chatId, options);
    if (name === "read_file") {
      const filePath = getReadablePath(args.path);
      return { content: redactSecrets(fs.readFileSync(filePath, "utf8")).slice(0, 50_000) };
    }
    if (name === "write_file") {
      const filePath = getWritablePath(args.path);
      if (typeof args.content !== "string") throw new Error("File content must be text.");
      if (args.content.length > 200_000) throw new Error("File content exceeds the 200 KB limit.");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, "utf8");
      return { output: `Updated ${path.relative(PROJECT_ROOT, filePath)}.` };
    }
    if (name === "list_knowledge") {
      const dir = path.join(PROJECT_ROOT, "knowledge");
      const files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && entry.name !== "README.md" && entry.name !== ".gitkeep",
        )
        .map((entry) => `knowledge/${entry.name}`);
      return { files };
    }
    if (name === "move_knowledge") {
      const filename = String(args.filename ?? "");
      if (
        !filename ||
        path.basename(filename) !== filename ||
        filename === "README.md" ||
        filename === ".gitkeep"
      ) {
        throw new Error("Provide the name of a loose file in knowledge/.");
      }
      const source = path.join(PROJECT_ROOT, "knowledge", filename);
      const destDir = path.join(PROJECT_ROOT, "knowledge", "processed");
      const dest = path.join(destDir, filename);
      if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
        throw new Error("That loose knowledge file does not exist.");
      }
      assertNoSymlinkEscape(source, "read");
      assertNoSymlinkEscape(dest, "processed");
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(source, dest);
      return { output: `Moved knowledge/${filename} to knowledge/processed/.` };
    }
    return { error: `Unknown coach tool: ${name}` };
  } catch (error) {
    return { error: redactSecrets((error as Error).message) };
  }
}

export const COACH_TOOL_INSTRUCTIONS =
  "Use run_script with a supported script name and an argument array for Notion, calendar, reports, and exercise lookups. notion.mjs log-meal saves a meal and returns authoritative daily totals. Display refreshes are queued until after your reply; queued displays do not confirm saved records. Confirm logging only from successful data writes and totals. Do not use shell syntax. Use read_file and write_file for approved project profile/knowledge files; list_knowledge and move_knowledge handle knowledge imports. The tools cannot access secrets or run arbitrary commands.";

export { SCRIPT_NAMES };
