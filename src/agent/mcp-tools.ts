import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { COACH_TOOL_INSTRUCTIONS, SCRIPT_NAMES, executeCoachTool } from "./tooling.js";

function result(content: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(content) }] };
}

export function createCoachToolServer(chatId: string) {
  const runScript = tool(
    "run_script",
    "Run one approved myGymBro helper script without a shell. Pass the script name and an array of arguments.",
    { script: z.enum(SCRIPT_NAMES), args: z.array(z.string()) },
    async (args) => result(await executeCoachTool("run_script", args, chatId)),
  );
  const readFile = tool(
    "read_file",
    "Read an approved, non-secret project or knowledge file by relative path.",
    { path: z.string() },
    async (args) => result(await executeCoachTool("read_file", args, chatId)),
  );
  const writeFile = tool(
    "write_file",
    "Write an approved profile, persona, logging-style, or knowledge file.",
    { path: z.string(), content: z.string() },
    async (args) => result(await executeCoachTool("write_file", args, chatId)),
  );
  const listKnowledge = tool(
    "list_knowledge",
    "List loose files in the knowledge folder that have not been imported yet.",
    {},
    async (args) => result(await executeCoachTool("list_knowledge", args, chatId)),
  );
  const moveKnowledge = tool(
    "move_knowledge",
    "Move an imported loose knowledge file into knowledge/processed/.",
    { filename: z.string() },
    async (args) => result(await executeCoachTool("move_knowledge", args, chatId)),
  );

  return createSdkMcpServer({
    name: "coach",
    version: "1.0.0",
    instructions: COACH_TOOL_INSTRUCTIONS,
    tools: [runScript, readFile, writeFile, listKnowledge, moveKnowledge],
  });
}
