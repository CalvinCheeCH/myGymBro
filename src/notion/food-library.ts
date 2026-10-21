import { execFile } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "../agent/tooling.js";
import { config } from "../config.js";
import { measureTiming } from "../util/timing.js";

interface FoodRow {
  name: string;
  serving: string;
  properties: Record<string, string | number>;
}

// Saved text is data, never answer-button metadata or Markdown instructions.
function literal(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/`/g, "'")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim()
    .slice(0, 160);
}

function property(row: FoodRow, name: RegExp): string | number | undefined {
  return Object.entries(row.properties).find(([key]) => name.test(key))?.[1];
}

/** Render the stored serving basis and numbers without estimating missing nutrition. */
export function formatFoodLibrary(value: unknown): string {
  const page = value as { rows?: FoodRow[]; hasMore?: boolean } | null;
  if (!page || !Array.isArray(page.rows) || typeof page.hasMore !== "boolean") {
    throw new Error("Invalid Food Library response.");
  }
  if (page.rows.length > 50) throw new Error("Food Library page exceeded its limit.");
  if (page.rows.length === 0) {
    return page.hasMore
      ? "No active foods on this Food Library page. Open the library in Notion to see more."
      : "Your Food Library is empty. Send a food label with ‘remember this’ to save your first food.";
  }
  const lines = ["**Food Library**", "Saved values for each listed serving."];
  for (const row of page.rows) {
    if (
      !row ||
      typeof row.name !== "string" ||
      typeof row.serving !== "string" ||
      !row.properties ||
      typeof row.properties !== "object" ||
      Array.isArray(row.properties)
    ) {
      throw new Error("Invalid Food Library row.");
    }
    const calories = property(row, /^(?:calories(?:\s*\(kcal\))?|kcal)$/i);
    const protein = property(row, /^protein(?:\s*\(g\))?$/i);
    const category = property(row, /^category$/i);
    const nutrition = [
      typeof calories === "number" && Number.isFinite(calories)
        ? `${calories} kcal`
        : "Calories not saved",
      typeof protein === "number" && Number.isFinite(protein)
        ? `${protein} g protein`
        : "Protein not saved",
    ];
    const serving = literal(row.serving);
    const group = typeof category === "string" ? literal(category) : "";
    lines.push(
      "",
      `\`${literal(row.name) || "Unnamed food"}\``,
      `Serving: ${serving ? `\`${serving}\`` : "not saved"}${group ? ` · \`${group}\`` : ""}`,
    );
    lines.push(nutrition.join(" · "));
  }
  if (page.hasMore) {
    lines.push(
      "",
      `Showing ${page.rows.length} foods from the first page, A–Z. Open Food Library in Notion for more.`,
    );
  }
  return lines.join("\n");
}

/** Fixed read-only helper invocation: no model round trip or user-supplied command arguments. */
export async function readFoodLibrary(): Promise<string> {
  if (!config.notionToken) {
    return "Notion isn't connected. Connect your Notion workspace to browse your Food Library.";
  }
  try {
    return await measureTiming("notion_read", async () => {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [
            path.join(PROJECT_ROOT, "scripts", "notion.mjs"),
            "lookup",
            "--db",
            "Food Library",
            "--limit",
            "50",
            "--json",
          ],
          {
            cwd: PROJECT_ROOT,
            timeout: 10_000,
            maxBuffer: 256 * 1024,
            windowsHide: true,
            encoding: "utf8",
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      return formatFoodLibrary(JSON.parse(output));
    });
  } catch {
    return "I couldn't read your Food Library just now. Try /foodlib again. If it keeps failing, check the Notion connection and workspace setup.";
  }
}
