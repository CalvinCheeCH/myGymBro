# GCP infrastructure (Terraform)

Provisions the full scale-to-zero deployment on Google Cloud:

- **Artifact Registry** Docker repository for the image
- **Cloud Run** service in webhook mode (min 0 / max 1 instance, CPU always
  allocated so background runs finish), with a GCS bucket mounted at `/data`
- a dedicated **runtime service account** with least-privilege access
- **Secret Manager** secrets for the Claude, Telegram, Notion, and cron values
- **Cloud Scheduler** jobs that call `/cron/run` for the seeded reminders
  at their configured local times (set `timezone` to your own IANA timezone;
  the fallback is `Etc/UTC`)

This is the IaC equivalent of `scripts/deploy-cloudrun.sh`. See
[../../docs/deployment.md](../../docs/deployment.md) for how webhook mode works.

## Prerequisites

- Terraform >= 1.5 and the `gcloud` CLI, authenticated:
  `gcloud auth application-default login` and `gcloud config set project <id>`.
- A Claude subscription token (`claude setup-token`), a Telegram bot token, and a
  long random `cron_secret`.
- Before any production `terraform plan` or `terraform apply`, configure an
  encrypted remote backend with narrowly restricted IAM access and state
  locking. The default local backend is only suitable for disposable
  development; do not apply production secrets with it.

## Deploy (two steps)

Cloud Run needs the image to exist before it can start, and the image lives in the
Artifact Registry this stack creates. So apply the registry first, push the image,
then apply the rest.

```bash
cd infra/gcp
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init

# 1. Create just the Artifact Registry (and enable APIs).
terraform apply -target=google_artifact_registry_repository.this

# 2. Build and push the image to it (run from the repo root).
cd ../..
gcloud builds submit \
  --tag "$(cd infra/gcp && terraform output -raw artifact_registry_repo)/fitcoach-agent:latest"

# 3. Apply the rest (Cloud Run, secrets, scheduler).
cd infra/gcp
terraform apply
```

`terraform output service_url` prints the public URL; the Telegram webhook
registers itself there on startup. On later code changes, rebuild and push the
image (step 2) and re-run `terraform apply` (a new revision rolls out; bump
`image_tag` if you tag by version).

## Notes

- Terraform provisions Secret Manager versions from the secret variables in
  `terraform.tfvars`. **Every `secret_data` value is recoverable from Terraform
  state**, including the Claude token, Telegram token, cron secret, and any
  optional Notion, transcription, or Google OAuth secrets. Terraform's
  `sensitive = true` only redacts values from normal CLI display; it does not
  omit or encrypt them in state. Supplying values through `TF_VAR_*`, a
  `.tfvars` file, or a secrets manager does not change that state exposure.
- For production, configure the remote backend and verify its encryption,
  access controls, and locking **before** `terraform init` and before supplying
  any real secret values. Restrict state access to operators who are allowed to
  read all application credentials. Do not use local state for production.
  Keep `terraform.tfvars`, downloaded state, state backups, and saved plan files
  out of source control and shared storage; saved plans may also contain secret
  values. The checked-in `.gitignore` excludes common local state and tfvars
  files, but that is not a substitute for backend security.
- Secret Manager protects runtime access to credentials. It does not protect
  copies Terraform stores in its state. If policy forbids secrets in Terraform
  state, do not use these `secret_data` resources with real credentials; provision
  secret versions through a separate approved workflow and change this stack to
  reference those externally managed secrets first.
- The service allows unauthenticated invocations because Telegram must reach the
  webhook; the endpoints are protected at the application layer (`CRON_SECRET`
  and the Telegram id allowlist).
- Cloud Scheduler interprets the schedule in `timezone`. Adjust `reminders` in
  `terraform.tfvars` to change times or add jobs.
- Voice transcription defaults to `off`; enable `transcribe_provider = "api"`
  and set `transcribe_api_key` to turn it on. Local Whisper is unsuitable for
  scale-to-zero instances.
