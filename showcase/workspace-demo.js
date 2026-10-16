const pageTitles = {
  dashboard: "Dashboard",
  workouts: "Workout Log",
  meals: "Meal Log",
  plan: "Training Plan",
  library: "Your Libraries",
};

const activityNames = ["Lower body", "Upper body", "Lower body", "Upper body"];
const heatmapStart = Date.UTC(2026, 6, 27);
const foodRows = [
  {
    meal: "Breakfast",
    icon: "☀",
    name: "Egg sandwich + black coffee",
    kcal: 410,
    protein: 24,
    range: "380–450 kcal",
    source: "Portion estimate",
    time: "8:15 AM",
  },
  {
    meal: "Lunch",
    icon: "◐",
    name: "Chicken rice bowl · small rice portion, vegetables + iced tea",
    kcal: 650,
    protein: 42,
    range: "600–750 kcal",
    proteinRange: "35–45 g protein",
    source: "Photo + portion context",
    time: "1:06 PM",
  },
  {
    meal: "Tea",
    icon: "◌",
    name: "Yogurt + banana",
    kcal: 180,
    protein: 6,
    range: "160–210 kcal",
    source: "Portion estimate",
    time: "4:10 PM",
  },
  {
    meal: "Dinner",
    icon: "☾",
    name: "Noodle soup + vegetables",
    kcal: 440,
    protein: 10,
    range: "390–500 kcal",
    source: "Portion estimate",
    time: "7:30 PM",
  },
  {
    meal: "Supper",
    icon: "✦",
    name: "Protein shake · 1 saved serving",
    kcal: 160,
    protein: 30,
    range: "160 kcal",
    source: "Saved label values",
    time: "9:00 PM",
  },
];

function ring(value, color = "#c6f465") {
  const length = 2 * Math.PI * 21;
  return `<svg class="metric-ring" width="52" height="52" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="21" fill="none" stroke="currentColor" opacity=".1" stroke-width="5"/><circle cx="26" cy="26" r="21" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${length}" stroke-dashoffset="${length * (1 - value)}" transform="rotate(-90 26 26)"/></svg>`;
}

function head(kicker, title, description, actions = "") {
  return `<div class="workspace-page-head"><div><p class="workspace-kicker">${kicker}</p><h3>${title}</h3><p class="notion-muted">${description}</p></div>${actions ? `<div class="workspace-actions">${actions}</div>` : ""}</div>`;
}

function panelHead(title, subtitle, detail = "") {
  return `<div class="workspace-panel-head"><div><h4 class="workspace-panel-title">${title}</h4><p class="workspace-panel-subtitle">${subtitle}</p></div>${detail}</div>`;
}

function callout(icon, title, copy) {
  return `<div class="workspace-callout"><span class="workspace-callout-icon" aria-hidden="true">${icon}</span><div><strong>${title}</strong><p>${copy}</p></div></div>`;
}

function metrics() {
  return `<div class="metric-grid">
    <article class="metric-card"><div><span class="metric-label">Training this week</span><p class="metric-value">3 <span>/ 4</span></p><p class="metric-caption">sessions recorded</p></div>${ring(0.75)}</article>
    <article class="metric-card"><div><span class="metric-label">Calories today</span><p class="metric-value">1,840 <span>/ 2,450</span></p><p class="metric-caption">610 kcal to your target</p></div>${ring(1840 / 2450, "#95b8ff")}</article>
    <article class="metric-card"><div><span class="metric-label">Protein today</span><p class="metric-value">112 <span>/ 140 g</span></p><p class="metric-caption">28 g to your target</p></div>${ring(0.8, "#bba4fb")}</article>
    <article class="metric-card"><div><span class="metric-label">Latest bodyweight</span><p class="metric-value">64.2 <span>kg</span></p><p class="metric-caption">reported at your last check-in</p></div><svg class="metric-ring" width="58" height="44" viewBox="0 0 58 44" aria-hidden="true"><path d="M3 35 L12 31 L21 33 L30 23 L39 26 L48 15 L55 13" fill="none" stroke="#c6f465" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="55" cy="13" r="3" fill="#c6f465"/></svg></article>
  </div>`;
}

function heatmap() {
  const weeks = Array.from({ length: 12 }, (_, week) => {
    const days = Array.from({ length: 7 }, (_, day) => {
      let level = [0, 2, 4].includes(day) ? ((week + day) % 3) + 1 : 0;
      if (week === 11) level = day < 3 ? [2, 3, 2][day] : 0;
      const date = new Date(heatmapStart + (week * 7 + day) * 86400000);
      const dateLabel = date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
      return `<button class="heatmap-day level-${level}${week === 11 && day === 2 ? " is-selected" : ""}" type="button" data-heatmap-week="${week}" data-heatmap-day="${day}" tabindex="${week === 11 && day === 2 ? "0" : "-1"}" aria-pressed="${week === 11 && day === 2}" aria-label="${dateLabel}: ${level ? "training recorded" : "no training recorded"}" title="${dateLabel}: ${level ? "training recorded" : "no training recorded"}"></button>`;
    }).join("");
    return `<div class="heatmap-week">${days}</div>`;
  }).join("");
  return `<div class="heatmap-months" aria-hidden="true"><span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span></div><div class="fitness-heatmap" role="group" aria-label="12-week training calendar. Use arrow keys to explore days."><div class="heatmap-day-labels" aria-hidden="true"><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span><span>S</span></div>${weeks}</div><div class="heatmap-legend"><span>Less</span><i class="level-0"></i><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><span>More activity</span></div><p id="heatmap-detail" class="heatmap-detail" role="status">14 Oct · Lower body · hypertrophy focus · 70 minutes recorded</p>`;
}

function weeklyChart() {
  const bars = [
    ["Sun", 0, "Review", "6 PM"],
    ["Mon", 82, "Lower", "52 min"],
    ["Tue", 70, "Upper", "46 min"],
    ["Wed", 100, "Lower", "70 min"],
    ["Thu", 0, "Planned", "6 PM"],
    ["Fri", 0, "Rest", ""],
    ["Sat", 0, "Rest", ""],
  ];
  return `<div class="weekly-chart" role="img" aria-label="Sample week: lower body Monday, 52 minutes; upper body Tuesday, 46 minutes; Lower body Wednesday, 70 minutes; upper body planned Thursday at 6 PM.">${bars.map(([day, height, name, detail]) => `<div class="weekly-chart-item"><span class="weekly-chart-value">${detail}</span><div class="weekly-chart-track"><div class="weekly-chart-bar${height === 0 ? " is-planned" : ""}" style="height:${height || 8}%"></div></div><strong>${day}</strong><span>${name}</span></div>`).join("")}</div>`;
}

function dashboard() {
  return `${head("Wednesday, 14 October · sample day", "Your effort, in one place.", "A snapshot of the activity you have logged and what comes next.", '<button type="button" class="workspace-button" data-view="meals">View today’s meals <span aria-hidden="true">↗</span></button>')}
  ${metrics()}
  <div class="workspace-grid">
    <section class="workspace-panel">${panelHead("Your training week", "Three sessions down. One already in the plan.", '<span class="notion-tag tag-green">11–17 Oct</span>')}${weeklyChart()}${callout("↗", "Next up: Upper body", "Thursday · 6:00 PM · 45–50 minutes. Bench press, rows, overhead press, and accessories.")}<button type="button" class="workspace-text-button" data-view="plan">Open the weekly plan <span aria-hidden="true">→</span></button></section>
    <section class="workspace-panel">${panelHead("Consistency adds up", "12 weeks of recorded training. Select a day to explore.")}${heatmap()}</section>
  </div>
  <div class="workspace-grid">
    <section class="workspace-panel">${panelHead("Today’s nutrition", "Five entries. One daily record.", '<span class="notion-tag tag-blue">1,840 kcal</span>')}<div class="workspace-mini-meals">${foodRows.map((food) => `<button type="button" class="workspace-mini-meal" data-view="meals"><span class="workspace-meal-icon" aria-hidden="true">${food.icon}</span><span><strong>${food.meal}</strong><small>${food.name}</small></span><span>${food.kcal}<small>kcal</small></span></button>`).join("")}</div><div class="workspace-total-line"><span>Recorded protein</span><strong>112 / 140 g</strong></div></section>
    <section class="workspace-panel">${panelHead("What you’re working toward", "Your goals stay beside your day-to-day records.")}<div class="workspace-goal"><span class="notion-tag tag-green">Active program</span><h4>Strength & Hypertrophy</h4><p>Four gym sessions per week. Alternate upper and lower body training, with recovery days to support steady progress.</p></div><div class="workspace-detail-row"><span>Daily nutrition targets</span><strong>2,450 kcal · 140 g protein</strong></div><div class="workspace-detail-row"><span>Training equipment</span><strong>Barbell, dumbbells, cables</strong></div><div class="workspace-detail-row"><span>Current focus</span><strong>Consistent sets, steady progression</strong></div><button type="button" class="workspace-text-button" data-view="library">Explore your saved references <span aria-hidden="true">→</span></button></section>
  </div>`;
}

function workoutDetails(previous = false) {
  if (previous)
    return `<div class="workspace-detail"><div class="workspace-detail-heading"><h4>Last week, at a glance</h4><span class="notion-tag tag-green">4 sessions completed</span></div><div class="workspace-detail-row"><span>Monday · Lower body</span><strong>Squat 70 kg · 3 × 8</strong></div><div class="workspace-detail-row"><span>Tuesday · Upper body</span><strong>Bench 57.5 kg · 10, 10, 10 reps</strong></div><div class="workspace-detail-row"><span>Wednesday · Lower body</span><strong>Legs + accessories · 70 min</strong></div><div class="workspace-detail-row"><span>Thursday · Upper body</span><strong>Bench 57.5 kg · 10, 10, 10 reps</strong></div><p class="notion-muted">Your previous sets give the coach a concrete starting point for the next session.</p></div>`;
  return `<div class="workspace-detail"><div class="workspace-detail-heading"><div><p class="workspace-kicker">Tuesday · 13 October</p><h4>Upper body · 46 minutes</h4></div><span class="notion-tag tag-green">Completed</span></div><div class="notion-table-wrap"><table class="notion-table"><caption class="sr-only">Recorded upper body working sets</caption><thead><tr><th scope="col">Exercise</th><th scope="col">Set 1</th><th scope="col">Set 2</th><th scope="col">Set 3</th></tr></thead><tbody><tr><th scope="row" class="notion-table-name">Bench press</th><td>60 kg × 12</td><td>60 kg × 12</td><td>60 kg × 10</td></tr><tr><th scope="row" class="notion-table-name">Chest-supported row</th><td>25 kg × 12</td><td>25 kg × 12</td><td>25 kg × 12</td></tr><tr><th scope="row" class="notion-table-name">Overhead press</th><td>30 kg × 10</td><td>30 kg × 10</td><td>30 kg × 8</td></tr><tr><th scope="row" class="notion-table-name">Cable triceps pushdown</th><td>20 kg × 12</td><td>20 kg × 12</td><td>20 kg × 12</td></tr></tbody></table></div>${callout("↗", "Useful context for your next session", "Bench press is still at 60 kg. Aim to make all three working sets consistent before increasing the load. This is an illustrative coaching suggestion.")}</div>`;
}

function workouts(week = "current") {
  return `${head("Your training history", "Every set has a place.", "Weekly pages hold session details, so last week’s work is easy to revisit.", `<button type="button" class="workspace-button${week === "current" ? " is-active" : ""}" data-week="current" aria-pressed="${week === "current"}">This week</button><button type="button" class="workspace-button${week === "previous" ? " is-active" : ""}" data-week="previous" aria-pressed="${week === "previous"}">Last week</button>`)}
  <section class="workspace-panel">${panelHead("Workout Log", "Weekly records, with the actual sets inside.", '<span class="notion-tag tag-green">Weekly pages</span>')}<div class="notion-table-wrap"><table class="notion-table"><caption class="sr-only">Sample weekly workout records</caption><thead><tr><th scope="col">Week</th><th scope="col">Sessions</th><th scope="col">Recorded time</th><th scope="col">Status</th><th scope="col">Details</th></tr></thead><tbody><tr class="${week === "current" ? "is-selected" : ""}"><th scope="row" class="notion-table-name">▤ 11–17 October</th><td>3 / 4</td><td>168 min</td><td><span class="notion-tag tag-blue">In progress</span></td><td><button type="button" class="workspace-text-button" data-expand="current" aria-expanded="${week === "current"}" aria-controls="workout-detail-current">${week === "current" ? "Hide sets" : "View sets"}</button></td></tr><tr class="${week === "previous" ? "is-selected" : ""}"><th scope="row" class="notion-table-name">▤ 4–10 October</th><td>4 / 4</td><td>221 min</td><td><span class="notion-tag tag-green">Completed</span></td><td><button type="button" class="workspace-text-button" data-expand="previous" aria-expanded="${week === "previous"}" aria-controls="workout-detail-previous">${week === "previous" ? "Hide sets" : "View sets"}</button></td></tr><tr><th scope="row" class="notion-table-name">▤ 27 September–3 October</th><td>3 / 4</td><td>165 min</td><td><span class="notion-tag tag-amber">3 recorded</span></td><td><span class="notion-muted">Archived week</span></td></tr></tbody></table></div><div id="workout-detail-current"${week !== "current" ? " hidden" : ""}>${workoutDetails()}</div><div id="workout-detail-previous"${week !== "previous" ? " hidden" : ""}>${workoutDetails(true)}</div></section>
  <div class="workspace-grid"><section class="workspace-panel">${panelHead("This week’s sessions", "Your gym sessions, kept together.")}<div class="workspace-detail-row"><span>Mon · Lower body</span><strong>52 minutes</strong></div><div class="workspace-detail-row"><span>Tue · Upper body</span><strong>46 minutes</strong></div><div class="workspace-detail-row"><span>Wed · Lower body</span><strong>70 minutes · hypertrophy focus</strong></div></section><section class="workspace-panel">${panelHead("History that helps", "Ask about the work you have already done.")}<blockquote class="workspace-quote">“What did I bench last time?”</blockquote><p class="notion-muted">The coach can retrieve your recorded loads and reps instead of starting each conversation from scratch.</p><button type="button" class="workspace-text-button" data-view="dashboard">Back to your overview <span aria-hidden="true">→</span></button></section></div>`;
}

function meals() {
  return `${head("Wednesday, 14 October · sample day", "Everyday food. Clear daily totals.", "Your meal messages become one organized daily page in Notion.", '<span class="notion-tag tag-blue">5 meals recorded</span>')}
  <div class="workspace-grid"><section class="workspace-panel nutrition-summary">${panelHead("Daily nutrition", "Recorded intake against your personal targets.")}<div class="workspace-nutrition-target">${ring(1840 / 2450, "#95b8ff")}<div><strong>1,840 <span>/ 2,450 kcal</span></strong><p>610 kcal remaining against your target</p></div></div><div class="workspace-nutrition-target">${ring(0.8, "#bba4fb")}<div><strong>112 <span>/ 140 g protein</span></strong><p>28 g remaining against your target</p></div></div></section><section class="workspace-panel">${panelHead("One daily record", "The dashboard and meal page use the same recorded totals.")}<div class="workspace-detail-row"><span>Daily page</span><strong>▤ 14 October 2026</strong></div><div class="workspace-detail-row"><span>Meal sections</span><strong>Breakfast → Supper</strong></div><div class="workspace-detail-row"><span>Recorded entries</span><strong>5 meals · 1,840 kcal · 112 g protein</strong></div><p class="notion-muted">Portion estimates stay visible. Saved label values give repeat foods a consistent reference.</p></section></div>
  <section class="workspace-panel">${panelHead("What you ate", "Open an entry to see its source and estimate range.", '<span class="notion-tag tag-green">Meal Log</span>')}<div class="workspace-meal-list">${foodRows.map((food, index) => `<details class="workspace-meal-row"${index === 1 ? " open" : ""}><summary><span class="workspace-meal-icon" aria-hidden="true">${food.icon}</span><span class="workspace-meal-description"><strong>${food.meal}</strong><span>${food.name}</span></span><span class="workspace-meal-numbers"><strong>${food.kcal} kcal</strong><small>${food.protein} g protein</small></span><span class="workspace-expand-icon" aria-hidden="true">⌄</span></summary><div class="workspace-meal-detail"><span>${food.time} · ${food.source}</span><p><strong>${food.range}${food.proteinRange ? ` · ${food.proteinRange}` : ""}</strong>${food.range.includes("–") ? " estimated range. The daily total uses the recorded estimate above." : " per saved serving from a nutrition label."}</p>${index === 1 ? "<p>Portion context: a small rice portion, one grilled chicken breast, vegetables, and lightly sweetened iced tea. Sauces and serving size can change the estimate.</p>" : ""}</div></details>`).join("")}</div><div class="workspace-total-line"><span>Daily recorded total</span><strong>1,840 kcal · 112 g protein</strong></div></section>
  ${callout("✦", "A familiar food, remembered", "The shake uses saved label values from your Food Library. Next time, log the serving and reuse the same nutrition reference.")}<button type="button" class="workspace-text-button" data-view="library">Open the Food Library <span aria-hidden="true">→</span></button>`;
}

function plan() {
  const days = [
    [
      "Sunday",
      "Weekly review",
      "Review last week + plan this week",
      "6:00 PM",
      "Check-in",
      "amber",
    ],
    ["Monday", "Lower body", "Squat · RDL · split squat", "6:00 PM", "Completed", "green"],
    ["Tuesday", "Upper body", "Bench · row · overhead press", "6:00 PM", "Completed", "green"],
    [
      "Wednesday",
      "Lower body",
      "Legs + accessories · hypertrophy focus",
      "7:00 PM",
      "Completed",
      "green",
    ],
    ["Thursday", "Upper body", "Bench · row · accessories", "6:00 PM", "Next session", "blue"],
    ["Friday", "Recovery", "Rest or an easy walk", "Flexible", "Rest day", "neutral"],
    ["Saturday", "Recovery", "Optional mobility", "Flexible", "Rest day", "neutral"],
  ];
  return `${head("11–17 October · sample week", "A plan that fits your actual week.", "Your training routine, recovery days, and progression targets stay together.", '<button type="button" class="workspace-button" data-calendar-toggle aria-expanded="false" aria-controls="workspace-calendar-preview">View calendar preview <span aria-hidden="true">↗</span></button>')}
  <section class="workspace-panel">${panelHead("Strength & Hypertrophy", "Four gym sessions. Upper and lower body. Room to recover.", '<span class="notion-tag tag-green">Active program</span>')}<div class="notion-table-wrap"><table class="notion-table"><caption class="sr-only">Sample weekly training plan</caption><thead><tr><th scope="col">Day</th><th scope="col">Session</th><th scope="col">Focus</th><th scope="col">Time</th><th scope="col">Status</th></tr></thead><tbody>${days.map(([day, title, focus, time, status, color]) => `<tr><th scope="row" class="notion-table-name">${day}</th><td><strong>${title}</strong></td><td>${focus}</td><td>${time}</td><td><span class="notion-tag tag-${color}">${status}</span></td></tr>`).join("")}</tbody></table></div></section>
  <section id="workspace-calendar-preview" class="workspace-panel" hidden>${panelHead("Connected calendar preview", "Optional Google Calendar integration · example events.", '<span class="notion-tag tag-blue">30 min reminder</span>')}<div class="workspace-calendar">${days.map(([day, title, , time, status], index) => `<div class="workspace-calendar-day"><span>${day.slice(0, 3)}</span><strong>${11 + index}</strong>${index < 5 ? `<div class="workspace-calendar-event${index === 4 ? " is-next" : ""}"><strong>${title}</strong><small>${time}</small><small>${status}</small></div>` : '<div class="workspace-calendar-rest">Recovery</div>'}</div>`).join("")}</div><p class="notion-muted">With Calendar connected, the coach can check available slots and create, move, or cancel training events.</p></section>
  <div class="workspace-grid"><section class="workspace-panel">${panelHead("Thursday’s session", "Upper body · approximately 45–50 minutes.", '<span class="notion-tag tag-blue">Next up</span>')}<div class="workspace-detail-row"><span>Bench press</span><strong>60 kg · 3 × 10–12</strong></div><div class="workspace-detail-row"><span>Chest-supported row</span><strong>25 kg · 3 × 12</strong></div><div class="workspace-detail-row"><span>Overhead press</span><strong>30 kg · 3 × 8–10</strong></div><div class="workspace-detail-row"><span>Triceps pushdown</span><strong>20 kg · 3 × 12</strong></div><p class="notion-muted">Start with a warm-up. Adjust the session to the time, fatigue, and limitations you report.</p></section><section class="workspace-panel">${panelHead("Continuity, week to week", "Your history helps shape the next step.")}<div class="workspace-goal"><h4>Make the current load repeatable</h4><p>Your last bench session was 60 kg × 12, 12, and 10. This example plan keeps the load steady and focuses on consistent reps.</p></div>${callout("↗", "Tell the coach what changes", "Short on time or feeling fatigued? Ask for a session adjustment before you start.")}</section></div>`;
}

function library() {
  return `${head("References you can reuse", "Save once. Keep using it.", "Food labels, familiar exercises, and your program knowledge stay in your workspace.", '<span class="notion-tag tag-green">Personal libraries</span>')}
  <section class="workspace-panel">${panelHead("Food Library", "Serving values for the foods you return to.", '<span class="notion-tag tag-blue">/foodlib</span>')}<div class="notion-table-wrap"><table class="notion-table"><caption class="sr-only">Example saved Food Library entries</caption><thead><tr><th scope="col">Food</th><th scope="col">Category</th><th scope="col">Serving</th><th scope="col">Calories</th><th scope="col">Protein</th><th scope="col">Source</th></tr></thead><tbody><tr><th scope="row" class="notion-table-name">Sample whey</th><td><span class="notion-tag tag-blue">Supplements</span></td><td>1 serving · 30 g</td><td>120 kcal</td><td>24 g</td><td><span class="notion-tag tag-green">Nutrition label</span></td></tr><tr><th scope="row" class="notion-table-name">Protein shake</th><td><span class="notion-tag tag-blue">Supplements</span></td><td>1 serving · 40 g</td><td>160 kcal</td><td>30 g</td><td><span class="notion-tag tag-green">Nutrition label</span></td></tr><tr><th scope="row" class="notion-table-name">Greek yogurt</th><td><span class="notion-tag tag-blue">Packaged</span></td><td>1 pot · 170 g</td><td>100 kcal</td><td>17 g</td><td><span class="notion-tag tag-green">Nutrition label</span></td></tr><tr><th scope="row" class="notion-table-name">Vegetable pasta</th><td><span class="notion-tag tag-blue">Home-cooked</span></td><td>1 bowl</td><td>400 kcal</td><td>9 g</td><td><span class="notion-tag tag-amber">Saved estimate</span></td></tr><tr><th scope="row" class="notion-table-name">Black coffee</th><td><span class="notion-tag tag-blue">Drinks</span></td><td>1 cup</td><td>5 kcal</td><td>0 g</td><td><span class="notion-tag tag-amber">Saved estimate</span></td></tr></tbody></table></div>${callout("✦", "Serving sizes stay useful", "“Two servings of my protein shake” can reuse and scale the saved label values: 320 kcal and 60 g protein. The food and serving still need to match your saved record.")}</section>
  <div class="workspace-library-grid"><section class="workspace-knowledge-card"><span class="workspace-card-icon" aria-hidden="true">▤</span><p class="workspace-kicker">Programs & Goals</p><h4>Strength & Hypertrophy</h4><p>Your active weekly structure, training targets, equipment, and reported constraints.</p><button type="button" class="workspace-text-button" data-view="plan">View the sample plan <span aria-hidden="true">→</span></button></section><section class="workspace-knowledge-card"><span class="workspace-card-icon" aria-hidden="true">↗</span><p class="workspace-kicker">Exercise Library</p><h4>Your familiar variations</h4><p>Bench press, chest-supported rows, overhead press, and squat variations. Keep successive plans consistent.</p><details class="workspace-reference-detail"><summary>Explore saved exercises</summary><ul><li><strong>Bench press</strong><span>Barbell · chest / triceps</span></li><li><strong>Chest-supported row</strong><span>Dumbbells · upper back</span></li><li><strong>Overhead press</strong><span>Barbell · shoulders</span></li><li><strong>Back squat</strong><span>Barbell · quads / glutes</span></li></ul></details></section><section class="workspace-knowledge-card"><span class="workspace-card-icon" aria-hidden="true">⌘</span><p class="workspace-kicker">Knowledge Base</p><h4>Your program references</h4><p>Keep imported programs and reference material available for the coach to use during planning.</p><details class="workspace-reference-detail"><summary>Preview a reference</summary><p><strong>Strength & Hypertrophy program · example notes</strong></p><p>Work in the recorded rep range. Log working sets. Review consistency and reported recovery before changing the load.</p></details></section></div>`;
}

export function initWorkspaceDemo() {
  const content = document.querySelector("#workspace-content");
  const tabs = document.querySelector("#workspace-tabs");
  if (!content || !tabs || content.dataset.initialized === "true") return;
  content.dataset.initialized = "true";
  let currentWeek = "current";
  let toastTimer;
  const renderers = { dashboard, workouts: () => workouts(currentWeek), meals, plan, library };
  const tabButtons = Array.from(tabs.querySelectorAll("button[data-page]"));
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Explore the sample Notion workspace");
  tabs.setAttribute("aria-orientation", "vertical");
  content.setAttribute("role", "tabpanel");
  content.setAttribute("tabindex", "0");
  for (const button of tabButtons) {
    button.setAttribute("role", "tab");
    button.id ||= `workspace-tab-${button.dataset.page}`;
    button.setAttribute("aria-controls", "workspace-content");
  }

  function render(page, focusPanel = false) {
    if (!renderers[page]) return;
    content.innerHTML = renderers[page]();
    const activeTab = tabButtons.find((button) => button.dataset.page === page);
    for (const button of tabButtons) {
      const active = button === activeTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    if (activeTab) content.setAttribute("aria-labelledby", activeTab.id);
    const title = document.querySelector("#workspace-page-title");
    const breadcrumb = document.querySelector("#workspace-breadcrumb");
    const pageIcon = document.querySelector(".workspace-page-icon use");
    const icons = {
      dashboard: "chart",
      workouts: "weight",
      meals: "food",
      plan: "calendar",
      library: "book",
    };
    if (pageIcon) pageIcon.setAttribute("href", `#i-${icons[page]}`);
    if (title) title.textContent = pageTitles[page];
    if (breadcrumb) breadcrumb.textContent = `myGymBro / ${pageTitles[page]}`;
    if (focusPanel) content.focus({ preventScroll: true });
  }

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page]");
    if (button && tabs.contains(button)) render(button.dataset.page);
  });

  tabs.addEventListener("keydown", (event) => {
    const index = tabButtons.indexOf(event.target);
    if (index < 0) return;
    let nextIndex;
    if (event.key === "ArrowDown" || event.key === "ArrowRight")
      nextIndex = (index + 1) % tabButtons.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      nextIndex = (index + tabButtons.length - 1) % tabButtons.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabButtons.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const button = tabButtons[nextIndex];
    render(button.dataset.page);
    button.focus({ preventScroll: true });
  });

  content.addEventListener("click", (event) => {
    const view = event.target.closest("button[data-view]");
    if (view) return render(view.dataset.view, true);
    const week = event.target.closest("button[data-week]");
    if (week) {
      currentWeek = week.dataset.week;
      render("workouts");
      content.querySelector(`[data-week="${currentWeek}"]`)?.focus({ preventScroll: true });
      return;
    }
    const expand = event.target.closest("button[data-expand]");
    if (expand) {
      const detail = document.getElementById(`workout-detail-${expand.dataset.expand}`);
      if (!detail) return;
      detail.hidden = !detail.hidden;
      expand.setAttribute("aria-expanded", String(!detail.hidden));
      expand.textContent = detail.hidden ? "View sets" : "Hide sets";
      return;
    }
    const calendar = event.target.closest("button[data-calendar-toggle]");
    if (calendar) {
      const preview = document.getElementById("workspace-calendar-preview");
      if (!preview) return;
      preview.hidden = !preview.hidden;
      calendar.setAttribute("aria-expanded", String(!preview.hidden));
      calendar.innerHTML = `${preview.hidden ? "View" : "Hide"} calendar preview <span aria-hidden="true">↗</span>`;
      return;
    }
    const day = event.target.closest("button[data-heatmap-day]");
    if (day) {
      for (const button of content.querySelectorAll("[data-heatmap-day]")) {
        const active = button === day;
        button.classList.toggle("is-selected", active);
        button.setAttribute("aria-pressed", String(active));
        button.tabIndex = active ? 0 : -1;
      }
      const weekIndex = Number(day.dataset.heatmapWeek);
      const dayIndex = Number(day.dataset.heatmapDay);
      const date = new Date(heatmapStart + (weekIndex * 7 + dayIndex) * 86400000);
      const dateLabel = date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
      let detail;
      if (weekIndex === 11 && dayIndex < 3)
        detail = `${["Lower body", "Upper body", "Lower body · hypertrophy focus"][dayIndex]} · ${[52, 46, 70][dayIndex]} minutes recorded`;
      else if (weekIndex === 11 && dayIndex === 3) detail = "Upper body planned · 6:00 PM";
      else if (day.classList.contains("level-0")) detail = "No training recorded";
      else
        detail = `${activityNames[(weekIndex + dayIndex) % activityNames.length]} · recorded session`;
      const output = content.querySelector("#heatmap-detail");
      if (output) output.textContent = `${dateLabel} · ${detail}`;
    }
  });

  content.addEventListener("keydown", (event) => {
    const day = event.target.closest("button[data-heatmap-day]");
    if (!day) return;
    const days = Array.from(content.querySelectorAll("button[data-heatmap-day]"));
    const currentIndex = days.indexOf(day);
    const offsets = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 };
    let nextIndex;
    if (Object.hasOwn(offsets, event.key))
      nextIndex = Math.max(0, Math.min(days.length - 1, currentIndex + offsets[event.key]));
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = days.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    days[nextIndex].click();
    days[nextIndex].focus({ preventScroll: true });
  });

  document.addEventListener("gymbro:demo-action", (event) => {
    const detail = event.detail || {};
    const mapped = {
      workout: "workouts",
      meal: "meals",
      program: "plan",
      progress: "dashboard",
      food: "library",
      dashboard: "dashboard",
    };
    const requested = mapped[detail.suggestedView];
    if (requested) render(requested);
    const toast = document.querySelector("#workspace-toast");
    if (toast) {
      clearTimeout(toastTimer);
      toast.textContent = requested
        ? `Sample ${pageTitles[requested].toLowerCase()} opened · illustrative records`
        : "Explore the example records in your workspace preview.";
      toast.hidden = false;
      toast.setAttribute("role", "status");
      toast.classList.add("is-visible");
      toastTimer = setTimeout(() => {
        toast.classList.remove("is-visible");
        toast.hidden = true;
      }, 4500);
    }
  });

  render("dashboard");
}
