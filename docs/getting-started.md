# Getting started

[Product overview](../README.md) · [Commands and examples](./commands.md) · [Privacy controls](./privacy.md)

Run the terminal commands below from the extracted project folder.

## What you need

For the first chat, you need somewhere to run the bot, a Telegram account, and one AI
credential: a Gemini API key, an OpenAI API key, or a Claude subscription token. The
API keys can be created in a browser; the Claude option adds a short terminal setup below.
You do not need Git, Docker, Google Calendar, or a separate database for that first test.

**To save workouts and meals, connect Notion.** You can try chatting without it, but the
bot cannot save your training and nutrition logs until Notion is configured. Add voice
notes and Google Calendar later, after text and photo coaching work.

## Quickstart (local)

Follow these steps once. You do not need to clone, pull, push, or upload anything to GitHub.

1. **Download the project and install Node.js.** On this repository's GitHub page, choose
   **Code → Download ZIP**, then extract the ZIP. Install the **LTS version of
   [Node.js](https://nodejs.org/en/download)** using the installer for your computer
   (version 22 or newer). Node.js includes `npm`, which runs the two commands below.

2. **Get your Telegram and AI credentials.** Message [@BotFather](https://t.me/BotFather),
   send `/newbot`, follow its prompts, and copy the bot token. Message
   [@userinfobot](https://t.me/userinfobot) and copy your numeric user ID.

   **Choose one AI provider:**

   **Gemini — free tier available.** Get an API key from
   [Google AI Studio](https://aistudio.google.com/apikey). Eligible models offer free input
   and output tokens within Google's free-tier quotas, with no paid AI subscription
   needed for that option. Check current [pricing](https://ai.google.dev/gemini-api/docs/pricing)
   and your project's [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

   **Use fictional or non-personal data for free-tier trials.** Google's unpaid-service
   terms allow inputs and replies to be used for product improvement and prohibit
   submitting personal, sensitive, or confidential information. For your own personal
   fitness records, use a project with billing enabled; regional exceptions apply.
   [Read Google's data terms](https://ai.google.dev/gemini-api/terms).

   **OpenAI — API key.** Create an API key in the
   [OpenAI API platform](https://platform.openai.com/api-keys). ChatGPT subscriptions
   do not include API usage; API billing is separate. Select a model in the OpenAI
   platform that supports the Responses API and function calling. The bot uses
   Responses API conversation continuity with `store: true`; response data is retained
   for at least 30 days under the standard policy, subject to account controls. See
   OpenAI's [data controls](https://developers.openai.com/api/docs/guides/your-data).

   **Claude — your own subscription.** Use your own eligible Pro, Max, Team, or Enterprise
   account. Open a terminal and run these commands one at a time:

   ```bash
   npm install -g @anthropic-ai/claude-code
   claude setup-token
   ```

   The first installs Claude Code; skip it if you already have the CLI installed. The
   second opens a browser sign-in. Sign in to your Claude subscription account, approve
   access, and copy the token printed in the terminal. Paste it into `.env` in step 3.
   If `claude` is not found after installation, reopen your terminal. If Windows
   PowerShell blocks `npm`, use `npm.cmd install -g @anthropic-ai/claude-code` instead.
   Usage is subject to your account's limits and
   [Anthropic's current Agent SDK guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
   See the official [installation](https://code.claude.com/docs/en/setup#install-with-npm)
   and [token instructions](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)
   if you need help. This is the repo's existing subscription-token path;
   `ANTHROPIC_API_KEY` alone does not satisfy its startup check.

3. **Fill in one settings file.** In the extracted folder containing `package.json`,
   duplicate `.env.example` and rename the copy to **`.env`**. Open it in a plain-text
   editor such as Notepad. Replace the existing values for these settings:

   | Setting | What to enter |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | The bot token from BotFather |
   | `ALLOWED_TELEGRAM_IDS` | Your numeric user ID; this makes the bot answer only you |
   | `OWNER_CHAT_ID` | The same numeric ID; this enables default reminders |
   | `GEMINI_API_KEY` | Gemini: your API key. Claude: leave blank |
   | `CLAUDE_CODE_OAUTH_TOKEN` | Claude: the token from `claude setup-token`. Gemini: leave blank |
   | `OPENAI_API_KEY` | OpenAI: your API key from the API platform |
   | `OPENAI_MODEL` | Optional OpenAI model; defaults to `gpt-6.1-sol` |
   | `OPENAI_MODEL_FAST` | Optional OpenAI model for quick logs; defaults to `gpt-6-luna` |
   | `TIMEZONE` | Your local IANA timezone, for example `Asia/Tokyo`, `Europe/London`, or `America/New_York`; the fallback is `Etc/UTC` |
   | `TRANSCRIBE_PROVIDER` | `off` for now; avoids an extra voice-model download |

   Fill in only your chosen AI credential. If more than one is set, Claude takes priority,
   then Gemini, then OpenAI. ChatGPT subscription access is separate from OpenAI API billing.
   For the Claude subscription path, also leave `ANTHROPIC_API_KEY` unset in your computer's
   environment so it does not override subscription authentication. Keep `MODE=polling`
   and the other defaults for the first test. Make sure the filename is `.env`, not
   `.env.txt`. Keep this file private: it contains access keys.

4. **Run two commands.** Open a terminal in that same folder. On Windows, right-click
   inside the folder and choose **Open in Terminal**. On macOS or Linux, open Terminal,
   type `cd `, drag the extracted folder into the window, and press Enter. Run these
   commands one at a time:

   ```bash
   npm install
   npm run dev
   ```

   The first downloads the project's dependencies. The second starts your coach.
   Keep this terminal open. If Windows PowerShell blocks `npm`, use `npm.cmd install`
   and `npm.cmd run dev` instead. To stop the coach, press **Ctrl+C**. Next time, open
   the same folder's terminal and run only `npm run dev`.

5. **Check it in Telegram.** Open a private chat with the bot you created. Send
   `/commands` to check the connection, then `/start` to test an AI reply. Tell the coach
   your goals and equipment. You can fill in your profile through chat instead of
   editing another file. Group chats are not supported. If there is no reply, check
   that the terminal is still running and `ALLOWED_TELEGRAM_IDS` contains your own ID.

### Connect Notion when you are ready to save logs

As the owner of your Notion workspace, create an internal connection at
[Notion developer connections](https://app.notion.com/developers/connections) and copy its API token.
Allow it to read, update, and insert content. Create a private Notion page for your coach,
open the page's **••• → Connections → Add connection** menu, and select that connection.
Copy the page link; its page ID is the final 32-character code, before any `?` query string
(hyphens are okay). [Notion's connection guide](https://developers.notion.com/guides/get-started/internal-connections)

In `.env`, set `NOTION_TOKEN` to the integration token and `NOTION_PARENT_PAGE_ID` to that
page ID. Stop the bot with **Ctrl+C**, then restart it with `npm run dev` so it reads the
new settings. Send `/setup` in Telegram; the bot builds the workspace for you. Log one
workout or meal and check that it appears in Notion before relying on saved history.

Google Calendar, voice notes, and Docker are optional next steps.
Their settings are in [configuration](./configuration.md) and
[deployment](./deployment.md). Only one running copy can use your bot token: stop
the laptop copy before starting a cloud copy.

## Hosting options

Start locally and move to your own cloud account later. Cloud hosting requires
deployment configuration, credentials, and persistent storage for your bot's local state.

| Option | Cost profile | Reminders | Best for |
|---|---|---|---|
| **Laptop or desktop** | Your computer/electricity plus any AI usage | Runs while the computer and bot stay on | First-time setup and trying it out |
| **Always-on cloud container** | Hosting/storage plus any AI usage | Built-in scheduler while the service stays running | Keeping your laptop off; technical setup today |
| **Google Cloud Run** | Compute, storage, scheduler, and any AI usage | Cloud Scheduler jobs | Advanced setup using the included Terraform/scripts |
| **Azure Container Apps** | An active replica, storage, and any AI usage | Azure scheduled jobs | Advanced setup using the included Bicep template |

- **Local.** `npm run dev` starts the coach, or use `docker compose up -d` for a
  container. The built-in scheduler (11:00 daily nudge and Sunday 18:00 report)
  needs the process running. A local Docker container stops being
  available when its computer sleeps or shuts down.
- **Always-on cloud container.** A provider such as Railway can run the existing Docker
  image in your own account, with one running instance and persistent storage. You still
  need to configure the service and storage yourself. See
  [cloud hosting without a laptop](./deployment.md#cloud-hosting-without-a-laptop).
- **Google Cloud Run.** Terraform config in [`infra/gcp/`](../infra/gcp/): builds the
  container, wires secrets, and runs the bot in webhook mode so it scales to zero between
  messages. Proactive reminders are driven by Cloud Scheduler jobs instead of the
  in-process scheduler.
- **Azure Container Apps.** Bicep template in [`infra/azure/`](../infra/azure/), same
  webhook + external scheduler model. The current template keeps one replica active,
  so budget for ongoing compute.

One rule regardless of host: **only one instance may poll a bot token at once.** Running
a local copy and a deployed copy on the same token gets you a Telegram 409. Use a second
BotFather bot for local testing if you have a deployed instance.

Full details, including the polling vs webhook trade-off and how scheduled reminders work
in each mode, are in [docs/deployment.md](./deployment.md).

## FAQ

**Does this need a paid Notion account?**
No. Internal integrations work on Notion's free plan. The agent builds and maintains the
entire workspace itself; you just create the integration and share one page with it.

**What does it cost to run?**
There is no myGymBro subscription fee. **Gemini offers free API usage on eligible models
within its free-tier limits**, subject to the [data-privacy conditions](#quickstart-local)
above. Higher quotas, paid-only models, other AI providers, cloud hosting/storage, and
API voice transcription can cost money. Running on your laptop avoids a separate hosting
bill but uses its resources and requires it to stay on. Actual costs depend on your
configuration and usage; the repo does not promise free or fixed-cost hosting.

**Which AI engine should I pick?**
Choose from Claude (subscription token), Gemini, or OpenAI (API key). Each uses the same
coach instructions and restricted workspace tools. OpenAI API usage is billed separately
from a ChatGPT subscription. See the [local quickstart](#quickstart-local) and
[configuration guide](./configuration.md).

**Can ChatGPT / OpenAI be my coach?**
Yes. Set `OPENAI_API_KEY` and leave the Claude and Gemini credentials blank. Coaching
questions use `OPENAI_MODEL` (`gpt-6.1-sol` by default); short logs and session-end writes
use `OPENAI_MODEL_FAST` (`gpt-6-luna` by default). A ChatGPT subscription does not include
API usage; configure billing separately in the OpenAI API platform.

**Where are voice notes processed?**
Telegram delivers the audio to your bot. With `TRANSCRIBE_PROVIDER=local`, Whisper
transcribes it on the machine running myGymBro, then the text goes to your selected
AI provider. Local transcription downloads a model and needs additional memory.
With `TRANSCRIBE_PROVIDER=api`, audio also goes to the configured transcription
service. Set it to `off` to disable voice support; the beginner quickstart uses `off`.

**Does it work with fitness trackers (Garmin, Apple Watch, Whoop)?**
Not out of the box. myGymBro works from what you tell it and your saved Notion records;
it does not automatically sync fitness-tracker data.

**Can several people use one deployment?**
It is built as a personal coach: one user, one `PERSONAL.md`, one Notion workspace,
answering only your Telegram id. For a partner or friend, run a second instance with its
own bot token and Notion page.

**Is my training data private?**
Your profile and local runtime files are excluded from Git, and your connected Notion
workspace should stay private. Messages and attachments still go through Telegram and
your selected Claude, Gemini, or OpenAI provider. Optional integrations include Calendar
and API transcription; QuickChart receives the chart configuration used for reports.
Local files are not encrypted by this application. `/new` does not erase Telegram,
Notion, provider records, or backups. See [privacy controls](./privacy.md).
