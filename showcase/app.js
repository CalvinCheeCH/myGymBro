import { initChatDemo } from "./chat-demo.js";
import { initPersonaDemo } from "./persona-demo.js";
import { initWorkspaceDemo } from "./workspace-demo.js";

const features = {
  training: {
    icon: "weight",
    label: "TRAINING THAT BUILDS ON YOUR HISTORY",
    title: "Your next session has context.",
    description: "What you did last time helps shape what you do today.",
    scenario: "workout",
    cta: "Try workout logging",
    items: [
      [
        "Log between sets",
        "Capture exercises, reps, and loads through shorthand messages. Finish the session to organize it in your weekly record.",
      ],
      [
        "Know what to train",
        "Ask /today for a session grounded in your goals, equipment, active plan, and recent logs.",
      ],
      [
        "Find a movement",
        "Search exercises by muscle, equipment, or experience level, with instructions and start/end demonstration images.",
      ],
      [
        "Useful training math",
        "Rule-based load suggestions, estimated one-rep max, and a plate calculator support the next decision.",
      ],
    ],
  },
  nutrition: {
    icon: "food",
    label: "FOOD THAT FITS YOUR EVERYDAY LIFE",
    title: "Your everyday meals count.",
    description: "Familiar food, realistic portions, and a clear view of your recorded day.",
    scenario: "meal",
    cta: "Try a meal conversation",
    items: [
      [
        "Meals in your own words",
        "Describe a rice bowl, sandwich, or dinner in English. Add portions, ingredients, and preparation for a more useful estimate.",
      ],
      [
        "A photo is a starting point",
        "Show your plate or a readable label. Meal estimates use ranges and can improve with your portion context.",
      ],
      [
        "Daily totals against targets",
        "See recorded calories and protein against your targets, with meals organized by time of day.",
      ],
      [
        "A library you keep using",
        "Save serving nutrition for familiar foods, browse with /foodlib, and reuse values in later logs.",
      ],
    ],
  },
  planning: {
    icon: "calendar",
    label: "A PLAN WITH ROOM FOR REAL LIFE",
    title: "Your week has a training rhythm.",
    description: "Turn goals and recent activity into a plan you can revisit.",
    scenario: "plan",
    cta: "Try weekly planning",
    items: [
      [
        "A week saved in Notion",
        "Build a weekly plan with familiar lifts and progression targets, beside your completed sessions.",
      ],
      [
        "Constraints are part of the plan",
        "Tell the coach about equipment, limited time, fatigue, or reported limitations so recommendations can adapt.",
      ],
      [
        "A place in your calendar",
        "With Google Calendar connected, check commitments and create, move, or cancel training events.",
      ],
      [
        "Your program stays relevant",
        "Import training programs and reference material. The personal Exercise Library keeps your variations consistent.",
      ],
    ],
  },
  progress: {
    icon: "chart",
    label: "A CLEARER VIEW OF THE WORK",
    title: "Your record shows the pattern.",
    description: "Review the details and choose a useful next priority.",
    scenario: "progress",
    cta: "Try a progress review",
    items: [
      [
        "Weekly report cards",
        "See recorded nutrition against targets and training balance compared with the previous week.",
      ],
      [
        "The actual session details",
        "Review sets, reps, loads, and training trends, with a detailed weekly recap alongside the coach's assessment.",
      ],
      [
        "Consistency at a glance",
        "Training calendar heatmaps help you spot the weeks you showed up and the gaps you want to address.",
      ],
      [
        "Body check-ins alongside training",
        "Record bodyweight and measurements. Your goals and current program remain visible in the Dashboard.",
      ],
    ],
  },
  accountability: {
    icon: "bell",
    label: "A REGULAR REASON TO CHECK IN",
    title: "The coach can start the conversation.",
    description: "Configured reminders make space for the next workout and weekly review.",
    scenario: "progress",
    cta: "See a weekly review",
    items: [
      [
        "A daily check-in",
        "The default 11:00 nudge reviews yesterday's logged coverage and discusses today's session.",
      ],
      [
        "A Sunday review",
        "The default 18:00 review combines report cards, next week's plan, and a bodyweight prompt.",
      ],
      [
        "Your own reminders",
        "Add custom coaching prompts in supported deployment modes. Scheduling uses your configured timezone.",
      ],
      [
        "Phone reminders for sessions",
        "Optional Google Calendar events support recurring slots and native reminders, defaulting to 30 minutes before training.",
      ],
    ],
  },
  personalization: {
    icon: "spark",
    label: "YOUR GOALS. YOUR WAY OF USING IT.",
    title: "A coach that fits your preferences.",
    description: "Choose how you communicate, organize the record, and run the product.",
    scenario: "personas",
    cta: "Try coach personalities",
    items: [
      [
        "Your profile comes first",
        "Goals, dietary preferences, equipment, and schedule provide context for coaching. Missing information can be clarified.",
      ],
      [
        "Choose your coaching personality",
        "Pick Batman’s direct focus, Arnold’s encouragement, or your own custom tone. Your recorded history still guides the coaching.",
      ],
      [
        "An organized personal workspace",
        "Setup creates or repairs your Notion databases, Dashboard, Knowledge Base, and Training Calendar.",
      ],
      [
        "Controls for your own setup",
        "Supported Claude, Gemini, or OpenAI engines, local or cloud hosting, transcription choices, allowlisted Telegram access, and reset previews.",
      ],
    ],
  },
};

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

function initFeatures() {
  const tabs = [...document.querySelectorAll("#feature-tabs [data-feature]")];
  const content = document.querySelector("#feature-content");
  function select(key) {
    const feature = features[key];
    if (!feature) return;
    for (const tab of tabs) {
      const active = tab.dataset.feature === key;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.id = `feature-tab-${tab.dataset.feature}`;
      tab.setAttribute("aria-controls", "feature-content");
    }
    content.setAttribute("aria-labelledby", `feature-tab-${key}`);
    content.innerHTML = `<div class="feature-focus">${icon(feature.icon)}<span class="little-label">${feature.label}</span><h3>${feature.title}</h3><p>${feature.description}</p><button type="button" class="feature-try" data-try-scenario="${feature.scenario}">${feature.cta} ${icon("arrow")}</button></div><div class="feature-items">${feature.items.map(([title, description], index) => `<article class="feature-item"><span class="feature-item-number">0${index + 1}</span><h4>${title}</h4><p>${description}</p></article>`).join("")}</div>`;
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab.dataset.feature));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next].dataset.feature);
      tabs[next].focus({ preventScroll: true });
    });
  }
  content.addEventListener("click", (event) => {
    const button = event.target.closest("[data-try-scenario]");
    if (!button) return;
    if (button.dataset.tryScenario === "personas") {
      document.querySelector("#personas").scrollIntoView({ block: "start" });
      document
        .querySelector("#persona-options [aria-selected='true']")
        .focus({ preventScroll: true });
      return;
    }
    document
      .querySelector(`#scenario-tabs [data-scenario="${button.dataset.tryScenario}"]`)
      ?.click();
    document.querySelector("#demo").scrollIntoView({ block: "start" });
    document.querySelector("#chat-input").focus({ preventScroll: true });
  });
  select("training");
}

function initNavigation() {
  const toggle = document.querySelector("#menu-toggle");
  const nav = document.querySelector("#primary-nav");
  const close = () => {
    nav.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open navigation");
    toggle.querySelector("use").setAttribute("href", "#i-menu");
  };
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    toggle.querySelector("use").setAttribute("href", open ? "#i-close" : "#i-menu");
  });
  for (const link of nav.querySelectorAll("a")) {
    link.addEventListener("click", close);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("is-open")) {
      close();
      toggle.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!nav.contains(event.target) && !toggle.contains(event.target)) close();
  });
  for (const link of document.querySelectorAll("[data-workspace-link]")) {
    link.addEventListener("click", () => {
      document
        .querySelector(`#workspace-tabs [data-page="${link.dataset.workspaceLink}"]`)
        ?.click();
    });
  }
  const order = ["workout", "meal", "plan", "progress", "food", "voice"];
  document.addEventListener("gymbro:demo-action", (event) => {
    const index = order.indexOf(event.detail.scenario);
    if (index >= 0) document.querySelector(".demo-counter").textContent = `0${index + 1} / 06`;
  });
}

initNavigation();
initWorkspaceDemo();
initChatDemo();
initFeatures();
initPersonaDemo();
