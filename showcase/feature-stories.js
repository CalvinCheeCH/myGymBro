// Scripted customer stories. These examples never call Telegram, Notion, or AI services.
const FOOD = {
  name: "Sample Whey · chocolate",
  serving: "30 g scoop",
  calories: 120,
  protein: 24,
  quantity: 1.5,
};

const STORIES = [
  {
    id: "food",
    label: "Food Library",
    icon: "food",
    promise: "The next time you eat it, the reference is already there.",
    steps: [
      {
        label: "Read the label",
        title: "One clear label. A useful starting point.",
        detail:
          "Share a readable nutrition label and confirm the serving. Save a reference for a food you actually use.",
        takeaway: "Less repeating the same nutrition details.",
        messages: [
          ["user", "Save this chocolate whey. One scoop is 30 g."],
          [
            "bot",
            "The label says 120 kcal and 24 g protein per 30 g scoop. I'll use Sample Whey · chocolate as the food name in this example.",
          ],
        ],
        visual: "label",
        note: "Fictional product and readable-label values. A meal photo on its own is still an estimate.",
      },
      {
        label: "Keep the reference",
        title: "A food record you can come back to.",
        detail:
          "The Food Library keeps serving nutrition in Notion. Your saved name, portion, and source give the next meal a consistent reference.",
        takeaway: "A reusable reference, alongside your own food history.",
        messages: [
          ["user", "Yes, save it as Sample Whey · chocolate. I haven't eaten it yet."],
          [
            "bot",
            "Saved as a food reference in this example, without logging a meal. Browse saved foods with /foodlib and reuse this serving in later meal logs.",
          ],
        ],
        visual: "food-record",
        note: "Illustrative Notion record. Nothing is saved by this webpage. A saved estimate remains an estimate.",
      },
      {
        label: "Reuse your serving",
        title: "Same food. New portion. Clear maths.",
        detail:
          "Confirm the same product and serving, then scale your saved values to what you had. No need to describe the label again.",
        takeaway: "1.5 servings → 180 kcal and 36 g protein.",
        messages: [
          ["user", "Log 1.5 servings of my chocolate whey."],
          ["bot", "The same Sample Whey · chocolate, with a 30 g scoop as one serving?"],
          ["user", "Yes, the same product and serving."],
          [
            "bot",
            "Using your saved label: 1.5 servings is 180 kcal and 36 g protein. That's the reference for this meal entry.",
          ],
        ],
        visual: "food-scale",
        note: "Scaling assumes the confirmed product and serving match. Printed values and actual portions can vary.",
      },
    ],
  },
  {
    id: "workout",
    label: "Daily workout notes",
    icon: "weight",
    promise: "Capture the work while it is fresh. Keep the session together.",
    steps: [
      {
        label: "Between sets",
        title: "Your workout doesn't need a form.",
        detail:
          "Send the lift, load, and reps in shorthand. Keep logging as the session unfolds, without rebuilding the whole workout in each message.",
        takeaway: "A short message captures the next set.",
        messages: [
          ["user", "bench 60x12"],
          ["bot", "Noted for today's workout."],
          ["user", "bench 60x12, then 60x10"],
          ["bot", "Three bench sets in today's notes: 60 kg × 12, 12, 10."],
        ],
        visual: "workout-notes",
        note: "Scripted shorthand example. Include units and enough exercise detail to avoid ambiguity.",
      },
      {
        label: "Finish the session",
        title: "The small messages become one record.",
        detail:
          "Finish your workout and the coach can organize the daily notes into the Notion Workout Log, grouped with the training week.",
        takeaway: "Sets stay together, ready for the next review.",
        messages: [
          ["user", "Done. Upper body, 46 minutes."],
          [
            "bot",
            "Sample session complete: bench 60 kg × 12, 12, 10. The session belongs together in today's Workout Log.",
          ],
        ],
        visual: "workout-record",
        note: "Illustrative session record. The real bot needs its Notion integration configured to save it.",
      },
      {
        label: "Use your history",
        title: "The next session has a reference.",
        detail:
          "Ask what happened last time. Your recorded work provides context for the next training conversation.",
        takeaway: "Less remembering. More useful context.",
        messages: [
          ["user", "What did I bench last time?"],
          ["bot", "Your last sample session has 60 kg for 12, 12, and 10 reps."],
          ["user", "My plan targets 3 × 12. What should I aim for next?"],
          [
            "bot",
            "For this 3 × 12 target, keep 60 kg and build the last set to a controlled 12 before increasing the load.",
          ],
        ],
        visual: "workout-history",
        note: "Example coaching against recorded sets and a stated target. Guidance depends on your plan, recovery, and context.",
      },
    ],
  },
  {
    id: "reports",
    label: "Training reports",
    icon: "chart",
    promise: "Turn recorded sessions into a review you can act on.",
    steps: [
      {
        label: "Review the week",
        title: "A report card for the work you logged.",
        detail:
          "Use /report for a weekly training card: training days, recorded duration, and working sets across six muscle groups, compared with the same elapsed days last week.",
        takeaway: "A clearer view of consistency and training balance.",
        messages: [
          ["user", "/report"],
          [
            "bot",
            "Here's an illustrative weekly training card: three logged training days, 142 recorded minutes, and working sets compared with the same elapsed days last week.",
          ],
        ],
        visual: "weekly-report",
        note: "Fictional training data. The card reflects recorded workouts; nutrition and body analysis belong to a separate written coaching review.",
      },
      {
        label: "Widen the view",
        title: "One week is part of a bigger pattern.",
        detail:
          "Use /report monthly to compare the latest completed calendar month with the preceding month. Average weekly sets put months of different lengths on a common scale.",
        takeaway: "Weekly and monthly views from your recorded data.",
        messages: [
          ["user", "/report monthly"],
          [
            "bot",
            "Here's a sample monthly training comparison. The radar uses average weekly sets for each muscle group: recorded sets divided by days in the month, multiplied by seven.",
          ],
        ],
        visual: "monthly-report",
        note: "Fictional completed periods. Report chart rendering uses QuickChart when the real product is configured.",
      },
      {
        label: "Choose a next step",
        title: "Make the review useful for next week.",
        detail:
          "Ask the coach for a written progress review or discuss the card. Your history can help frame a specific next priority.",
        takeaway: "A conversation grounded in the work behind the numbers.",
        messages: [
          ["user", "/progress — what's my next focus?"],
          [
            "bot",
            "You've recorded three of four planned sessions. Choose a realistic slot for the remaining session, or tell me if the week has changed so we can adjust the plan.",
          ],
        ],
        visual: "review-focus",
        note: "/report cards use a fixed report path. A written coaching conversation uses the configured AI provider.",
      },
    ],
  },
  {
    id: "progression",
    label: "Training support",
    icon: "book",
    promise: "Useful calculations and exercise context, close to the conversation.",
    steps: [
      {
        label: "Review progression",
        title: "A next load with a reason behind it.",
        detail:
          "Rule-based progression tools use logged sets to suggest a load and explain the result. The coach can discuss that result in the context of your plan.",
        takeaway: "Keep the reasoning visible, not just the number.",
        messages: [
          ["user", "My recorded bench top set is 60 kg × 6. Use a 5–8 rep range."],
          [
            "bot",
            "The sample double-progression rule holds 60 kg: 6 reps sits inside the 5–8 range. The tool gives the rule result; your coach can discuss it alongside your program and recovery.",
          ],
        ],
        visual: "progression-rule",
        note: "Illustrative rule and stated target. A suggested load is not a guarantee or a substitute for technique and recovery context.",
      },
      {
        label: "Check the maths",
        title: "Let the tools handle the arithmetic.",
        detail:
          "Ask for an estimated one-rep max or a plate breakdown. Calculations keep the arithmetic consistent while you decide what fits the session.",
        takeaway: "A rough strength reference. A practical setup check.",
        messages: [
          ["user", "Estimate my bench 1RM from 60 kg × 6. What plates make 60 kg?"],
          [
            "bot",
            "The Epley estimate is about 72 kg. For a 60 kg total with a 20 kg bar, load 20 kg of plates on each side.",
          ],
        ],
        visual: "training-maths",
        note: "Estimated 1RM is a rough reference, not a tested max. Plate availability and the actual bar weight must match.",
      },
      {
        label: "Know the movement",
        title: "Keep your exercise context close.",
        detail:
          "The personal Exercise Library stores performed variations and notes. Exercise search separately provides instructions and start/end demonstration images.",
        takeaway: "Remember the version you train, alongside useful guidance.",
        messages: [
          ["user", "I use a chest-supported row. Keep that variation in my plan."],
          [
            "bot",
            "The personal Exercise Library can keep your variation notes. Ask for an exercise demonstration when you want instructions and reference images.",
          ],
        ],
        visual: "exercise-library",
        note: "Illustrative library entry. Search demonstrations depend on the exercise service being available; no demonstration is fetched here.",
      },
    ],
  },
];

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

function metrics(items) {
  return `<div class="story-metrics">${items.map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>`;
}

function record(title, rows, footer) {
  return `<div class="story-record"><div class="story-record-heading"><span class="story-notion-mark" aria-hidden="true">N</span><strong>${title}</strong><span>Sample record</span></div><dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>${footer ? `<p class="story-record-footer">${footer}</p>` : ""}</div>`;
}

function weeklyReport() {
  const groups = [
    ["Chest", 8, 6],
    ["Back", 10, 8],
    ["Legs", 6, 5],
    ["Shoulders", 5, 4],
    ["Biceps", 7, 6],
    ["Triceps", 4, 3],
  ];
  return `<div class="story-mini-report"><div class="story-report-title"><span class="little-label">WEEKLY TRAINING CARD · SAMPLE</span><strong>A week to build on.</strong></div><div class="story-training-days" aria-label="Sample Sunday to Saturday: training logged on Monday, Wednesday and Friday">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => `<span class="${[1, 3, 5].includes(index) ? "has-session" : ""}"><i></i>${day}</span>`).join("")}</div><div class="story-duration-line"><span>142 recorded minutes</span><svg viewBox="0 0 210 30" role="img" aria-label="Sample session duration: Monday 46, Wednesday 48, Friday 48 minutes"><path d="M15 20 105 12 195 12"/><circle cx="15" cy="20" r="3"/><circle cx="105" cy="12" r="3"/><circle cx="195" cy="12" r="3"/></svg></div><div class="story-report-bars" aria-label="Working sets, this week compared with the same elapsed days last week">${groups.map(([group, current, previous]) => `<div><span>${group}</span><div><i style="--story-bar:${(previous / 12) * 100}%"></i><i style="--story-bar:${(current / 12) * 100}%"></i></div><b>${current} / ${previous}</b></div>`).join("")}</div><p class="story-chart-key"><span></span> This week <span></span> Last week · working sets</p></div>`;
}

function monthlyReport() {
  const groups = ["Chest", "Back", "Legs", "Shoulders", "Biceps", "Triceps"];
  const current = [36, 45, 30, 24, 24, 30].map((sets) => (sets / 30) * 7);
  const previous = [31, 37, 25, 22, 22, 25].map((sets) => (sets / 31) * 7);
  const points = (values) =>
    values
      .map((value, index) => {
        const angle = (index * Math.PI) / 3 - Math.PI / 2;
        const radius = (value / 12) * 75;
        return `${150 + Math.cos(angle) * radius},${110 + Math.sin(angle) * radius}`;
      })
      .join(" ");
  const description = groups
    .map(
      (group, index) =>
        `${group}: ${current[index].toFixed(1)} versus ${previous[index].toFixed(1)}`,
    )
    .join("; ");
  return `<div class="story-mini-report"><div class="story-report-title"><span class="little-label">MONTHLY TRAINING CARD · SAMPLE</span><strong>See the longer rhythm.</strong></div><svg class="story-month-radar" viewBox="0 0 300 220" role="img" aria-label="Average weekly sets, completed month versus month before. ${description}"><polygon class="story-radar-grid" points="${points([12, 12, 12, 12, 12, 12])}"/><polygon class="story-radar-grid" points="${points([6, 6, 6, 6, 6, 6])}"/><polygon class="story-radar-previous" points="${points(previous)}"/><polygon class="story-radar-current" points="${points(current)}"/><text x="150" y="21" text-anchor="middle">Chest</text><text x="229" y="73">Back</text><text x="229" y="151">Legs</text><text x="150" y="207" text-anchor="middle">Shoulders</text><text x="71" y="151" text-anchor="end">Biceps</text><text x="71" y="73" text-anchor="end">Triceps</text></svg><p class="story-chart-key"><span></span> Completed month <span></span> Month before</p><p>Average weekly sets = month sets ÷ month days × 7.</p></div>`;
}

function visual(type) {
  const scaledCalories = FOOD.calories * FOOD.quantity;
  const scaledProtein = FOOD.protein * FOOD.quantity;
  const visuals = {
    label: `<div class="story-label"><div><span class="little-label">READABLE LABEL</span><strong>${FOOD.name}</strong><span>Per serving · ${FOOD.serving}</span></div>${metrics(
      [
        [`${FOOD.calories}<small>kcal</small>`, "Energy"],
        [`${FOOD.protein}<small>g</small>`, "Protein"],
      ],
    )}<p>${icon("photo")} Printed values, confirmed serving</p></div>`,
    "food-record": record(
      "Food Library",
      [
        ["Food", FOOD.name],
        ["Serving", FOOD.serving],
        ["Energy / protein", `${FOOD.calories} kcal / ${FOOD.protein} g per serving`],
        ["Source", "Nutrition label"],
      ],
      "A reusable reference for the same confirmed food.",
    ),
    "food-scale": `<div class="story-calculation"><div class="story-confirmed">${icon("check")} Same product. Same serving reference.</div><div class="story-equation"><span>${FOOD.calories} kcal<strong>× ${FOOD.quantity}</strong></span><b>=</b><span>${scaledCalories}<small>kcal</small></span></div><div class="story-equation"><span>${FOOD.protein} g protein<strong>× ${FOOD.quantity}</strong></span><b>=</b><span>${scaledProtein}<small>g protein</small></span></div><p>45 g total · ${FOOD.quantity} × ${FOOD.serving}</p></div>`,
    "workout-notes": `<div class="story-notes"><div class="story-record-heading">${icon("message")}<strong>Today's workout notes</strong></div><div><span>01</span> Bench press <strong>60 kg × 12</strong></div><div><span>02</span> Bench press <strong>60 kg × 12</strong></div><div><span>03</span> Bench press <strong>60 kg × 10</strong></div><p>One session. Notes captured as you go.</p></div>`,
    "workout-record": record(
      "Workout Log / This week",
      [
        ["Session", "Upper body · Thursday"],
        ["Bench press", "60 kg × 12, 12, 10"],
        ["Bench volume", "2,040 kg"],
        ["Duration", "46 minutes"],
      ],
      "Daily notes organized into the week's workout record.",
    ),
    "workout-history": `<div class="story-lift-history"><span class="little-label">LAST RECORDED BENCH SESSION</span>${metrics(
      [
        ["60<small>kg</small>", "Working load"],
        ["12 / 12 / 10", "Recorded reps"],
      ],
    )}<div class="story-next-target">${icon("arrow")} <span>Next target<strong>60 kg · 12 / 12 / 12 controlled</strong></span></div></div>`,
    "weekly-report": weeklyReport(),
    "monthly-report": monthlyReport(),
    "review-focus": `<div class="story-focus"><span class="story-focus-icon">${icon("calendar")}</span><span class="little-label">A PRACTICAL NEXT PRIORITY</span><h4>Make room for the fourth session.</h4><p>Choose a time that fits. If the week changed, adjust the plan with your coach.</p><span class="story-focus-tag">Based on 3 of 4 sessions recorded</span></div>`,
    "progression-rule": `<div class="story-rule"><div><span class="little-label">EXAMPLE REP RANGE</span><strong>5–8 reps</strong></div><div><span class="little-label">RECORDED TOP SET</span><strong>60 kg × 6</strong></div><p>${icon("replay")} Hold at 60 kg. Six reps sits inside the range.</p></div>`,
    "training-maths": `<div class="story-training-maths"><div><span class="little-label">EPLEY ESTIMATE</span><strong>≈ 72<small>kg</small></strong><span>60 × (1 + 6 ÷ 30)</span></div><div><span class="little-label">60 KG BARBELL SETUP</span><div class="story-barbell" aria-hidden="true"><i></i><b></b><i></i></div><strong>20 + 20 + 20<small>kg</small></strong><span>Plates per side + bar + plates per side</span></div></div>`,
    "exercise-library": record(
      "Personal Exercise Library",
      [
        ["Exercise", "Chest-supported row"],
        ["Variation", "Chest supported · neutral grip"],
        ["Equipment", "Available row machine"],
        ["Personal note", "Keep the same setup for comparison"],
      ],
      "Personal notes can sit beside exercise instructions and reference images.",
    ),
  };
  return visuals[type];
}

export function initFeatureStories() {
  const section = document.querySelector("#feature-stories");
  if (!section || section.dataset.initialized === "true") return;
  section.dataset.initialized = "true";
  let selected = 0;
  let step = 0;
  section.innerHTML = `<div class="section-heading"><div><div class="eyebrow">SEE THE ROUTINE COME TOGETHER</div><h2 id="stories-heading">Small moments.<br />A system that remembers.</h2></div><div class="section-intro"><p>Save a familiar food. Finish a workout. Learn from the record. Explore the details that make the next conversation more useful.</p><span class="preview-label">${icon("spark")} Four stories. Three steps each.</span></div></div><div class="story-deck"><div class="story-tabs" role="tablist" aria-label="Product feature stories">${STORIES.map((story, index) => `<button type="button" id="story-tab-${story.id}" role="tab" aria-controls="story-panel" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" data-story="${index}">${icon(story.icon)}<span>${story.label}</span></button>`).join("")}</div><div class="story-deck-topline"><span class="little-label">A FEW MESSAGES. A USEFUL RESULT.</span><span class="sample-label">Scripted walkthrough</span></div><div id="story-panel" class="story-panel" role="tabpanel" tabindex="0"></div><div class="story-controls"><div class="story-step-buttons" role="group" aria-label="Walkthrough steps">${[0, 1, 2].map((index) => `<button type="button" data-story-step="${index}" aria-controls="story-panel"><span>0${index + 1}</span><span class="story-step-label"></span></button>`).join("")}</div><div class="story-arrows"><button type="button" data-story-prev aria-label="Previous walkthrough step" aria-controls="story-panel">${icon("arrow")}</button><span class="story-page-number" aria-hidden="true"></span><button type="button" data-story-next aria-label="Next walkthrough step" aria-controls="story-panel">${icon("arrow")}</button></div></div></div><p class="story-section-note">Fictional data throughout. This walkthrough stays in your browser and never reads or writes a real workspace. The running product needs its services configured.</p><div class="sr-only" data-story-status role="status" aria-live="polite"></div>`;

  const tabs = [...section.querySelectorAll("[data-story]")];
  const steps = [...section.querySelectorAll("[data-story-step]")];
  const panel = section.querySelector("#story-panel");
  const previous = section.querySelector("[data-story-prev]");
  const next = section.querySelector("[data-story-next]");
  const status = section.querySelector("[data-story-status]");

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => {
      selected = index;
      step = 0;
      render(true);
    });
    tab.addEventListener("keydown", (event) => {
      let target;
      if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") target = 0;
      if (event.key === "End") target = tabs.length - 1;
      if (target === undefined) return;
      event.preventDefault();
      tabs[target].click();
      tabs[target].focus({ preventScroll: true });
    });
  }
  for (const [index, button] of steps.entries()) {
    button.addEventListener("click", () => {
      step = index;
      render(true);
    });
  }
  previous.addEventListener("click", () => {
    if (step > 0) step -= 1;
    render(true);
  });
  next.addEventListener("click", () => {
    if (step < STORIES[selected].steps.length - 1) step += 1;
    render(true);
  });

  function render(announce) {
    const story = STORIES[selected];
    const current = story.steps[step];
    for (const [index, tab] of tabs.entries()) {
      const active = index === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `story-tab-${story.id}`);
    panel.innerHTML = `<div class="story-copy"><span class="story-number">0${step + 1}<span>/ 03</span></span><div class="story-stage-label">${story.label} · ${current.label}</div><h3>${current.title}</h3><p>${current.detail}</p><div class="story-takeaway">${icon("check")}<strong>${current.takeaway}</strong></div><p class="story-promise">${story.promise}</p></div><div class="story-demo"><div class="story-chat-heading"><span class="story-chat-avatar">${icon("weight")}</span><strong>myGymBro<span>Example conversation with Alex</span></strong><span class="story-local-tag">Sample</span></div><div class="story-chat-messages">${current.messages.map(([role, text]) => `<div class="story-message story-message-${role}"><span>${role === "user" ? "Alex" : "myGymBro"}</span><p>${text}</p></div>`).join("")}</div><div class="story-artifact">${visual(current.visual)}</div><p class="story-visual-note">${current.note}</p></div>`;
    for (const [index, button] of steps.entries()) {
      button.setAttribute("aria-pressed", String(index === step));
      button.querySelector(".story-step-label").textContent = story.steps[index].label;
      button.setAttribute("aria-label", `Step ${index + 1}: ${story.steps[index].label}`);
    }
    previous.disabled = step === 0;
    next.disabled = step === story.steps.length - 1;
    section.querySelector(".story-page-number").textContent = `${step + 1} / 3`;
    if (announce) status.textContent = `${story.label}. Step ${step + 1} of 3: ${current.title}`;
  }
  render(false);
}
