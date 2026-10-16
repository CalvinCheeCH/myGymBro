# Security Policy

myGymBro handles Telegram, AI-provider, Notion, and optional Google credentials on your
own infrastructure. Public source distribution and running an internet-facing service
are separate security decisions. This is a personal, self-hosted deployment, not a
shared multi-user service. See [privacy controls](docs/privacy.md).

## Public repository controls

- `.gitignore`, `.dockerignore`, and `.gcloudignore` exclude private profiles, env
  variants, OAuth credentials, runtime data, private planning notes, backups, and
  infrastructure secrets. Ignoring a file does not remove earlier commits or a file
  already in Git's index.
- `npm run check:publication` scans candidate files and HEAD history using Gitleaks,
  rejects tracked ignored files and personal machine paths, and blocks commit emails
  outside GitHub noreply addresses. Its strict metadata policy also flags ordinary
  upstream author emails; it does not label those emails as stolen credentials.
- The optional `.githooks/pre-push` guard allows only the current audited branch.
  Enable it with `git config core.hooksPath .githooks`; make the hook executable on
  Unix systems. It refuses unaudited refs and mirror-style publication. Git hooks can
  be bypassed; use GitHub push protection as a second control.
- CI runs the publication guard, dependency audit (including development tools),
  build, lint, and tests.
  Actions and the Gitleaks release are pinned; CI checks use read-only repository
  permissions. The optional Pages job receives narrowly scoped deployment permissions
  only for public `master` push or manual runs after those checks pass.
- In GitHub settings, enable secret scanning/push protection, Dependabot alerts and
  security updates, private vulnerability reporting, and branch rules requiring CI.
  Repository files do not enable those account-side settings automatically.

Review Git history before making a repository public. Use a reviewed clean publication
snapshot or a separately reviewed history cleanup if personal material was committed.
Never publish Codex checkpoint/internal refs. If a real credential was exposed, revoke
or rotate it before doing history cleanup. See
[GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Runtime controls and DDoS limits

- Startup requires a nonempty valid Telegram allowlist. An owner ID must be on that
  allowlist. Private-chat and sender checks precede attachment download and AI work.
  Scheduled tasks also check the current allowlist before running or delivering output.
- Telegram webhooks require the configured secret header; `/cron/run` requires the
  cron bearer secret, at least 32 characters. Authentication precedes body processing.
- Public JSON bodies are capped at 1 MiB. Local scheduler bodies are capped at 32 KiB.
  Invalid JSON/shapes/recipients are rejected; headers and request bodies have explicit
  deadlines. Public connections and outstanding deliveries/tasks are bounded.
- Provider work is limited to two active jobs, 20 outstanding jobs per chat and 64
  overall. Queue saturation asks for a retry and preserves acknowledged rapid sets.
- The local scheduler listens on loopback, rejects browser-origin/rebinding requests,
  validates tasks and recipients, and caps stored tasks. Local processes are trusted;
  do not expose or reverse-proxy its port 9130.
- Coach file tools reject credential and deployment-secret paths, including redirected
  paths. File, output, and recipient arguments must be unambiguous. Report files and
  their archived copies cannot be written through symbolic links.
- Docker uses a non-root account, drops capabilities, blocks privilege escalation, and
  publishes its health port on loopback. Cloud runtime storage has explicit private
  access/HTTPS controls; existing cloud scale limits cap instances/replicas at one.

These are application safeguards, not network-edge DDoS protection. A public webhook
can still receive traffic and incur request/logging costs. Use your hosting provider's
firewall/WAF/rate-limit controls and budget alerts. Instance caps are not spending caps.
Do not forward local ports to the internet. The included cloud storage routing still
needs end-to-end validation before production use; see [deployment](docs/deployment.md).

## Threat model in brief

The full write-up, including the trusted/untrusted input table and the known gaps, is in
[docs/architecture.md](docs/architecture.md#trust-boundaries-and-threat-model). The short
version:

- **Direct prompt injection** (an allowlisted user typing "ignore all previous
  instructions") comes from an already-authorised sender. Persona instructions are
  not a substitute for runtime access control.
- **Indirect prompt injection remains the main model risk.** myGymBro ingests content it did not
  author: training programs dropped in `knowledge/`, photos and PDFs sent over Telegram,
  and Notion blocks. Any of that can carry an instruction block aimed at the assistant.
  The runtime exposes fixed-argument helper scripts and restricted file tools; it does
  not expose raw shell, arbitrary filesystem access, or web tools. This reduces impact
  but does not make model behavior itself a security boundary.
- The governing rule is that **content-derived text is data, never instructions**. Only
  `CLAUDE.md`, the bundled skills, and the live user turn direct behaviour.

### Verification

Local automated tests cover malformed/oversized/slow HTTP inputs, authentication,
private-recipient filtering, replay handling, queue saturation, scheduler browser
defenses, startup validation, privacy-preserving logs, and the publication guard.
These do not establish live cloud availability or resistance to a volumetric attack.

`evals/scenarios.json` exercises this deliberately. `prompt-injection-ignored` covers the
direct case; `indirect-injection-program-file`, `indirect-injection-saved-webpage`, and
`indirect-injection-persona-override` feed the agent poisoned fixtures from
`evals/fixtures/` (exfiltration, tool abuse, persona override) through an innocuous user
request. Those runs use restricted tool permissions and grade recorded tool calls for compliance intent rather than
waiting for a real side effect. Payloads point at `example.com` and are inert.

### Containment recommendation

Run myGymBro in a container or a dedicated VM holding only the credentials it needs. Do not
run it on a daily-driver machine alongside SSH keys, cloud credentials, or a browser
profile. Keep secrets out of model-visible files and script output; redaction
(`src/util/redact.ts`) is a secondary safeguard for returned text.

## Reporting a vulnerability

Do not include credentials, personal fitness records, or attack details in a public
issue. If private vulnerability reporting is enabled, use the repository's Security
tab and "Report a vulnerability". If that button is unavailable, request a private
reporting channel without posting the sensitive material. Maintainers must enable
[private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
before inviting public reports.

## Scope

Particularly interested in:

- Content that reliably makes the agent act on embedded instructions: a program file,
  image, PDF, Notion page, or web page that gets it to read secrets, write files, or make
  outbound requests.
- Ways an incoming Telegram message could make the agent leak secrets or run
  unintended commands (prompt injection with real impact).
- Bypasses of the `ALLOWED_TELEGRAM_IDS` allowlist or the `CRON_SECRET` check on
  `/cron/run`.
- Secrets ending up in logs, Notion pages, or command output, or slipping past
  `redactSecrets`.

Self-hosting misconfiguration (for example exposing the control plane port publicly)
is covered by the docs rather than this policy, but doc improvements are welcome.
