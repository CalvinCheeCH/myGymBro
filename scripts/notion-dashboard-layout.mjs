import { listLayoutChildren, workspaceNavigation } from "./notion-layout.mjs";

export const DASHBOARD_OVERVIEW_MARKER = "Your daily overview";
const richText = (content) => [{ type: "text", text: { content } }];
const blockText = (block) =>
  (block[block.type]?.rich_text ?? [])
    .map((part) => part.plain_text ?? part.text?.content ?? "")
    .join("");

export function findDashboardOverview(children) {
  return children.find(
    (block) => block.type === "callout" && blockText(block) === DASHBOARD_OVERVIEW_MARKER,
  );
}

export function compactDashboardBody(cache) {
  return [
    { type: "heading_2", heading_2: { rich_text: richText("Your fitness at a glance") } },
    {
      type: "paragraph",
      paragraph: {
        rich_text: richText(
          "Your recorded training, nutrition, body check-ins, and goals in one overview. Use the pages below for the full details.",
        ),
      },
    },
    workspaceNavigation(cache),
    { type: "divider", divider: {} },
    {
      type: "callout",
      callout: {
        rich_text: richText(DASHBOARD_OVERVIEW_MARKER),
        icon: { type: "emoji", emoji: "📊" },
        color: "default",
        children: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: richText(
                "Your overview is waiting for a workspace sync. No activity or intake has been assumed.",
              ),
            },
          },
        ],
      },
    },
  ];
}

const LEGACY_ROWS = [
  ["Next Session", "Progression"],
  ["This Week", "Nutrition", "Body Stats"],
  ["Goals", "Active Program"],
  ["Quick Commands", "Message Your Coach"],
];
const LEGACY_COLUMN_KEYS = [
  "nextSession",
  "progressionGuide",
  "thisWeek",
  "nutrition",
  "bodyStats",
  "goals",
  "activeProgram",
  "quickCommands",
  "messageCoach",
];
const normalizeId = (id) =>
  String(id ?? "")
    .replaceAll("-", "")
    .toLowerCase();

async function containsRecordContainer(api, blocks) {
  for (const block of blocks) {
    if (["child_page", "child_database"].includes(block.type)) return true;
    if (
      block.has_children &&
      (await containsRecordContainer(api, await listLayoutChildren(api, block.id)))
    )
      return true;
  }
  return false;
}

function generatedNavigation(block) {
  if (block.type !== "callout") return false;
  const rich = block.callout.rich_text ?? [];
  const labels = rich
    .filter((part) => part.text?.link || part.href)
    .map((part) => part.plain_text ?? part.text?.content ?? "");
  const known = [
    "Dashboard",
    "Workout Log",
    "Meal Log",
    "Weekly Plan",
    "Food & Knowledge",
    "Programs",
    "Goals",
    "Body Stats",
    "Training Calendar",
    "Food Library",
    "Exercise Library",
    "Knowledge Base",
  ];
  const sets = [
    known.slice(0, 5),
    ["Programs", "Goals", "Body Stats", "Workout Log"],
    ["Meal Log", "Food Library", "Knowledge Base"],
  ];
  return (
    sets.some((set) => set.every((label) => labels.includes(label))) &&
    rich.every((part) => {
      const content = part.plain_text ?? part.text?.content ?? "";
      return part.text?.link || part.href ? known.includes(content) : /^[\s·]*$/.test(content);
    })
  );
}

/** Identify only the old generated display blocks, never arbitrary dashboard content. */
export async function legacyDashboardDisplayIds(api, children, cache) {
  const remove = new Set();
  const ownedColumns = new Set(
    LEGACY_COLUMN_KEYS.map((key) => normalizeId(cache.__dashboard?.columns?.[key])).filter(Boolean),
  );
  for (const block of children) {
    if (block.type === "column_list" && ownedColumns.size) {
      const columns = await listLayoutChildren(api, block.id);
      if (
        !columns.length ||
        columns.some(
          (column) => column.type !== "column" || !ownedColumns.has(normalizeId(column.id)),
        )
      )
        continue;
      const labels = [];
      let containsRecord = false;
      for (const column of columns) {
        const content = await listLayoutChildren(api, column.id);
        labels.push(content[0]?.type === "callout" ? blockText(content[0]) : "");
        containsRecord ||= await containsRecordContainer(api, content);
      }
      if (
        !containsRecord &&
        LEGACY_ROWS.some(
          (row) =>
            row.length === labels.length && row.every((label, index) => label === labels[index]),
        )
      )
        remove.add(block.id);
    } else if (generatedNavigation(block)) remove.add(block.id);
    else if (
      block.type === "callout" &&
      blockText(block) === "YOUR TRAINING HQ · real progress, one place"
    )
      remove.add(block.id);
    else if (
      block.type === "paragraph" &&
      blockText(block) ===
        "Log sessions and meals in Telegram. Your next-session card uses your saved plan and actual workout history."
    )
      remove.add(block.id);
  }
  // The previous heatmap publisher writes this exact four-block signature.
  for (let index = 0; index < children.length - 3; index++) {
    const [heading, legend, table, summary] = children.slice(index, index + 4);
    if (
      heading.type === "heading_2" &&
      blockText(heading) === "Training Calendar" &&
      legend.type === "paragraph" &&
      blockText(legend) === "⬜ rest   🟩 1   🟨 2   🟧 3   🟥 4+" &&
      table.type === "table" &&
      summary.type === "paragraph" &&
      /^\d+ sessions in the last \d+ weeks\.$/.test(blockText(summary))
    ) {
      for (const block of [heading, legend, table, summary]) remove.add(block.id);
    }
  }
  for (const [index, block] of children.entries()) {
    if (
      block.type === "divider" &&
      remove.has(children[index - 1]?.id) &&
      remove.has(children[index + 1]?.id)
    )
      remove.add(block.id);
  }
  return remove;
}
