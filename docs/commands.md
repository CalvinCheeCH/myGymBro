# Commands

[Product overview](../README.md) · [Setup guide](./getting-started.md)

Send these commands in your private Telegram chat with the bot:

- `/start`: introduce the coach and how to use it.
- `/help`: explain available features.
- `/commands`: show the command list without an AI call.
- `/setup`: create or repair the Notion workspace, dashboard, databases, and libraries.
- `/log`: start logging a workout; include details, for example `/log bench 60x12`.
- `/today`: recommend today's session using your goals, plan, and recent logs.
- `/plan`: build a weekly training plan and save it to Notion.
- `/progress`: get a written review of your recorded workouts.
- `/report`: send this week's training report card, with a comparison against the same
  days last week when records are available. No AI call.
- `/report monthly`: compare the latest completed month with the preceding month when
  records are available. No AI call. Other `/report` arguments are not supported.
- `/foodlib`: list saved foods with their category, protein, and calories.
- `/stats`: show the last seven days of bot usage, errors, and response times. No AI call.
- `/new` or `/reset`: start a fresh conversation and clear active workout context.
  Your saved Notion records, Telegram messages, and selected persona remain.
- `/persona`: list available coaching voices and show the current one.
- `/persona <id>`: select a voice, for example `/persona batman`, and start fresh chat context.
- `/persona random`: use the character voice assigned randomly to this chat; repeating
  it does not reroll the character.
- `/persona clear`: return to the configured default voice. `/persona default` and
  `/persona reset` are aliases.
- `/create`: describe and save your own coaching voice, then activate the returned ID
  with `/persona <id>`.
- `/resetdata`: owner-only preview of the Notion records, weekly plans, and one-off
  workout calendar events to reset. The preview expires after five minutes.
- `/resetdata cancel`: cancel the pending reset.
- `/resetdata confirm reset my data`: confirm the previewed reset. Archives the listed
  Notion rows and plan pages, and deletes the listed one-off calendar events.

Built-in persona IDs: `normal`, `arnold`, `yoda`, `sherlock`, `stark`, `gandalf`,
`dwight`, `sparrow`, and `batman`. Personality changes written delivery while keeping
the same coaching rules. Brainrot or another creative style can be described through
`/create`; these are custom voices rather than built-in IDs. Personas are enabled by
default; `PERSONALITIES_ENABLED=false` keeps the plain coach regardless of selection.

`/resetdata` can affect Workout Log, Meal Log, Body Stats, Goals, and Programs records.
It keeps the Food Library, Exercise Library, imported references, recurring calendar
events, profile, settings, reminders, and Telegram messages. Review the preview before
confirming; `/new` only clears conversation and active workout context.

You can also use ordinary messages and attachments:

- **Log between sets:** `bench 60x12`, then `done` to finish the session. Correct a set
  before finishing with a message such as "Sorry, that was 60x10."
- **Retrieve or adapt training:** "What did I bench last week?" or "I only have
  30 minutes and dumbbells today."
- **Find exercises and training numbers:** ask for movement alternatives, progression
  suggestions, an estimated one-rep max, or the plates needed for a barbell load.
- **Log food:** describe your meal and portions, send a plate photo for an estimate,
  or send a readable nutrition label and ask the coach to save its serving values.
- **Check nutrition:** "How much protein is left today?" or "What could I eat to
  reach my target?"
- **Track your goals and measurements:** report bodyweight, waist measurements, or
  updated fitness goals.
- **Request other report periods:** "Send today's report card" or "Show last week's
  report card." Use ordinary chat for these; the slash shortcut accepts only the
  weekly default or `monthly`.
- **Use training references:** send a PDF or image for context, or ask to import program
  files you placed in the `knowledge/` folder.
- **Use optional integrations:** send voice notes when transcription is enabled;
  move training sessions or reserve recurring slots when Google Calendar is connected.

Durable records and reports require Notion. Voice, Google Calendar, and scheduled
check-ins depend on configuration. Custom Telegram reminder creation through chat is
not available through the current restricted coach tools. Editing already-saved logs
is also limited by the archive restriction; corrections during an active workout are
the supported path. See [capabilities](./capabilities.md) for more details.
