# myGymBro product showcase

A responsive, interactive customer introduction. This is a standalone static site. Its chat and workspace previews use scripted examples and fictional records for Alex, with no connection to the running Telegram bot, AI providers, or Notion. The product itself is self-hosted, with one person, one profile, and one Notion workspace per deployment.

The page links to the [GitHub repository](https://github.com/CalvinCheeCH/myGymBro) and [local setup guide](https://github.com/CalvinCheeCH/myGymBro#quickstart-local) so visitors can move from exploring the demo to setting up their own coach. Repository access follows its current visibility setting.

Run from the repository root:

```powershell
npm run dev:showcase
```

Open [http://localhost:4173](http://localhost:4173). The server binds to the local machine only. No dependencies, build step, credentials, or `.env` files are needed. Stop it with Ctrl+C.

To select another port in PowerShell:

```powershell
$env:SHOWCASE_PORT = '4174'
node showcase/server.mjs
```

The showcase includes six Telegram-style scenarios, a sample-message composer, replay controls, five explorable Notion-style pages, workout details, meal totals, a calendar preview, six feature categories, setup information, and an FAQ. Its workspace design illustrates the product's records rather than reproducing a live Notion page.

Customer examples use English and familiar everyday meals, with strength, hypertrophy, and general fitness coaching. The shared sample program is a four-session Strength & Hypertrophy routine, with three sessions recorded and one planned. New demo messages use the viewer's local timezone; scripted conversations retain their illustrative times.

The prominent **Coach voices** section previews all nine built-ins: Batman, Arnold, Yoda, Sherlock Holmes, Tony Stark, Gandalf, Dwight Schrute, Captain Jack Sparrow, and Normal coach. Three scripted scenarios cover training progression, a protein target, and motivation; each voice preserves the sample facts and guidance. The custom name/tone demo previews changes instantly and offers Supportive, Direct, Playful, Old-school, Millennial, Hype, Brainrot, and Zen styles. Choose by personal preference; the labels do not restrict who can use a style. These are scripted webpage presets. In the actual bot, `/create` accepts your own voice description, then `/persona <id>` activates it. Switching voices starts fresh chat context while existing Notion records remain available.

Coach voices use stylized avatar illustrations. Normal and Custom use local vector icons. These illustrations belong to the webpage preview.

All demo assets are local, including icons and styles. The page does not fetch remote fonts, media, or analytics. Following a GitHub link opens GitHub; it does not connect the demo to the bot.

Explore Workout, Meals, Planning, Progress, Food library, and Voice conversations,
send a sample workout message, or replay a chat. Choose a coach voice or customize
its name and tone, then browse the dashboard, logs, weekly plan, and libraries.

Messages and custom names stay in the current page. Reloading resets the demo.
README screenshots in `docs/assets/showcase/` are captures of this page using fictional records.

## Feature walkthroughs

Run the local demo and choose **Feature stories** in the navigation, or open
[the walkthrough section](http://localhost:4173/#feature-stories) with the default
server running.

Four stories each have three steps: Food Library (save a label, keep a reference,
reuse a confirmed serving), daily workout notes, weekly/monthly training reports,
and training math with personal exercise references. Select a story, then use its
step buttons or previous/next controls. The story tabs support arrow keys, Home,
and End. Nothing connects to real accounts, and all records are fictional.

The Food Library story separates saving a food from logging consumption. Its
Sample Whey example uses 120 kcal and 24 g protein per 30 g serving; 1.5 confirmed
servings gives 180 kcal and 36 g protein. It does not change the other sample day's
totals. The report examples show training data; written coaching uses the selected
AI provider in the running product.

## Static website package

```powershell
npm run build:showcase
```

This creates `dist/showcase/` from an explicit list of 20 files: the HTML, CSS,
browser modules, favicon, eight avatars, and license. It does
not copy the bot, local server, credentials, or runtime data.
No dependency installation or bot build is needed for this command.

Relative asset paths support a project URL such as `/myGymBro/`.
