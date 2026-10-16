// Fictional profiles, targets, logs, meals, and messages for the local showcase. No service calls.
export const DEMO_PROFILE = Object.freeze({
  name: "Alex",
  calorieTarget: 2450,
  proteinTarget: 140,
  program: "Strength & Hypertrophy",
  trainingDays: 4,
});

export const CHAT_SCENARIOS = {
  workout: {
    title: "Log it between sets.",
    description: "Send a quick set. Finish your session. Keep the details together in Notion.",
    suggestedView: "workout",
    prompts: ["bench 60x12", "done", "What did I bench last time?"],
    messages: [
      { role: "user", text: "bench 60x12", time: "18:42" },
      { role: "bot", text: "Noted.", time: "18:42" },
      { role: "user", text: "bench 60x12, 60x10. done", time: "19:28" },
      {
        role: "bot",
        text: "Session complete. Your three bench sets are together in this week’s Workout Log.",
        time: "19:28",
        card: {
          title: "Upper body · Workout Log",
          rows: [
            ["Bench press", "60 kg × 12, 12, 10"],
            ["Bench volume", "2,040 kg"],
            ["Session duration", "46 min"],
          ],
          footer: "Next time: review these sets before choosing your working load.",
        },
      },
    ],
  },
  meal: {
    title: "Everyday food. Useful context.",
    description: "Describe your meal or add a plate photo. See an estimate against your targets.",
    suggestedView: "meal",
    prompts: [
      "Log my chicken rice bowl",
      "How much protein is left?",
      "What should I eat for dinner?",
    ],
    messages: [
      {
        role: "user",
        text: "Lunch: grilled chicken, rice, vegetables, and iced tea.",
        time: "13:05",
        attachment: {
          kind: "meal",
          title: "Lunch photo",
          caption: "Chicken rice bowl · illustrative attachment",
        },
      },
      {
        role: "bot",
        text: "I can estimate this. Was the rice a full portion or a small serving? Was the tea sweetened?",
        time: "13:05",
      },
      {
        role: "user",
        text: "Small rice portion, one chicken breast, lightly sweetened tea.",
        time: "13:06",
      },
      {
        role: "bot",
        text: "Lunch estimate: about 650 kcal and 42 g protein. Portions, sauces, and tea sweetness can change that, so I’d keep a 600–750 kcal and 35–45 g protein range.",
        time: "13:06",
        card: {
          title: "Today so far · Meal Log",
          rows: [
            ["Recorded calories", "1,060 / 2,450 kcal"],
            ["Recorded protein", "66 / 140 g"],
            ["Protein remaining", "74 g"],
          ],
          footer:
            "Breakfast and lunch recorded. The workspace preview also shows a full sample day.",
        },
      },
    ],
  },
  plan: {
    title: "A week that fits your life.",
    description:
      "Your goals, established lifts, and recent sessions help shape the next training week.",
    suggestedView: "program",
    prompts: ["/today", "I only have 30 minutes", "How do I progress my bench?"],
    messages: [
      { role: "user", text: "/plan", time: "18:00" },
      {
        role: "bot",
        text: "Here’s a sample week for your Strength & Hypertrophy routine. Four gym sessions focused on building strength and muscle, with recovery days in the plan.",
        time: "18:00",
        card: {
          title: "11–17 Oct · Your training week",
          rows: [
            ["Monday", "Lower · squat, hinge, core"],
            ["Tuesday", "Upper · bench, row, shoulders"],
            ["Wednesday", "Lower · legs, accessories, core"],
            ["Thursday", "Upper · bench, row, accessories"],
            ["Friday & Saturday", "Rest / recovery"],
            ["Sunday", "Weekly review & next plan"],
          ],
          footer: "Saved plans and completed sessions can be reviewed together in Notion.",
        },
      },
      { role: "user", text: "What should I train today?", time: "18:01" },
      {
        role: "bot",
        text: "Your next sample session is Thursday’s upper body workout. Start with a warm-up, then use last session’s recorded lifts as your reference.",
        time: "18:01",
        card: {
          title: "Thursday · Upper · 45–50 min",
          rows: [
            ["Bench press", "60 kg · 3 × 10–12"],
            ["Chest-supported row", "25 kg · 3 × 12"],
            ["Overhead press", "30 kg · 3 × 8–10"],
          ],
          footer: "Tell the coach about fatigue, pain, or limited time before training.",
        },
      },
    ],
  },
  progress: {
    title: "See the work adding up.",
    description:
      "Review recorded consistency, lift history, body check-ins, and the next priority.",
    suggestedView: "progress",
    prompts: ["/progress", "What did I improve?", "What is my next priority?"],
    messages: [
      { role: "user", text: "/progress", time: "18:00" },
      {
        role: "bot",
        text: "You recorded three of four planned sessions in this sample week. Here’s what your recorded data shows.",
        time: "18:00",
        card: {
          title: "Week in progress · 11–17 Oct",
          rows: [
            ["Training sessions", "3 / 4 planned"],
            ["Best recorded bench set", "60 kg × 12"],
            ["Previous week’s bench", "57.5 kg × 10"],
            ["Nutrition coverage", "Meals logged on 5 / 7 days"],
          ],
          footer: "The week is still in progress. Nutrition totals reflect recorded meals.",
        },
      },
      { role: "user", text: "What should I focus on next?", time: "18:01" },
      {
        role: "bot",
        text: "Your fourth planned session is Thursday’s upper body workout. Keep recording meals as the week continues so we can compare intake with your targets. For bench, repeat clean sets at your current load and review recovery before progressing.",
        time: "18:01",
      },
    ],
  },
  food: {
    title: "Remember it once. Reuse it.",
    description:
      "Save nutrition-label values in your Food Library, then scale them to your serving.",
    suggestedView: "food",
    prompts: ["Remember this food", "Log 2 servings", "/foodlib"],
    messages: [
      {
        role: "user",
        text: "Remember this whey protein label.",
        time: "21:10",
        attachment: {
          kind: "label",
          title: "Nutrition label",
          caption: "Sample whey · 1 scoop (30 g)",
        },
      },
      {
        role: "bot",
        text: "Here’s how the printed serving values appear in your Food Library.",
        time: "21:10",
        card: {
          title: "Sample whey · Food Library",
          rows: [
            ["Serving", "1 scoop · 30 g"],
            ["Calories", "120 kcal"],
            ["Protein", "24 g"],
            ["Source", "Nutrition label"],
          ],
          footer: "Use readable label values for a consistent record.",
        },
      },
      { role: "user", text: "Log 2 servings after training.", time: "21:12" },
      {
        role: "bot",
        text: "Two saved servings = 240 kcal and 48 g protein. The meal workflow can reuse those values without estimating this food again.",
        time: "21:12",
      },
    ],
  },
  voice: {
    title: "Hands full? Just say it.",
    description: "With transcription enabled, a voice note becomes useful workout or meal context.",
    suggestedView: "meal",
    prompts: ["Show the transcript", "Log my dinner", "Can I send photos too?"],
    messages: [
      {
        role: "user",
        text: "Dinner was noodle soup with vegetables. One regular bowl.",
        time: "20:15",
        voice: { duration: "0:12", label: "Voice note · sample transcript" },
      },
      {
        role: "bot",
        text: "Got your dinner note: one bowl of noodle soup with vegetables. Was it mostly noodles and vegetables, without extra meat or an egg?",
        time: "20:15",
      },
      { role: "user", text: "Yes, no extra meat or egg.", time: "20:16" },
      {
        role: "bot",
        text: "For this sample portion, I’d estimate around 440 kcal and 10 g protein, with a 390–500 kcal range. It can be recorded under Dinner in your daily meal page.",
        time: "20:16",
        card: {
          title: "Your input, your choice",
          rows: [
            ["Voice notes", "Requires enabled transcription"],
            ["Meal photos", "Add portion details when needed"],
            ["Text messages", "Describe it in English"],
          ],
        },
      },
    ],
  },
};

export const QUICK_RESPONSES = {
  bench: {
    text: "This demo shows how a quick set is acknowledged. In the configured bot, your reported set becomes part of your workout record when the session is completed.",
  },
  done: {
    text: "Here’s the sample completed-session view. Your Workout Log groups the session with this week’s training.",
    card: {
      title: "Workout recorded · example",
      rows: [
        ["Bench press", "60 kg × 12, 12, 10"],
        ["Bench volume", "2,040 kg"],
        ["Session duration", "46 min"],
      ],
      footer: "This preview uses the sample session above.",
    },
  },
  history: {
    text: "Your last recorded bench session in this sample was 60 kg × 12, 12, and 10. Recorded sets give the coach a reference for your next session.",
  },
  protein: {
    text: "In the full sample day shown in the workspace, all five meal entries total 112 g of protein against a 140 g target, leaving 28 g. The lunchtime view above has 66 g recorded and 74 g remaining.",
  },
  dinner: {
    text: "For this sample day, choose a dinner with a clear protein source. Chicken, fish, tofu, or eggs can work with your usual rice and vegetables. Share the portion for a useful estimate.",
  },
  today: {
    text: "The next session in your sample plan is Thursday’s upper body workout. Warm up, then bench press at 60 kg for 3 × 10–12, chest-supported rows at 25 kg for 3 × 12, and overhead press at 30 kg for 3 × 8–10. Report recovery before choosing the working load.",
  },
  shortSession: {
    text: "For a sample 30-minute upper body session, prioritize the warm-up, bench press, and chest-supported row. Keep the effort manageable and skip accessories if you run out of time.",
  },
  progression: {
    text: "Use clean reps and recorded recovery to guide progression. The sample bench history is 60 kg × 12, 12, and 10. A load increase should follow your program’s rule once the required sets reach its rep target.",
  },
  progress: {
    text: "The sample week of 11–17 October is in progress: 3 of 4 planned sessions, a best bench set of 60 kg × 12, and meal logs on 5 of 7 days. Thursday’s upper body session is next; keep logging as the week continues.",
  },
  improvement: {
    text: "Your best recorded bench set in the sample increased from 57.5 kg × 10 to 60 kg × 12. That is a comparison of reported sets, not a guarantee of future performance.",
  },
  priority: {
    text: "The next sample priority: review Thursday’s upper body session, keep recording meals as the week continues, and add a bodyweight check-in. More complete records make the next review more useful.",
  },
  remember: {
    text: "The sample label is ready as a Food Library entry: 1 scoop (30 g), 120 kcal, 24 g protein, source: nutrition label. In the connected bot, ask “remember this” to save a reusable food record.",
  },
  servings: {
    text: "Using the sample whey label, 2 servings are 60 g of powder, 240 kcal, and 48 g protein. Saved serving values can be scaled before recording the meal.",
  },
  library: {
    text: "Your sample Food Library has reusable serving values for familiar foods.",
    card: {
      title: "Food Library · example",
      rows: [
        ["Sample whey · 1 scoop", "120 kcal · 24 g protein"],
        ["Greek yogurt · 170 g", "100 kcal · 17 g protein"],
      ],
      footer: "Library entries retain the recorded source and serving size.",
    },
  },
  transcript: {
    text: "Sample transcript: “Dinner was noodle soup with vegetables. One regular bowl.” Voice input requires transcription to be enabled in your bot configuration.",
  },
  photos: {
    text: "Yes. The product accepts supported meal, nutrition-label, and equipment photos, plus PDF reference material. Photos may need portion clarification, and nutrition estimates use ranges.",
  },
  meal: {
    text: "The sample chicken rice bowl and iced tea are estimated at 650 kcal and 42 g protein, with a 600–750 kcal and 35–45 g protein range. Portions, sauces, and preparation change the numbers; the connected coach can ask for those details.",
  },
  fallback: {
    text: "This is a scripted product preview, so I can’t analyze a new meal or answer as a live coach. Try one of the suggestions above, or switch scenarios to explore workout logs, meals, plans, progress, and saved foods.",
  },
};
