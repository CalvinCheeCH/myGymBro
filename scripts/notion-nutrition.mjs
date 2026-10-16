import sharp from "sharp";

const rt = (content) => [{ type: "text", text: { content } }];
const rounded = (value) => Math.round(value * 10) / 10;
const display = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function summarizeNutrition(date, meals, targets = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new Error("Nutrition summary needs a YYYY-MM-DD date.");
  }
  const sum = (key) =>
    rounded(
      meals.reduce((total, meal) => {
        const value = meal[key];
        return total + (Number.isFinite(value) && value >= 0 ? value : 0);
      }, 0),
    );
  const target = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  return {
    date,
    records: meals.length,
    calories: sum("kcal"),
    protein: sum("protein"),
    calorieTarget: target(targets.calories),
    proteinTarget: target(targets.protein),
    incomplete: meals.some((meal) => !Number.isFinite(meal.kcal) || !Number.isFinite(meal.protein)),
  };
}

function remaining(value, target, unit) {
  if (!target) return "Set a daily target to see your progress";
  if (value > target) return `${display(rounded(value - target))} ${unit} above your stated target`;
  return `${display(rounded(target - value))} ${unit} remaining against your target`;
}

export function nutritionCaption(summary) {
  const { date, calories, protein, calorieTarget, proteinTarget } = summary;
  return `${date} · Calories: ${display(calories)}${calorieTarget ? ` / ${display(calorieTarget)}` : " (target not set)"} kcal · Protein: ${display(protein)}${proteinTarget ? ` / ${display(proteinTarget)}` : " (target not set)"} g`;
}

/** Only numeric totals and the selected date are rendered; no meal names leave the workspace. */
export function renderNutritionSvg(summary) {
  const card = (y, label, value, target, unit, color) => {
    const fraction = target ? Math.min(value / target, 1) : 0;
    const circumference = 2 * Math.PI * 27;
    return `<rect x="12" y="${y}" width="696" height="112" rx="14" fill="#fff" stroke="#dce5d2"/>
      <circle cx="70" cy="${y + 56}" r="27" fill="none" stroke="#e9eae8" stroke-width="6"/>
      <circle cx="70" cy="${y + 56}" r="27" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="${fraction ? "round" : "butt"}" stroke-dasharray="${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 70 ${y + 56})"/>
      <text x="124" y="${y + 30}" font-size="17" font-weight="600" fill="#46533b">${label}</text>
      <text x="124" y="${y + 65}" font-size="30" font-weight="700" fill="#6d8a50">${display(value)}<tspan font-size="16" font-weight="500">${target ? ` / ${display(target)} ${unit}` : ` ${unit} · target not set`}</tspan></text>
      <text x="124" y="${y + 92}" font-size="15" fill="#738468">${remaining(value, target, unit)}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="300" viewBox="0 0 720 300" role="img"><title>Daily nutrition · ${summary.date}</title><g font-family="Segoe UI,Arial,sans-serif"><rect width="720" height="300" rx="16" fill="#f8faf5"/><text x="20" y="29" font-size="17" font-weight="650" fill="#303a29">Recorded intake · ${summary.date}</text>${card(44, "Calories", summary.calories, summary.calorieTarget, "kcal", "#91b5ff")}${card(168, "Protein", summary.protein, summary.proteinTarget, "g", "#b39aff")}</g></svg>`;
}

export async function uploadNutritionImage(api, summary) {
  const png = await sharp(Buffer.from(renderNutritionSvg(summary)))
    .resize(1440, 600)
    .png()
    .toBuffer();
  return uploadPngImage(api, png, "daily-nutrition.png");
}

export async function uploadPngImage(api, png, filename) {
  const options = { version: "2026-03-11" };
  const upload = await api(
    "/file_uploads",
    "POST",
    {
      mode: "single_part",
      filename,
      content_type: "image/png",
    },
    options,
  );
  if (!/^[a-f0-9-]{32,36}$/i.test(upload.id ?? ""))
    throw new Error("Notion returned no image upload ID.");
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), filename);
  const sent = await api(`/file_uploads/${upload.id}/send`, "POST", form, options);
  if (sent.status !== "uploaded") throw new Error("Notion image upload did not complete.");
  return upload.id;
}

export function nutritionBlocks(summary, uploadId, { detailed = false, dailyPageId } = {}) {
  const caption = nutritionCaption(summary);
  const blocks = [
    {
      type: "image",
      image: {
        type: "file_upload",
        file_upload: { id: uploadId },
        caption: rt(caption),
      },
    },
  ];
  if (detailed) {
    blocks.push({ type: "heading_3", heading_3: { rich_text: rt("One daily record") } });
    blocks.push({
      type: "paragraph",
      paragraph: {
        rich_text: rt("The dashboard and this meal page use the same recorded totals."),
      },
    });
    blocks.push({
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: dailyPageId
                ? `Open ${summary.date}'s meal record`
                : `Daily summary · ${summary.date}`,
              ...(dailyPageId
                ? { link: { url: `https://www.notion.so/${dailyPageId.replaceAll("-", "")}` } }
                : {}),
            },
          },
        ],
      },
    });
  }
  blocks.push({
    type: "paragraph",
    paragraph: {
      rich_text: rt(
        !summary.records
          ? "No meals recorded for this date. Zero means no recorded intake, not that you ate nothing."
          : summary.incomplete
            ? "Some saved records have missing nutrition values. Totals include the available numbers."
            : "Recorded totals; meal-photo values remain estimates. Saved label values give repeat foods a consistent reference.",
      ),
    },
  });
  return blocks;
}
