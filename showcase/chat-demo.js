import { CHAT_SCENARIOS, QUICK_RESPONSES } from "./demo-data.js";

const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const shortTime = () =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

function responseFor(input, scenario) {
  const text = input.toLowerCase().trim();
  if (/\b(last time|previous|last session)\b/.test(text)) return QUICK_RESPONSES.history;
  if (/\bdone\b|finish(ed)?\b/.test(text)) return QUICK_RESPONSES.done;
  if (/\bbench\b.*\d+\s*(?:kg\s*)?[x×]\s*\d+/i.test(text)) {
    const set = text.match(/\bbench\b\s*(\d+(?:\.\d+)?)\s*(?:kg\s*)?[x×]\s*(\d+)/i);
    if (
      set &&
      Number(set[1]) > 0 &&
      Number(set[1]) <= 500 &&
      Number(set[2]) > 0 &&
      Number(set[2]) <= 100
    ) {
      return {
        text: `Noted. Sample set: bench press · ${set[1]} kg × ${set[2]} reps.`,
      };
    }
    return QUICK_RESPONSES.bench;
  }
  if (/\b(transcript|transcription)\b/.test(text)) return QUICK_RESPONSES.transcript;
  if (/\b(photos?|pictures?|pdf)\b/.test(text)) return QUICK_RESPONSES.photos;
  if (/\b(foodlib|food library|library)\b/.test(text)) return QUICK_RESPONSES.library;
  if (/\bremember\b/.test(text)) return QUICK_RESPONSES.remember;
  if (/\b2\s*(servings?|scoops?)\b/.test(text)) return QUICK_RESPONSES.servings;
  if (/\b(protein)\b.*\b(left|remaining)\b|\b(left|remaining)\b.*\bprotein\b/.test(text))
    return QUICK_RESPONSES.protein;
  if (/\b(30|thirty)\b.*\b(min|minutes)\b/.test(text)) return QUICK_RESPONSES.shortSession;
  if (/\b(progress|increase)\b.*\bbench\b|\bbench\b.*\b(progress|increase)\b/.test(text))
    return QUICK_RESPONSES.progression;
  if (/\b(improve|improved|improvement)\b/.test(text)) return QUICK_RESPONSES.improvement;
  if (/\b(priority|focus|next priority)\b/.test(text)) return QUICK_RESPONSES.priority;
  if (/\/progress\b|\b(report|progress|weekly review)\b/.test(text))
    return QUICK_RESPONSES.progress;
  if (/\/today\b|\btrain today\b|\bworkout today\b/.test(text)) return QUICK_RESPONSES.today;
  if (/\bdinner\b/.test(text)) {
    if (scenario === "voice" && /\blog\b/.test(text)) return CHAT_SCENARIOS.voice.messages[3];
    return QUICK_RESPONSES.dinner;
  }
  if (/\b(meal|lunch|food)\b/.test(text)) return QUICK_RESPONSES.meal;
  if (/\/plan\b|\bweekly plan\b/.test(text)) return CHAT_SCENARIOS.plan.messages[1];
  return QUICK_RESPONSES.fallback;
}

function messageNode(message) {
  const node = make("div", `message ${message.role}`);
  const avatar = make("span", "message-avatar", message.role === "bot" ? "G" : "C");
  avatar.setAttribute("aria-hidden", "true");
  const body = make("div", "message-body");
  if (message.attachment) {
    const attachment = make("div", `message-attachment ${message.attachment.kind}`);
    const illustration = make("div", "attachment-illustration");
    illustration.setAttribute("aria-hidden", "true");
    if (message.attachment.kind === "meal") {
      illustration.append(make("span", "attachment-food", "🍛"));
    } else {
      illustration.append(make("span", "attachment-label-heading", "Nutrition Facts"));
      illustration.append(make("span", "attachment-label-rule"));
      illustration.append(make("span", "attachment-label-value", "120 kcal · 24 g protein"));
    }
    attachment.append(
      illustration,
      make("strong", "attachment-title", message.attachment.title),
      make("span", "attachment-caption", message.attachment.caption),
    );
    body.append(attachment);
  }
  if (message.voice) {
    const voice = make("div", "voice-note");
    voice.setAttribute(
      "aria-label",
      `${message.voice.label}, ${message.voice.duration}. Illustrative waveform; no audio recording.`,
    );
    const icon = make("span", "voice-icon", "♫");
    icon.setAttribute("aria-hidden", "true");
    const bars = make("span", "voice-waveform");
    bars.setAttribute("aria-hidden", "true");
    for (const height of [12, 22, 15, 30, 20, 34, 14, 26, 18, 30, 22, 12, 27, 18, 32, 21, 13, 24]) {
      const bar = make("i", "voice-bar");
      bar.style.setProperty("--bar-height", `${height}px`);
      bar.style.height = `${height}px`;
      bars.append(bar);
    }
    voice.append(icon, bars, make("span", "voice-duration", message.voice.duration));
    body.append(voice, make("span", "voice-caption", message.voice.label));
  }
  body.append(make("p", "message-text", message.text));
  if (message.card) {
    const card = make("div", "message-card");
    card.append(make("h4", "message-card-title", message.card.title));
    const rows = make("dl", "message-card-rows");
    for (const [label, value] of message.card.rows) {
      const row = make("div", "message-card-row");
      row.append(make("dt", "message-card-label", label), make("dd", "message-card-value", value));
      rows.append(row);
    }
    card.append(rows);
    if (message.card.footer) card.append(make("p", "message-card-footer", message.card.footer));
    body.append(card);
  }
  const time = make("span", "message-time", message.time || shortTime());
  time.setAttribute("aria-hidden", "true");
  body.append(time);
  node.append(avatar, body);
  return node;
}

export function initChatDemo() {
  const root = document.querySelector("#chat-demo");
  const messages = document.querySelector("#chat-messages");
  if (!root || !messages || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";
  const tabs = [...document.querySelectorAll("#scenario-tabs [data-scenario]")];
  const prompts = document.querySelector("#chat-prompts");
  const form = document.querySelector("#chat-form");
  const input = document.querySelector("#chat-input");
  const send = document.querySelector("#chat-send");
  const replay = document.querySelector("#chat-replay");
  const status = document.querySelector("#chat-status");
  const title = document.querySelector("#chat-scenario-title");
  const description = document.querySelector("#chat-scenario-description");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let activeScenario = "workout";
  let actionToken = 0;
  let timer;
  let typingNode;
  let busy = false;
  let userMessages = 0;
  const maxUserMessages = 12;

  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  messages.setAttribute("aria-relevant", "additions");
  messages.setAttribute("aria-label", "Sample Telegram conversation");
  if (status) {
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
  }
  if (input) {
    input.maxLength = 240;
    if (!input.hasAttribute("aria-label")) input.setAttribute("aria-label", "Try a sample message");
  }

  function updateStatus(text) {
    if (status) status.textContent = text;
  }

  function scrollBottom() {
    // Keep the page still: only the conversation pane follows its latest bubble.
    messages.scrollTop = messages.scrollHeight;
  }

  function appendMessage(message) {
    messages.append(messageNode(message));
    scrollBottom();
  }

  function emitAction(action, typedInput = "") {
    root.dispatchEvent(
      new CustomEvent("gymbro:demo-action", {
        bubbles: true,
        detail: {
          scenario: activeScenario,
          action,
          input: typedInput,
          suggestedView: CHAT_SCENARIOS[activeScenario].suggestedView,
        },
      }),
    );
  }

  function updateControls(isBusy) {
    busy = isBusy;
    if (send) send.disabled = isBusy;
    for (const button of prompts?.querySelectorAll("button") || []) {
      button.disabled = isBusy;
    }
    messages.setAttribute("aria-busy", String(isBusy));
    root.classList.toggle("is-typing", isBusy);
  }

  function cancelSequence() {
    actionToken += 1;
    window.clearTimeout(timer);
    typingNode?.remove();
    typingNode = undefined;
    updateControls(false);
  }

  function showTyping() {
    typingNode?.remove();
    typingNode = make("div", "message bot typing-message");
    typingNode.setAttribute("aria-label", "Sample coach response loading");
    const avatar = make("span", "message-avatar", "G");
    avatar.setAttribute("aria-hidden", "true");
    const body = make("div", "message-body typing-bubble");
    for (let i = 0; i < 3; i += 1) body.append(make("span", "typing-dot"));
    typingNode.append(avatar, body);
    messages.append(typingNode);
    scrollBottom();
  }

  function loadScenario(id, { notify = true } = {}) {
    if (!CHAT_SCENARIOS[id]) return;
    cancelSequence();
    activeScenario = id;
    userMessages = 0;
    const scenario = CHAT_SCENARIOS[id];
    if (title) title.textContent = scenario.title;
    if (description) description.textContent = scenario.description;
    for (const tab of tabs) {
      const selected = tab.dataset.scenario === id;
      tab.classList.toggle("active", selected);
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("aria-pressed", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    messages.replaceChildren();
    for (const message of scenario.messages) appendMessage(message);
    // Start at the top so visitors see the trigger before the response.
    messages.scrollTop = 0;
    if (prompts) {
      prompts.replaceChildren();
      for (const text of scenario.prompts) {
        const chip = make("button", "prompt-chip", text);
        chip.type = "button";
        chip.addEventListener("click", () => submitMessage(text));
        prompts.append(chip);
      }
    }
    if (input) {
      input.value = "";
      input.placeholder = id === "workout" ? "Try “bench 60x12”" : `Try “${scenario.prompts[0]}”`;
    }
    updateStatus("Scripted demo · sample data");
    if (notify) emitAction("scenario");
  }

  function submitMessage(text) {
    const safeText = String(text).trim().slice(0, 240);
    if (!safeText || busy) return;
    if (userMessages >= maxUserMessages) {
      updateStatus("Replay or select a scenario to restart this sample conversation.");
      return;
    }
    userMessages += 1;
    appendMessage({ role: "user", text: safeText });
    if (input) input.value = "";
    updateControls(true);
    updateStatus("Showing a scripted response…");
    showTyping();
    const token = actionToken;
    timer = window.setTimeout(
      () => {
        if (token !== actionToken) return;
        typingNode?.remove();
        typingNode = undefined;
        appendMessage({ ...responseFor(safeText, activeScenario), role: "bot", time: shortTime() });
        updateControls(false);
        updateStatus("Scripted demo · your message stays in this page only");
        emitAction("message", safeText);
      },
      reducedMotion.matches ? 0 : 650,
    );
  }

  function replayScenario() {
    cancelSequence();
    userMessages = 0;
    messages.replaceChildren();
    updateControls(true);
    updateStatus("Playing the sample conversation…");
    emitAction("replay");
    const token = actionToken;
    const conversation = CHAT_SCENARIOS[activeScenario].messages;
    let index = 0;
    const advance = () => {
      if (token !== actionToken) return;
      typingNode?.remove();
      typingNode = undefined;
      appendMessage(conversation[index]);
      index += 1;
      if (index >= conversation.length) {
        updateControls(false);
        updateStatus("Scripted demo · sample data");
        return;
      }
      if (conversation[index].role === "bot") showTyping();
      timer = window.setTimeout(
        advance,
        reducedMotion.matches ? 0 : conversation[index].role === "bot" ? 850 : 1000,
      );
    };
    timer = window.setTimeout(advance, reducedMotion.matches ? 0 : 180);
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => loadScenario(tab.dataset.scenario));
    tab.addEventListener("keydown", (event) => {
      let nextIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown")
        nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp")
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      loadScenario(tabs[nextIndex].dataset.scenario);
      tabs[nextIndex].focus();
    });
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitMessage(input?.value || "");
  });
  replay?.addEventListener("click", replayScenario);
  document.querySelector("#chat-attachment")?.addEventListener("click", () => {
    loadScenario("meal");
    replayScenario();
  });
  document.querySelector("#chat-mic")?.addEventListener("click", () => {
    loadScenario("voice");
    replayScenario();
  });

  loadScenario("workout", { notify: false });
  return { loadScenario, replay: replayScenario };
}
