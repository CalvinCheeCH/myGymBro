import sharp from "sharp";

const WIDTH = 1200;
const HEIGHT = 980;
const DAY = 86_400_000;
const COLORS = {
  ink: "#292d27",
  muted: "#70756a",
  line: "#e6e8e1",
  soft: "#f5f6f1",
  green: "#a7bf86",
  blue: "#94b2dd",
  purple: "#b4a0d5",
};
const escapeXml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const display = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const clip = (value, length = 45) =>
  String(value ?? "").length > length
    ? `${String(value).slice(0, length - 1)}…`
    : String(value ?? "");
const iso = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
};
const dateAt = (value) => new Date(value).toISOString().slice(0, 10);
const labelDate = (value) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const text = (
  x,
  y,
  value,
  { size = 14, color = COLORS.ink, weight = 400, anchor = "start" } = {},
) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
const line = (x1, y1, x2, y2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.line}"/>`;
const card = (x, y, width, height) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="#fff" stroke="${COLORS.line}"/>`;
const title = (x, y, value, detail) =>
  text(x, y, value, { size: 18, weight: 600 }) +
  (detail ? text(x, y + 23, detail, { size: 12, color: COLORS.muted }) : "");

function ring(cx, cy, fraction, color) {
  const radius = 27;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(Number.isFinite(fraction) ? fraction : 0, 1));
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#edf0e8" stroke-width="6"/><circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="${progress ? "round" : "butt"}" stroke-dasharray="${(progress * circumference).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
}

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

function nutritionMetric(x, label, value, target, unit, available, records, color) {
  const amount = number(value);
  const goal = number(target) > 0 ? target : null;
  const valueText = !available
    ? "Unavailable"
    : !records
      ? "No meals yet"
      : amount === null
        ? "Not recorded"
        : `${display(amount)} ${unit}`;
  let detail = !available
    ? "Refresh after intake can be read"
    : !records
      ? "No recorded intake for this date"
      : goal
        ? `of ${display(goal)} ${unit} target`
        : "Daily target not set";
  if (available && records && amount !== null && goal && amount > goal)
    detail = `${display(amount - goal)} ${unit} above target`;
  return (
    card(x, 106, 274, 150) +
    text(x + 20, 135, label, { size: 11, color: COLORS.muted, weight: 600 }) +
    text(x + 20, 183, valueText, { size: amount !== null && records ? 29 : 20, weight: 600 }) +
    text(x + 20, 214, detail, { size: 11, color: COLORS.muted }) +
    ring(x + 224, 173, amount !== null && goal && available && records ? amount / goal : 0, color)
  );
}

function topCards(data) {
  const target = number(data.trainingTarget) > 0 ? data.trainingTarget : null;
  const latestWeight = data.weights?.at(-1);
  let result =
    card(28, 106, 274, 150) +
    text(48, 135, "TRAINING THIS WEEK", { size: 11, color: COLORS.muted, weight: 600 }) +
    text(
      48,
      183,
      data.workouts === null
        ? "Unavailable"
        : `${data.sessionCount}${target ? ` / ${display(target)}` : ""}`,
      { size: 32, weight: 600 },
    ) +
    text(
      48,
      214,
      data.workouts === null
        ? "Workout history could not be read"
        : `${data.sessionCount === 1 ? "session" : "sessions"} recorded${target ? " against your plan" : ""}`,
      { size: 11, color: COLORS.muted },
    ) +
    ring(252, 173, target && data.workouts ? data.sessionCount / target : 0, COLORS.green);
  result += nutritionMetric(
    318,
    "CALORIES TODAY",
    data.nutrition?.calories,
    data.nutrition?.calorieTarget,
    "kcal",
    !!data.nutrition,
    data.nutrition?.records,
    COLORS.blue,
  );
  result += nutritionMetric(
    608,
    "PROTEIN TODAY",
    data.nutrition?.protein,
    data.nutrition?.proteinTarget,
    "g",
    !!data.nutrition,
    data.nutrition?.records,
    COLORS.purple,
  );
  result +=
    card(898, 106, 274, 150) +
    text(918, 135, "BODYWEIGHT", { size: 11, color: COLORS.muted, weight: 600 }) +
    text(
      918,
      183,
      latestWeight
        ? `${display(latestWeight.weight)} kg`
        : data.weights === null
          ? "Unavailable"
          : "No check-ins",
      { size: latestWeight ? 30 : 22, weight: 600 },
    ) +
    text(
      918,
      214,
      latestWeight
        ? `Last recorded ${labelDate(latestWeight.date)}`
        : "Record a bodyweight check-in",
      { size: 11, color: COLORS.muted },
    );
  if (data.weights?.length >= 2) {
    const recent = data.weights.slice(-12);
    const low = Math.min(...recent.map((row) => row.weight));
    const high = Math.max(...recent.map((row) => row.weight));
    const span = Math.max(high - low, 0.5);
    const points = recent
      .map(
        (row, index) =>
          `${1080 + index * (70 / (recent.length - 1))},${191 - ((row.weight - low) / span) * 28}`,
      )
      .join(" ");
    result += `<polyline data-chart="weight" points="${points}" fill="none" stroke="#a8b49a" stroke-width="2.5" stroke-linejoin="round"/>`;
  }
  return result;
}

function weeklyPanel(data) {
  const x = 28;
  const y = 274;
  let result =
    card(x, y, 564, 314) +
    title(
      x + 22,
      y + 34,
      "Your training week",
      `${labelDate(dateAt(data.weekStart))}–${labelDate(dateAt(data.weekStart + 6 * DAY))} · recorded session duration`,
    );
  const minutesByDate = new Map();
  for (const row of data.week)
    minutesByDate.set(row.date, (minutesByDate.get(row.date) ?? 0) + (number(row.duration) ?? 0));
  const maxDuration = Math.max(60, ...minutesByDate.values());
  for (let index = 0; index < 7; index++) {
    const date = dateAt(data.weekStart + index * DAY);
    const rows = data.week.filter((row) => row.date === date);
    const known = rows.filter((row) => number(row.duration) !== null);
    const minutes = known.reduce((total, row) => total + row.duration, 0);
    const height = (minutes / maxDuration) * 128;
    const cx = x + 54 + index * 73;
    result += `<rect x="${cx - 16}" y="${y + 98}" width="32" height="128" rx="5" fill="#f4f5f1"/>`;
    if (minutes > 0)
      result += `<rect data-chart="weekly-bar" x="${cx - 16}" y="${y + 226 - height}" width="32" height="${height}" rx="5" fill="#b8cda0"/>`;
    result += text(
      cx,
      y + 88,
      known.length ? `${display(minutes)} min` : rows.length ? "Logged" : "—",
      { size: 10, color: COLORS.muted, anchor: "middle" },
    );
    result += text(
      cx,
      y + 247,
      new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "short",
        timeZone: "UTC",
      }),
      { size: 11, weight: 500, anchor: "middle" },
    );
    const focus = [
      ...new Set(
        rows.flatMap((row) =>
          Array.isArray(row.focus) ? row.focus : row.focus ? [row.focus] : [],
        ),
      ),
    ].join(", ");
    if (focus)
      result += text(cx, y + 262, clip(focus, 13), {
        size: 9,
        color: COLORS.muted,
        anchor: "middle",
      });
  }
  const footer =
    data.workouts === null
      ? "Workout history unavailable"
      : data.week.length
        ? `${display(data.duration)} recorded minutes${data.week.some((row) => number(row.duration) === null) ? " · some durations missing" : " this week"}`
        : "No workouts recorded for this week";
  result +=
    line(x + 22, y + 268, x + 542, y + 268) +
    text(x + 22, y + 292, footer, { size: 12, color: COLORS.muted });
  return result;
}

function heatmapPanel(data) {
  const x = 608;
  const y = 274;
  const currentMonday = data.today - ((new Date(data.today).getUTCDay() + 6) % 7) * DAY;
  const start = currentMonday - 77 * DAY;
  const counts = new Map();
  for (const row of data.workouts ?? [])
    counts.set(
      row.date,
      (counts.get(row.date) ?? 0) +
        (Number.isInteger(row.sessions) && row.sessions > 0 ? row.sessions : 1),
    );
  let result =
    card(x, y, 564, 314) +
    title(x + 22, y + 34, "Consistency adds up", "12 weeks of recorded training");
  for (let week = 0; week < 12; week++) {
    const firstDate = new Date(start + week * 7 * DAY);
    const priorDate = new Date(start + (week - 1) * 7 * DAY);
    if (week === 0 || firstDate.getUTCMonth() !== priorDate.getUTCMonth())
      result += text(
        x + 61 + week * 38,
        y + 78,
        firstDate.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
        { size: 10, color: COLORS.muted },
      );
    for (let day = 0; day < 7; day++) {
      const time = start + (week * 7 + day) * DAY;
      const count = counts.get(dateAt(time)) ?? 0;
      const fill =
        time > data.today || data.workouts === null
          ? "#fafbf8"
          : ["#edf0e8", "#d7e4c7", "#b8d29c", "#8bad6b", "#658948"][Math.min(count, 4)];
      result += `<rect data-chart="heatmap-cell" data-date="${dateAt(time)}" data-count="${time > data.today || data.workouts === null ? "" : count}" x="${x + 61 + week * 38}" y="${y + 88 + day * 20}" width="28" height="15" rx="3" fill="${fill}"/>`;
    }
  }
  for (const [day, label] of [
    [0, "M"],
    [2, "W"],
    [4, "F"],
    [6, "S"],
  ])
    result += text(x + 25, y + 99 + day * 20, label, { size: 10, color: COLORS.muted });
  const recordedDays = [...counts.keys()].filter(
    (date) => iso(date) >= start && iso(date) <= data.today,
  ).length;
  result += text(
    x + 22,
    y + 263,
    data.workouts === null
      ? "Training history unavailable"
      : `${recordedDays} days with training recorded`,
    { size: 12, color: COLORS.muted },
  );
  result += text(x + 321, y + 263, "Less", { size: 9, color: COLORS.muted });
  for (const [index, color] of ["#edf0e8", "#d7e4c7", "#b8d29c", "#8bad6b", "#658948"].entries())
    result += `<rect x="${x + 347 + index * 17}" y="${y + 253}" width="12" height="12" rx="2" fill="${color}"/>`;
  result += text(x + 439, y + 263, "More", { size: 9, color: COLORS.muted });
  result += text(x + 22, y + 289, "Blank dates mean no recorded session, not confirmed rest.", {
    size: 10,
    color: COLORS.muted,
  });
  return result;
}

function nutritionPanel(data) {
  const x = 28;
  const y = 606;
  const meals = Array.isArray(data.meals) ? data.meals : [];
  let result =
    card(x, y, 564, 314) +
    title(x + 22, y + 34, "Today's nutrition", `${data.date} · recorded meals`);
  if (!data.nutrition)
    result += text(x + 22, y + 115, "Nutrition records could not be read.", {
      size: 15,
      color: COLORS.muted,
    });
  else if (!data.nutrition.records)
    result +=
      text(x + 22, y + 115, "No meals recorded for this date.", { size: 15, color: COLORS.muted }) +
      text(x + 22, y + 145, "No recorded intake does not mean you ate nothing.", {
        size: 12,
        color: COLORS.muted,
      });
  else if (!meals.length)
    result +=
      text(
        x + 22,
        y + 115,
        `${data.nutrition.records} daily record${data.nutrition.records === 1 ? "" : "s"} saved`,
        { size: 17, weight: 500 },
      ) +
      text(x + 22, y + 146, "Open your Meal Log for the recorded meal details.", {
        size: 12,
        color: COLORS.muted,
      });
  for (const [index, meal] of meals.slice(0, 4).entries()) {
    const cy = y + 100 + index * 43;
    result += text(x + 22, cy, clip(meal.occasion || meal.name || "Recorded meal", 42), {
      size: 13,
      weight: 500,
    });
    result += text(
      x + 22,
      cy + 17,
      meal.occasion
        ? clip(meal.name, 53)
        : number(meal.protein) !== null
          ? `${display(meal.protein)} g protein recorded`
          : "Protein not recorded",
      { size: 10, color: COLORS.muted },
    );
    result += text(
      x + 540,
      cy,
      number(meal.kcal) !== null ? `${display(meal.kcal)} kcal` : "Not recorded",
      { size: 12, color: COLORS.muted, anchor: "end" },
    );
    if (index < Math.min(meals.length, 4) - 1) result += line(x + 22, cy + 27, x + 542, cy + 27);
  }
  result +=
    line(x + 22, y + 268, x + 542, y + 268) +
    text(
      x + 22,
      y + 292,
      data.nutrition?.incomplete
        ? "Some nutrition values are missing from the record."
        : "Meal estimates remain estimates. Label servings retain their basis.",
      { size: 10, color: COLORS.muted },
    );
  return result;
}

function goalsPanel(data) {
  const x = 608;
  const y = 606;
  let result =
    card(x, y, 564, 314) +
    title(x + 22, y + 34, "What you're working toward", "Your stated goals and saved program");
  result += `<rect x="${x + 22}" y="${y + 80}" width="520" height="77" rx="8" fill="#f4f6ef"/>${text(x + 36, y + 104, "ACTIVE PROGRAM", { size: 10, color: COLORS.muted, weight: 600 })}${text(
    x + 36,
    y + 133,
    data.program?.name
      ? clip(data.program.name, 48)
      : data.program === undefined
        ? "Program unavailable"
        : "No active program recorded",
    { size: 17, weight: 500 },
  )}`;
  const goals = Array.isArray(data.goals) ? data.goals : [];
  if (!goals.length)
    result += text(
      x + 22,
      y + 195,
      data.goals === undefined ? "Goals could not be read." : "No goals recorded yet.",
      { size: 13, color: COLORS.muted },
    );
  for (const [index, goal] of goals.slice(0, 3).entries()) {
    const cy = y + 187 + index * 35;
    const progress =
      number(goal.current) !== null && number(goal.target) !== null
        ? `${display(goal.current)} / ${display(goal.target)}${goal.unit ? ` ${clip(goal.unit, 10)}` : ""}`
        : goal.status || "No numeric target set";
    result +=
      text(x + 22, cy, clip(goal.title || "Recorded goal", 39), { size: 12, weight: 500 }) +
      text(x + 540, cy, clip(progress, 26), { size: 11, color: COLORS.muted, anchor: "end" });
  }
  return result;
}

export function dashboardCaption(model) {
  const data = prepare(model);
  const nutrition = data.nutrition;
  return `Fitness overview · ${data.date}. ${data.workouts === null ? "Training history unavailable." : `${data.sessionCount} session${data.sessionCount === 1 ? "" : "s"} recorded this week, ${display(data.duration)} recorded minutes.`} ${nutrition ? (nutrition.records ? `${display(number(nutrition.calories) ?? 0)} kcal and ${display(number(nutrition.protein) ?? 0)} g protein recorded today${nutrition.incomplete ? ", with some values missing" : ""}.` : "No meals recorded today.") : "Nutrition unavailable."} ${data.weights?.length ? `Latest bodyweight ${display(data.weights.at(-1).weight)} kg on ${data.weights.at(-1).date}.` : "No bodyweight reading available."}`;
}

export function renderDashboardSvg(model) {
  const data = prepare(model);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img"><title>Your fitness dashboard · ${data.date}</title><desc>${escapeXml(dashboardCaption(model))}</desc><rect width="${WIDTH}" height="${HEIGHT}" fill="#fff"/><g font-family="Segoe UI,Arial,sans-serif">${text(28, 34, "YOUR FITNESS AT A GLANCE", { size: 10, color: COLORS.muted, weight: 600 })}${text(28, 73, "A clearer view of your routine.", { size: 28, weight: 600 })}${text(1172, 72, data.date, { size: 13, color: COLORS.muted, anchor: "end" })}${topCards(data)}${weeklyPanel(data)}${heatmapPanel(data)}${nutritionPanel(data)}${goalsPanel(data)}${text(28, 950, "Based on your saved records. Missing logs are not treated as completed activity or confirmed intake.", { size: 11, color: COLORS.muted })}</g></svg>`;
}

export async function renderDashboardPng(model) {
  return sharp(Buffer.from(renderDashboardSvg(model)))
    .png()
    .toBuffer();
}
