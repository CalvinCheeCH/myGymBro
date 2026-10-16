const DAY = 86_400_000;
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const display = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const dateAt = (value) => new Date(value).toISOString().slice(0, 10);
const iso = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && dateAt(time) === value ? time : null;
};
const labelDate = (value) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const rt = (content, annotations = {}) => ({
  type: "text",
  text: { content: String(content) },
  annotations,
});
const splitText = (part) => {
  const pieces = [];
  let remaining = part.text.content;
  do {
    let end = Math.min(2000, remaining.length);
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    pieces.push({ ...part, text: { ...part.text, content: remaining.slice(0, end) } });
    remaining = remaining.slice(end);
  } while (remaining.length);
  return pieces;
};
const block = (type, content) => ({
  object: "block",
  type,
  [type]: content.rich_text
    ? { ...content, rich_text: content.rich_text.flatMap(splitText) }
    : content,
});
const paragraph = (content, annotations) =>
  block("paragraph", { rich_text: Array.isArray(content) ? content : [rt(content, annotations)] });
const heading = (content) => block("heading_3", { rich_text: [rt(content)] });
const columns = (...children) =>
  block("column_list", { children: children.map((items) => block("column", { children: items })) });
const callout = (title, icon, children, color = "gray_background") =>
  block("callout", {
    rich_text: [rt(title, { bold: true })],
    icon: { type: "emoji", emoji: icon },
    color,
    children,
  });

function prepare(model) {
  const today = iso(model.date);
  if (today === null) throw new Error("Dashboard needs a valid YYYY-MM-DD date.");
  if (model.nutrition?.date && model.nutrition.date !== model.date)
    throw new Error("Dashboard nutrition must match the selected date.");
  const weekStart = iso(model.weekStart) ?? today - new Date(today).getUTCDay() * DAY;
  const workouts = Array.isArray(model.workouts)
    ? model.workouts.filter(
        (row) =>
          iso(row.date) !== null &&
          iso(row.date) <= today &&
          !["skipped", "planned", "cancelled", "canceled"].includes(
            String(row.status ?? "").toLowerCase(),
          ),
      )
    : null;
  const weights = Array.isArray(model.bodyStats)
    ? model.bodyStats
        .filter(
          (row) =>
            iso(row.date) !== null &&
            iso(row.date) <= today &&
            number(row.weight) !== null &&
            row.weight > 0,
        )
        .sort((a, b) => a.date.localeCompare(b.date))
    : null;
  const week =
    workouts?.filter((row) => iso(row.date) >= weekStart && iso(row.date) < weekStart + 7 * DAY) ??
    [];
  const sessionCount = week.reduce(
    (total, row) => total + (Number.isInteger(row.sessions) && row.sessions > 0 ? row.sessions : 1),
    0,
  );
  const duration = week.reduce((total, row) => total + (number(row.duration) ?? 0), 0);
  return { ...model, today, weekStart, workouts, weights, week, sessionCount, duration };
}

function progress(value, target, color) {
  const known = number(value) !== null && number(target) > 0;
  const fraction = known ? value / target : null;
  const segments = known ? Math.max(0, Math.min(12, Math.round(fraction * 12))) : 0;
  const tint = { green: "#75A35A", blue: "#779EDE", purple: "#A18AC9" }[color];
  const positions = [
    [0, 2],
    [0, 3],
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 3],
    [4, 2],
    [4, 1],
    [3, 0],
    [2, 0],
    [1, 0],
    [0, 1],
  ];
  const matrix = Array.from({ length: 5 }, () => Array(5).fill(""));
  for (const [index, [row, column]] of positions.entries())
    matrix[row][column] = `\\textcolor{${index < segments ? tint : "#D8D8D5"}}{\\bullet}`;
  const percentage = known ? `${display(Math.round(fraction * 1000) / 10)}%` : null;
  matrix[2][2] = percentage ? `\\scriptsize{${percentage.replace("%", "\\%")}}` : "\\text{—}";
  const expression = `\\begin{array}{ccccc}${matrix.map((row) => row.join(" & ")).join(" \\\\ ")}\\end{array}`;
  return [
    block("equation", { expression }),
    ...(percentage ? [paragraph(`${percentage} of target`, { bold: true })] : []),
  ];
}

function nutritionCard(data, metric) {
  const nutrition = data.nutrition;
  const calorie = metric === "calories";
  const value = number(nutrition?.[metric]);
  const target = number(nutrition?.[calorie ? "calorieTarget" : "proteinTarget"]);
  const unit = calorie ? "kcal" : "g";
  const title = calorie ? "Calories today" : "Protein today";
  const available = !!nutrition;
  const hasRecords = available && nutrition.records > 0;
  const amount = !available
    ? "Unavailable"
    : !hasRecords
      ? "No meals yet"
      : value === null
        ? "Not recorded"
        : `${display(value)}${target > 0 ? ` / ${display(target)}` : ""} ${unit}`;
  const detail = !available
    ? "Nutrition records could not be read."
    : !hasRecords
      ? "No recorded intake for this date."
      : value === null
        ? "This nutrition value is missing."
        : !(target > 0)
          ? "Daily target not set."
          : value > target
            ? `${display(value - target)} ${unit} above target`
            : `${display(target - value)} ${unit} remaining against your target`;
  return callout(
    title,
    calorie ? "🔥" : "🥚",
    [
      paragraph(amount, { bold: true }),
      ...progress(hasRecords ? value : null, target, calorie ? "blue" : "purple"),
      paragraph(detail, { color: "gray" }),
    ],
    calorie ? "blue_background" : "purple_background",
  );
}

function trainingCard(data) {
  const target = number(data.trainingTarget) > 0 ? data.trainingTarget : null;
  return callout(
    "Training this week",
    "🏋️",
    data.workouts === null
      ? [
          paragraph("Unavailable", { bold: true }),
          ...progress(null, target, "green"),
          paragraph("Workout history could not be read."),
        ]
      : [
          paragraph(
            `${data.sessionCount}${target ? ` / ${display(target)}` : ""} sessions recorded`,
            { bold: true },
          ),
          ...progress(data.sessionCount, target, "green"),
          paragraph(target ? "Against your stated weekly target." : "Weekly target not set.", {
            color: "gray",
          }),
        ],
    "green_background",
  );
}

function weightCard(data) {
  const latest = data.weights?.at(-1);
  const prior = data.weights?.at(-2);
  const children = [
    paragraph(
      latest
        ? `${display(latest.weight)} kg`
        : data.weights === null
          ? "Unavailable"
          : "No check-ins",
      { bold: true },
    ),
    paragraph(
      latest
        ? `Last recorded ${labelDate(latest.date)}`
        : data.weights === null
          ? "Bodyweight records could not be read."
          : "Record a bodyweight check-in.",
      { color: "gray" },
    ),
  ];
  if (prior) {
    const change = Math.round((latest.weight - prior.weight) * 10) / 10;
    children.push(
      paragraph(
        `${change > 0 ? "↑ +" : change < 0 ? "↓ " : "→ "}${display(change)} kg since ${labelDate(prior.date)}`,
      ),
    );
  }
  return callout("Latest bodyweight", "⚖️", children);
}

function weeklyPanel(data) {
  const children = [
    heading("Your training week"),
    paragraph(
      `${labelDate(dateAt(data.weekStart))}–${labelDate(dateAt(data.weekStart + 6 * DAY))}`,
      {
        color: "gray",
      },
    ),
  ];
  if (data.workouts === null) return [...children, paragraph("Workout history unavailable.")];
  const totals = Array.from({ length: 7 }, (_, index) => {
    const date = dateAt(data.weekStart + index * DAY);
    const rows = data.week.filter((row) => row.date === date);
    const known = rows.filter((row) => number(row.duration) !== null);
    return { date, rows, known, minutes: known.reduce((sum, row) => sum + row.duration, 0) };
  });
  const maxDuration = Math.max(60, ...totals.map((day) => day.minutes));
  for (const day of totals) {
    const weekday = new Date(`${day.date}T00:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "short",
      timeZone: "UTC",
    });
    const length = day.minutes > 0 ? Math.max(1, Math.round((day.minutes / maxDuration) * 8)) : 0;
    const future = iso(day.date) > data.today;
    const label = future
      ? "Upcoming"
      : day.known.length
        ? `${display(day.minutes)} min${day.known.length < day.rows.length ? " · some durations missing" : ""}`
        : day.rows.length
          ? "Logged · duration not recorded"
          : "No record";
    children.push(
      paragraph([
        rt(`${weekday} `, { bold: true }),
        rt("▰".repeat(length) + "▱".repeat(8 - length), { color: "green" }),
        rt(`  ${label}`, { color: future ? "gray" : "default" }),
      ]),
    );
  }
  children.push(
    paragraph(
      data.week.length
        ? `${display(data.duration)} recorded minutes${data.week.some((row) => number(row.duration) === null) ? " · some durations missing" : " this week"}`
        : "No workouts recorded for this week.",
      { color: "gray" },
    ),
  );
  if (data.nextSession?.title)
    children.push(
      callout(
        `Next up: ${data.nextSession.title}`,
        "↗️",
        data.nextSession.detail
          ? [paragraph(data.nextSession.detail)]
          : [paragraph("See Weekly Plan.")],
        "green_background",
      ),
    );
  return children;
}

function heatmapPanel(data) {
  const currentMonday = data.today - ((new Date(data.today).getUTCDay() + 6) % 7) * DAY;
  const start = currentMonday - 77 * DAY;
  const children = [
    heading("Consistency adds up"),
    paragraph(
      `12 weeks · ${labelDate(dateAt(start))}–${labelDate(dateAt(currentMonday + 6 * DAY))}`,
      { color: "gray" },
    ),
  ];
  if (data.workouts === null) return [...children, paragraph("Training history unavailable.")];
  const counts = new Map();
  for (const row of data.workouts)
    counts.set(
      row.date,
      (counts.get(row.date) ?? 0) +
        (Number.isInteger(row.sessions) && row.sessions > 0 ? row.sessions : 1),
    );
  children.push(paragraph("Each column is one week, oldest to newest.", { color: "gray" }));
  for (const [day, label] of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].entries()) {
    const cells = [rt(`${label}  `, { code: true })];
    for (let week = 0; week < 12; week++) {
      const time = start + (week * 7 + day) * DAY;
      const count = counts.get(dateAt(time)) ?? 0;
      cells.push(
        rt(`${time > data.today ? "·" : ["□", "▪", "■", "▣"][Math.min(count, 3)]} `, {
          code: true,
          color: time <= data.today && count > 0 ? "green" : "gray",
        }),
      );
    }
    children.push(paragraph(cells));
  }
  const days = [...counts.keys()].filter(
    (date) => iso(date) >= start && iso(date) <= data.today,
  ).length;
  children.push(
    paragraph("□ no record · ▪ 1 session · ■ 2 · ▣ 3+ · · future", { color: "gray" }),
    paragraph(`${days} days with training recorded`, { bold: true }),
    paragraph("Missing logs are not confirmed rest days.", { color: "gray" }),
  );
  return children;
}

function mealPanel(data) {
  const children = [heading("Today's nutrition"), paragraph(data.date, { color: "gray" })];
  if (!data.nutrition) return [...children, paragraph("Nutrition records could not be read.")];
  if (!data.nutrition.records)
    return [
      ...children,
      paragraph("No meals recorded for this date."),
      paragraph("No recorded intake does not mean you ate nothing.", { color: "gray" }),
    ];
  if (!Array.isArray(data.meals) || !data.meals.length)
    children.push(paragraph("Open your Meal Log for the recorded meal details."));
  for (const meal of (data.meals ?? []).slice(0, 8)) {
    children.push(
      block("bulleted_list_item", {
        rich_text: [
          rt(meal.occasion ? `${meal.occasion} · ` : "", { bold: true }),
          rt(meal.name || "Recorded meal"),
          rt(
            ` — ${number(meal.kcal) === null ? "calories not recorded" : `${display(meal.kcal)} kcal`}; ${number(meal.protein) === null ? "protein not recorded" : `${display(meal.protein)} g protein`}`,
            { color: "gray" },
          ),
        ],
      }),
    );
  }
  if (data.meals?.length > 8)
    children.push(paragraph(`${data.meals.length - 8} more entries in your Meal Log.`));
  children.push(
    paragraph(
      data.nutrition.incomplete
        ? "Some nutrition values are missing. Totals include the available numbers."
        : "Recorded totals; meal-photo values remain estimates.",
      { color: "gray" },
    ),
  );
  return children;
}

function goalsPanel(data) {
  const children = [
    heading("What you're working toward"),
    callout(
      "Active program",
      "🎯",
      [
        paragraph(
          data.program?.name ||
            (data.program === undefined ? "Program unavailable" : "No active program recorded"),
          { bold: true },
        ),
      ],
      "green_background",
    ),
  ];
  if (!Array.isArray(data.goals) || !data.goals.length)
    children.push(
      paragraph(Array.isArray(data.goals) ? "No goals recorded yet." : "Goals could not be read."),
    );
  for (const goal of (data.goals ?? []).slice(0, 6)) {
    const values =
      number(goal.current) !== null && number(goal.target) !== null
        ? `${display(goal.current)} / ${display(goal.target)}${goal.unit ? ` ${goal.unit}` : ""}`
        : goal.status || "No numeric target set";
    children.push(
      block("bulleted_list_item", {
        rich_text: [rt(goal.title || "Recorded goal", { bold: true }), rt(` · ${values}`)],
      }),
    );
  }
  if (data.goals?.length > 6)
    children.push(paragraph(`${data.goals.length - 6} more goals in your saved records.`));
  return children;
}

// Materialize this logical tree in stages: Notion accepts only two nesting levels per append.
export function renderDashboardBlocks(model) {
  const data = prepare(model);
  return [
    paragraph(`Your fitness at a glance · ${data.date}`, { bold: true }),
    columns(
      [trainingCard(data)],
      [nutritionCard(data, "calories")],
      [nutritionCard(data, "protein")],
      [weightCard(data)],
    ),
    paragraph("Rings use 12 rounded segments; percentages show progress to 0.1%.", {
      color: "gray",
    }),
    columns(weeklyPanel(data), heatmapPanel(data)),
    columns(mealPanel(data), goalsPanel(data)),
  ];
}

export function renderNutritionBlocks(model, { dailyPageId } = {}) {
  const data = prepare(model);
  if (
    dailyPageId &&
    !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(dailyPageId)
  )
    throw new Error("The daily meal record link needs a Notion page ID.");
  const children = [
    paragraph(`Recorded intake · ${data.date}`, { bold: true }),
    columns([nutritionCard(data, "calories")], [nutritionCard(data, "protein")]),
    paragraph("Rings use 12 rounded segments; percentages show progress to 0.1%.", {
      color: "gray",
    }),
    heading("One daily record"),
    paragraph("The Dashboard and Meal Log use the same recorded totals."),
  ];
  if (dailyPageId) {
    const link = rt(`Open ${data.date}'s meal record`);
    link.text.link = { url: `https://www.notion.so/${dailyPageId.replaceAll("-", "")}` };
    children.push(paragraph([link]));
  }
  children.push(
    paragraph(
      !data.nutrition
        ? "Nutrition records could not be read."
        : !data.nutrition.records
          ? "No meals recorded for this date. Zero recorded intake does not mean you ate nothing."
          : data.nutrition.incomplete
            ? "Some saved records have missing nutrition values. Totals include the available numbers."
            : "Recorded totals; meal-photo values remain estimates. Saved label values keep repeat foods consistent.",
      { color: "gray" },
    ),
  );
  return children;
}
