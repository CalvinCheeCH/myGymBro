# myGymBro product showcase

A responsive, interactive customer introduction. This is a standalone static site. Its chat and workspace previews use scripted examples and fictional records for Alex, with no connection to the running Telegram bot, AI providers, or Notion. The product itself is self-hosted, with one person, one profile, and one Notion workspace per deployment.

The page links to the [GitHub repository](https://github.com/CalvinCheeCH/myGymBro) and [local setup guide](https://github.com/CalvinCheeCH/myGymBro/blob/master/docs/getting-started.md#quickstart-local) so visitors can move from exploring the demo to setting up their own coach. Repository access follows its current visibility setting.

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

## Static website package

```powershell
npm run build:showcase
```

This creates `dist/showcase/` from an explicit list of 18 files: the HTML, CSS,
browser modules, favicon, eight avatars, and license. It does
not copy the bot, local server, credentials, or runtime data.
No dependency installation or bot build is needed for this command.

Relative asset paths support a project URL such as `/myGymBro/`.

## GitHub Pages when you are ready

[GitHub Free supports Pages from public repositories](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
Local testing needs no paid plan or billing change.

When enabling Pages for a public release:

1. In the repository, open **Settings → Pages → Build and deployment** and select
   **GitHub Actions** as the source. Set the `github-pages` environment to allow
   deployments from `master` only.
2. Open **Actions → CI → Run workflow**, select `master`, and run it. The
   `deploy-showcase` job runs only after `build-and-test` and `publication-security`
   pass, and only for public `master` push or manual runs. It stays skipped while
   the repository is private and never deploys pull requests.
3. Open the URL reported by the deployment, expected to be
   `https://CalvinCheeCH.github.io/myGymBro/`. Check the demo and its GitHub link.
   Add the verified live demo URL near the top of the main README when available.

The workflow uploads only `dist/showcase/`; it does not start the Telegram bot.
The local Node server's security headers do not carry over to Pages. The demo adds
no analytics, but [GitHub Pages logs visitor IPs for security](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection).
To keep bot source private on GitHub Free, a separately approved public demo-only
repository is another option; this workflow does not create one.
