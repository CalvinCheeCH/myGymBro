// Illustrative persona previews. These share the same facts and next steps;
// choosing a voice here does not change a real Telegram conversation.
const PERSONAS = [
  {
    id: "batman",
    name: "Batman",
    shortName: "Batman",
    tagline: "Disciplined. Direct. Every rep counts.",
    style: "Terse, focused phrasing with dry humour.",
    label: "Disciplined & direct",
  },
  {
    id: "arnold",
    name: "Arnold",
    shortName: "Arnold",
    tagline: "Big energy. A coach in your corner.",
    style: "Warm, enthusiastic encouragement with bodybuilding energy.",
    label: "Big encouragement",
  },
  {
    id: "yoda",
    name: "Yoda",
    shortName: "Yoda",
    tagline: "Patience, practice, and a little wisdom.",
    style: "Calm, patient phrasing with a recognisable twist in sentence order.",
    label: "Calm & wise",
  },
  {
    id: "sherlock",
    name: "Sherlock Holmes",
    shortName: "Sherlock",
    tagline: "Your training data is the evidence.",
    style: "Precise, analytical language that follows the clues in your data.",
    label: "Precise & analytical",
  },
  {
    id: "stark",
    name: "Tony Stark",
    shortName: "Stark",
    tagline: "Sharp advice. A sharper sense of humour.",
    style: "Quick, confident wit and friendly teasing.",
    label: "Witty & confident",
  },
  {
    id: "gandalf",
    name: "Gandalf",
    shortName: "Gandalf",
    tagline: "Make steady progress on your quest.",
    style: "Warm, grand phrasing that turns your plan into a quest.",
    label: "Wise & theatrical",
  },
  {
    id: "dwight",
    name: "Dwight Schrute",
    shortName: "Dwight",
    tagline: "Facts first. Follow the plan.",
    style: "Literal, matter-of-fact statements with intense commitment.",
    label: "Facts & discipline",
  },
  {
    id: "sparrow",
    name: "Captain Jack Sparrow",
    shortName: "Sparrow",
    tagline: "A little mischief. A clear course.",
    style: "Playful, roguish phrasing with sailing metaphors.",
    label: "Playful & roguish",
  },
  {
    id: "normal",
    name: "Normal coach",
    shortName: "Normal",
    tagline: "Simple, practical coaching in a plain voice.",
    style: "Clear, straightforward coaching without a character overlay.",
    label: "Clear & practical",
    icon: "weight",
  },
  {
    id: "custom",
    name: "Your own coach",
    shortName: "Custom",
    tagline: "Name your coach. Choose the tone.",
    style: "A custom persona lets you describe how you want your coach to speak.",
    label: "Make it yours",
    icon: "spark",
  },
];

const SCENARIOS = {
  training: {
    label: "Training",
    question: "I benched 60 kg for 12, 12, and 10 reps. Go heavier next time?",
    fact: "60 kg · 12 / 12 / 10 reps",
    replies: {
      batman:
        "60 kg. Keep it there. You hit 12, 12, and 10 reps. Make all three sets a controlled 12 before you add weight. Earn the increase.",
      arnold:
        "My friend, 60 kg for 12, 12, and 10 reps is solid work! Stay at 60 kg and build that last set to a controlled 12. Three strong sets of 12 first, then we go heavier!",
      yoda: "At 60 kg, 12, 12, and 10 reps you completed. Keep this weight, you should. Three controlled sets of 12, build first. Then, heavier you may go.",
      sherlock:
        "Observe: at 60 kg, your sets were 12, 12, and 10 reps. The last set is the clue. Keep 60 kg until all three sets reach a controlled 12, then consider increasing the load.",
      stark:
        "60 kg for 12, 12, and 10. Good work, but the third set hasn't signed off on the upgrade. Keep 60 kg until you own three controlled sets of 12. Then we talk heavier.",
      gandalf:
        "You have carried 60 kg for 12, 12, and 10 reps. Hold this weight a little longer. Complete three controlled sets of 12, and the path to a heavier load will open.",
      dwight:
        "Fact: 60 kg produced 12, 12, and 10 reps. The final set did not reach 12. Maintain 60 kg until all three sets reach a controlled 12. Then increase. Efficient.",
      sparrow:
        "60 kg for 12, 12, and 10, mate. Almost a full crew! Keep the cargo at 60 kg until all three sets land at a controlled 12. Then we sail heavier. Savvy?",
      normal:
        "Keep 60 kg for now. Your sets were 12, 12, and 10 reps. Aim for three controlled sets of 12 before increasing the weight.",
    },
  },
  nutrition: {
    label: "Nutrition",
    question: "I've logged 112 g of protein today. My target is 140 g. What's left?",
    fact: "112 g logged / 140 g target · 28 g remaining",
    replies: {
      batman:
        "112 g logged. Target: 140 g. You have 28 g left. Choose a protein serving that fits your remaining meals. Close the gap.",
      arnold:
        "You've logged 112 g toward your 140 g target, my friend! That leaves 28 g. A protein serving with your next meal can help close the gap. Finish strong!",
      yoda: "112 g logged, toward 140 g you are. 28 g remain. With your next meal, a protein serving you can choose. Steady progress, this is.",
      sherlock:
        "The arithmetic is straightforward: 140 g minus 112 g leaves 28 g. A protein serving in your remaining meals can close that gap. Work from your logged totals.",
      stark:
        "112 g logged, 140 g target. That leaves 28 g. No reactor needed; a protein serving with your next meal can help finish the job.",
      gandalf:
        "112 g is recorded on today's journey toward 140 g. Just 28 g remain. A protein serving with a remaining meal can help you reach the day's target.",
      dwight:
        "Fact: your target is 140 g. You logged 112 g. Remaining: 28 g. Include a protein serving in your remaining meals to close the gap. Arithmetic complete.",
      sparrow:
        "112 g aboard, a 140 g destination. That leaves 28 g, mate! Find a protein serving in your remaining meals and steer toward the target.",
      normal:
        "You have 28 g remaining: 140 g target minus 112 g logged. A protein serving with your next meal can help close the gap.",
    },
  },
  motivation: {
    label: "Motivation",
    question:
      "I've done 3 of my 4 planned sessions this week. I'm struggling to finish the last one.",
    fact: "3 of 4 planned sessions completed · 1 remaining",
    replies: {
      batman:
        "Three of four sessions done. One remains. Pick a realistic time for that last planned session. If your week has changed, tell me and we'll adjust the plan. Keep showing up.",
      arnold:
        "Three of four sessions already done, my friend! You've put in the work. Pick a realistic time for the one remaining session. If the week has changed, tell me and we'll adjust the plan. You've got this!",
      yoda: "Three of four sessions, completed you have. One remains. A realistic time, choose for it. Changed your week has? Tell me, and adjust the plan we will. Steady, keep going.",
      sherlock:
        "The evidence: three of four planned sessions are complete. One remains. Choose a realistic time for it; if your circumstances have changed, tell me so we can adjust the plan accordingly.",
      stark:
        "Three out of four sessions done. That's actual progress. Pick a realistic slot for the one left. If life rewrote your calendar, tell me and we'll adjust the plan. Even good systems need updates.",
      gandalf:
        "Three of your four planned sessions are behind you; one remains on the path. Choose a realistic time for it. If the week's journey has changed, tell me and we shall adjust the plan.",
      dwight:
        "Fact: three of four sessions are complete. One remains. Assign a realistic time to that session. If the week has changed, report it so we can adjust the plan. Proceed methodically.",
      sparrow:
        "Three of four sessions in the log, mate. Just one more port! Pick a realistic time for it. If the week's winds have changed, tell me and we'll adjust the plan. Keep your course.",
      normal:
        "You've completed three of four planned sessions, with one remaining. Pick a realistic time for it. If your week has changed, tell me and we can adjust the plan.",
    },
  },
};

const CUSTOM_TONES = {
  supportive: {
    label: "Supportive",
    description: "Warm, encouraging phrasing with a practical next step.",
    replies: {
      training:
        "You're making progress: 60 kg for 12, 12, and 10 reps. Stay at 60 kg and aim for three controlled sets of 12 before going heavier. Build that last set one rep at a time.",
      nutrition:
        "You've logged 112 g toward your 140 g target. Just 28 g remain. A protein serving with your next meal can help close the gap. You're well on your way.",
      motivation:
        "You've already completed three of four planned sessions. One remains. Pick a realistic time for it. If your week has changed, tell me and we'll adjust the plan together.",
    },
  },
  direct: {
    label: "Direct",
    description: "Concise, direct phrasing with the next step up front.",
    replies: {
      training:
        "Keep 60 kg. Your sets were 12, 12, and 10 reps. Complete three controlled sets of 12 before increasing the load.",
      nutrition:
        "28 g remain. You logged 112 g against a 140 g target. Choose a protein serving with your remaining meals to close the gap.",
      motivation:
        "Three of four sessions complete. One remains. Choose a realistic time for it. If your week has changed, tell me and we'll adjust the plan.",
    },
  },
  playful: {
    label: "Playful",
    description: "Light, friendly humour with clear, practical guidance.",
    replies: {
      training:
        "60 kg for 12, 12, and 10 reps. The last set is still catching up! Keep 60 kg until you get three controlled sets of 12, then level up the load.",
      nutrition:
        "112 g logged, 140 g target. Just 28 g to go! A protein serving with your next meal can help fill that final square on today's scorecard.",
      motivation:
        "Three of four sessions checked off. One box left! Give it a realistic time slot. If the week has changed, tell me and we'll adjust the plan to fit.",
    },
  },
  oldschool: {
    label: "Old-school",
    description: "Steady, plain coaching with warmth and practical advice.",
    replies: {
      training:
        "Good work at 60 kg: 12, 12, and 10 reps. Keep the weight at 60 kg and build up to three controlled sets of 12 before increasing it. A solid foundation comes first.",
      nutrition:
        "You've logged 112 g of protein against a 140 g target, so 28 g remain. Include a protein serving in your remaining meals to help close the gap. Keep it simple and steady.",
      motivation:
        "You've completed three of your four planned sessions. One remains. Find a realistic time for that last session. If your week has changed, tell me and we'll adjust the plan. Steady effort adds up.",
    },
  },
  millennial: {
    label: "Millennial",
    description: "Dry, relatable humour for a busy life, with clear next steps.",
    replies: {
      training:
        "60 kg for 12, 12, and 10 reps. The third set has one more thing on its to-do list. Stay at 60 kg until all three sets reach a controlled 12, then increase the load. One project at a time.",
      nutrition:
        "112 g logged, 140 g target: 28 g left. Add a protein serving to your remaining meals to help close the gap. One less open tab in your brain.",
      motivation:
        "Three of four sessions done. One left, alongside everything else in your calendar. Pick a realistic slot for it. If the week has changed, tell me and we'll adjust the plan. Your schedule doesn't need another plot twist.",
    },
  },
  hype: {
    label: "Hype",
    description: "Big energy and concise encouragement, grounded in your plan.",
    replies: {
      training:
        "LET'S GO! 60 kg for 12, 12, and 10 reps. Keep 60 kg and build to three controlled sets of 12 before increasing the load. You've got a clear next target!",
      nutrition:
        "112 g logged toward 140 g. Just 28 g left! A protein serving in your remaining meals can help close the gap. Finish your day strong!",
      motivation:
        "Three of four sessions DONE! One remains. Pick a realistic time for that last session. If the week has changed, tell me and we'll adjust the plan. Keep that momentum going!",
    },
  },
  brainrot: {
    label: "Brainrot",
    description: "Meme-heavy chat energy, with the actual coaching kept readable.",
    replies: {
      training:
        "Chat, 60 kg for 12, 12, and 10 reps. Third set is buffering 💀 Keep 60 kg until all three sets hit a controlled 12, then increase the load. Lock in on the reps; the upgrade can wait.",
      nutrition:
        "Protein side quest: 112 g logged / 140 g target. 28 g left 🫡 A protein serving in your remaining meals can help close the gap. The maths has aura.",
      motivation:
        "Chat, three of four sessions are done. One side quest left 🫡 Pick a realistic time for it. If your week has changed, tell me and we'll adjust the plan. Lock in a slot that actually fits.",
    },
  },
  zen: {
    label: "Zen",
    description: "Calm, reflective guidance that brings you back to the next step.",
    replies: {
      training:
        "Take a breath and look at the work: 60 kg for 12, 12, and 10 reps. Stay at 60 kg until all three sets reach a controlled 12 before increasing the load. Give steady progress room to happen.",
      nutrition:
        "You've logged 112 g toward your 140 g protein target. That leaves 28 g. A protein serving in your remaining meals can help close the gap. Focus on the next meal, one step at a time.",
      motivation:
        "Three of your four planned sessions are complete. One remains. Choose a realistic time for it. If your week has changed, tell me and we'll adjust the plan. Make room for what fits today.",
    },
  },
};

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function portrait(persona, className = "persona-portrait") {
  const wrapper = make("span", className);
  wrapper.setAttribute("aria-hidden", "true");
  if (persona.icon) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${persona.icon}`);
    svg.append(use);
    wrapper.append(svg);
  } else {
    const img = make("img");
    img.src = `./assets/personas/${persona.id}.png`;
    img.alt = "";
    img.width = 128;
    img.height = 128;
    img.decoding = "async";
    img.addEventListener(
      "error",
      () => {
        wrapper.classList.add("persona-portrait-fallback");
        wrapper.textContent = persona.shortName.slice(0, 1);
      },
      { once: true },
    );
    wrapper.append(img);
  }
  return wrapper;
}

function message(role, sender, content) {
  const node = make("div", `persona-message ${role}`);
  const bubble = make("div", "persona-message-body");
  bubble.append(
    make("span", "persona-message-sender", sender),
    make("p", "persona-message-text", content),
  );
  node.append(bubble);
  return node;
}

export function initPersonaDemo() {
  const section = document.querySelector("#personas");
  if (!section || section.dataset.personaInitialized === "true") return;
  const options = section.querySelector("#persona-options");
  const conversation = section.querySelector("#persona-conversation");
  if (!options || !conversation) return;
  section.dataset.personaInitialized = "true";

  let selected = "batman";
  let scenario = "training";
  let customName = "My coach";
  let customTone = "supportive";
  const buttons = [];
  const panel = section.querySelector("#persona-preview-panel");
  const status = section.querySelector("#persona-change-status");
  const customPanel = section.querySelector("#persona-custom-panel");
  const customForm = section.querySelector("#persona-custom-form");

  options.replaceChildren();
  for (const persona of PERSONAS) {
    const button = make("button", "persona-tile");
    button.type = "button";
    button.id = `persona-tab-${persona.id}`;
    button.dataset.persona = persona.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "persona-preview-panel");
    button.setAttribute("aria-label", `${persona.name}: ${persona.label}`);
    const copy = make("span", "persona-tile-copy");
    copy.append(
      make("strong", "persona-tile-name", persona.shortName),
      make("span", "persona-tile-description", persona.label),
    );
    const check = make("span", "persona-tile-check", "✓");
    check.setAttribute("aria-hidden", "true");
    button.append(portrait(persona), copy, check);
    button.addEventListener("click", () => {
      selected = persona.id;
      render(true);
    });
    button.addEventListener("keydown", (event) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const currentIndex = buttons.indexOf(button);
      let nextIndex = currentIndex;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = buttons.length - 1;
      else {
        const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        nextIndex = (currentIndex + direction + buttons.length) % buttons.length;
      }
      selected = PERSONAS[nextIndex].id;
      render(true);
      buttons[nextIndex].focus();
    });
    buttons.push(button);
    options.append(button);
  }

  const scenarioButtons = section.querySelectorAll("[data-persona-scenario]");
  for (const button of scenarioButtons) {
    button.addEventListener("click", () => {
      if (!SCENARIOS[button.dataset.personaScenario]) return;
      scenario = button.dataset.personaScenario;
      render(true);
    });
  }

  if (customForm) {
    const updateCustomPreview = () => {
      const nameField = section.querySelector("#persona-custom-name");
      const toneField = section.querySelector("#persona-custom-tone");
      customName = nameField?.value.trim().slice(0, 30) || "My coach";
      customTone = CUSTOM_TONES[toneField?.value] ? toneField.value : "supportive";
      selected = "custom";
      render(false);
      if (status)
        status.textContent = `${customName} preview updated with a ${CUSTOM_TONES[customTone].label} tone. This sample stays in this page; your Telegram coach is unchanged.`;
    };
    customForm.addEventListener("submit", (event) => {
      event.preventDefault();
      updateCustomPreview();
    });
    section.querySelector("#persona-custom-tone")?.addEventListener("change", updateCustomPreview);
  }

  function render(announce) {
    const persona = PERSONAS.find((item) => item.id === selected);
    const example = SCENARIOS[scenario];
    const isCustom = selected === "custom";
    const displayName = isCustom ? customName : persona.name;
    const tone = CUSTOM_TONES[customTone];

    for (const button of buttons) {
      const active = button.dataset.persona === selected;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const button of scenarioButtons) {
      const active = button.dataset.personaScenario === scenario;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (panel) panel.setAttribute("aria-labelledby", `persona-tab-${selected}`);

    const setText = (id, text) => {
      const node = section.querySelector(`#${id}`);
      if (node) node.textContent = text;
    };
    setText("persona-name", displayName);
    setText(
      "persona-tagline",
      isCustom ? `${tone.label} tone. Your own coach name.` : persona.tagline,
    );
    setText("persona-style-description", isCustom ? tone.description : persona.style);
    setText("persona-command", isCustom ? "/create" : `/persona ${persona.id}`);
    const avatar = section.querySelector("#persona-selected-avatar");
    if (avatar) avatar.replaceChildren(portrait(persona, "persona-selected-portrait"));
    if (customPanel) customPanel.hidden = !isCustom;
    const reply = isCustom ? tone.replies[scenario] : example.replies[selected];
    conversation.replaceChildren(
      make("div", "persona-chat-day", "Sample conversation"),
      message("user", "You", example.question),
      message("bot", displayName, reply),
      make("p", "persona-chat-facts", example.fact),
    );
    if (announce && status) {
      status.textContent = `${displayName} selected. ${example.label} sample updated. Your history, goals and coaching guidance stay the same.`;
    }
  }

  render(false);
}
