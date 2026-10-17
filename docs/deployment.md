# Deployment

The agent runs in one of two modes. The right one depends only on whether your
host keeps a process running or idles it to zero. All settings are environment
variables; see [configuration.md](./configuration.md).

**Choose a home for your coach first.** On your laptop, it works only while the computer
is awake, online, and the bot is running. In your own cloud account, the provider runs it
while your laptop is off. Either way, you provide your own Telegram and AI credentials.
For the simplest first test, use the [beginner local setup](../README.md#quickstart-local).

## Cloud hosting without a laptop

You do not need to buy a physical server. A cloud provider can run one private copy of
the existing Docker image in your account. An always-on service such as Railway can use
polling mode and the built-in reminder scheduler, with a volume for persistent files.
Only one running instance should use a given bot token.

These deployment instructions require technical setup. Configure the service's
environment variables and persistent storage in your hosting account.

Budget for hosting, persistent storage, and any AI usage. Check your provider's current
pricing instead of assuming a free service stays running continuously.
[Railway pricing](https://docs.railway.com/pricing/plans)

Your own cloud account removes the need to leave a laptop on; it still requires account
signup and your bot/provider credentials. Google Cloud and Azure instructions below are
advanced alternatives, not prerequisites for trying myGymBro.

## Always-on (polling mode, the default)

Anything that keeps a container alive: your own machine, a home server or
Raspberry Pi, a small VPS, or a platform like Railway, Render, or Fly with one
machine kept running. Configure your credentials and persistent storage: the bot
long-polls Telegram and the built-in scheduler (croner) fires your reminders. This is what
`docker compose up -d` does.

```bash
# Plain Docker, anywhere:
docker build -t fitcoach-agent .
docker run -d --name fitcoach --env-file .env -v fitcoach-data:/data -p 127.0.0.1:8080:8080 fitcoach-agent
```

The container routes its durable local records onto `/data` by default: sessions,
the schedule, persona files, provider history, pending workout sets, run metrics,
the Google token and selected calendar, and Claude's own transcripts (via
`HOME=/data`). The entrypoint defaults those paths to `/data` unless you set
the corresponding environment variables yourself. Mount the volume so those files survive restarts.
Edit your profile there directly (`/data/PERSONAL.md`, `/data/LOGGING_STYLE.md`,
`/data/PERSONAS.md`); the image links the project-root paths to the mount.
Regenerable caches, report images, and knowledge staging still live in `/app/data`
and `/app/knowledge`, which are writable in the image but do not survive container
replacement (Notion remains the durable record store). `/healthz` on port 8080
reports process health; it does not verify those files or live integrations.

When upgrading an older container, remove relative storage overrides such as
`SESSION_FILE=./data/sessions.json`, or set them to `/data/...`; explicit values
otherwise bypass the volume defaults. Before replacing it, migrate existing local
records to their corresponding paths in the mounted volume. In particular, copy
`/app/data/google-calendar.json` to `/data/google-calendar.json` if the volume has
no saved selection yet; preserve an existing destination instead of overwriting it.
`GOOGLE_CALENDAR_ID`, when set, overrides that saved selection.

> Only one instance may poll a given bot token at a time. If you also run it
> locally while a deployed copy is up, Telegram returns a 409 conflict. Stop one,
> or use a separate bot token for local development.

## Scale-to-zero (webhook mode)

For serverless hosts that idle to zero instances when no one is chatting (Google
Cloud Run and similar). Polling cannot scale to zero (it needs a running loop),
so the agent switches to webhooks. Set these and the rest is automatic:

- `MODE=webhook` and `PUBLIC_BASE_URL` (your service's HTTPS URL). The bot
  registers its Telegram webhook at `PUBLIC_BASE_URL/webhook/telegram`, acks each
  update instantly, and runs in the background (duplicates dropped).
- `CRON_SECRET`, then point an external scheduler at `POST /cron/run` (one call
  per reminder, body `{"taskId":"morning-nudge"}`) since the in-process cron does
  not run at 0 instances.
- Durable storage for `/data` and `HOME` (a mounted bucket or volume) so sessions
  and the SDK resume transcripts survive cold starts.

Two host requirements: the platform must **keep CPU allocated after the HTTP
response** so the background run finishes (on Cloud Run that is
`--no-cpu-throttling`), and you should cap it to **one instance** so a single
instance owns the mounted storage.

**Voice notes:** transcription defaults to `off` in the serverless templates.
To enable it, set `TRANSCRIBE_PROVIDER=api` and provide
`TRANSCRIBE_API_KEY` (OpenAI `gpt-4o-transcribe` by default). Local Whisper loads
a model into memory, so reserve `local` for always-on self-hosting where the RAM
is available.

### Ready-to-use examples

The same pattern (webhook URL + external cron + durable volume) maps to any
scale-to-zero host. Two examples ship with the repo:

- **Google Cloud Run (Terraform, recommended)**: [`infra/gcp/`](../infra/gcp/)
  provisions Artifact Registry, the Cloud Run service (min 0 / max 1, CPU always
  allocated), a runtime service account, Secret Manager secrets, a GCS bucket at
  `/data`, and the Cloud Scheduler jobs. See [infra/gcp/README.md](../infra/gcp/README.md)
  for the two-step apply (create the registry, push the image, apply the rest).
- **Google Cloud Run (script)**: [`scripts/deploy-cloudrun.sh`](../scripts/deploy-cloudrun.sh)
  is the imperative equivalent: builds, deploys with `--min-instances 0
  --no-cpu-throttling`, mounts a GCS bucket at `/data`, and creates the scheduler jobs.
- **Azure Container Apps**: [`infra/azure/`](../infra/azure/) provisions the
  environment, an Azure Files share for `/data`, the app with one active replica
  and external ingress, and scheduled Container Apps Jobs that call `/cron/run`.
  The active replica protects background work after webhook acknowledgements and
  incurs ongoing compute cost.
  See [infra/azure/README.md](../infra/azure/README.md) for the deploy steps.

See [infra/README.md](../infra/README.md) for an index of the available setups.
