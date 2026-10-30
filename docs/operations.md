# Running it in production

The bot runs on a GCP Always Free `e2-micro` VM under systemd, and the Console runs as a Cloudflare Worker. There must be exactly one running copy of the bot, otherwise every announcement is posted twice.

Deploys only happen from CI: merging a pull request into `main` runs the checks and then deploys the bot and the Console together. There are no manual deploys. To change a configuration value, update the GitHub secret and re-run the latest `CI` workflow on `main`.

- [The VM](#the-vm)
- [Deploying from CI](#deploying-from-ci)
- [What a deploy does](#what-a-deploy-does)
- [Logs](#logs)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## The VM

One-time setup:

1. Create the VM (Debian 12, `e2-micro`, `us-central1`):

   ```bash
   gcloud compute instances create virtual-office-notifier \
     --machine-type=e2-micro --zone=us-central1-a \
     --image-family=debian-12 --image-project=debian-cloud
   ```

2. SSH in (`gcloud compute ssh virtual-office-notifier --zone=us-central1-a`) and install Node 26 from NodeSource:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_26.x | sudo bash -
   sudo apt-get install -y nodejs
   ```

3. Create the service user and app directory:

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin notifier
   sudo mkdir -p /opt/virtual-office-notifier
   ```

The deploy writes the env file and installs the systemd unit, so there's nothing else to do on the VM. Set up CI below; the first deploy starts the service. For [recording](recording.md), the VM also needs access to the clips bucket, which means a scope change and one restart: see [Cloud Storage](setup.md#cloud-storage).

## Deploying from CI

The `deploy` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) authenticates to GCP through Workload Identity Federation, so there's no service account key to leak, and only pushes to `main` on this repo can get a token.

One-time setup, from the repo root with `gcloud` on the right project and `gh` logged in to the repo owner's account:

```bash
scripts/setup-ci.sh
```

This creates a `github-deploy` service account and a Workload Identity pool trusting this repo's `main` branch, turns on OS Login for the VM, and grants the account SSH and sudo there. It then stores these repository secrets:

| Secret                                                                                                     | Source                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`                                                                           | The Workload Identity provider created above                                                                                                                           |
| `GCP_SERVICE_ACCOUNT`                                                                                      | The `github-deploy` service account email                                                                                                                              |
| `DISCORD_BOT_TOKEN`, `DISCORD_OFFICE_CHANNEL_ID`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID` | Your local `.env`                                                                                                                                                      |
| `DATABASE_URL`                                                                                             | The Supabase session pooler connection string. See [Database](setup.md#database).                                                                                      |
| `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `RECORDINGS_BUCKET`, `SENTRY_DSN`   | Optional, your local `.env`                                                                                                                                            |
| `CLOUDFLARE_DEPLOY_TOKEN`                                                                                  | Set by hand, not from `.env`: the token `wrangler` deploys the Console with. See [Worker](setup.md#worker). Without it, the deploy job fails before shipping anything. |
| `SENTRY_CONSOLE_DSN`                                                                                       | Optional, the Console's own Sentry project. See [Sentry](setup.md#sentry).                                                                                             |

What each variable means is in [Configuration](setup.md#configuration). `CLOUDFLARE_ACCOUNT_ID` is also part of the Console build's cache fingerprint, so the deploy job sets it for every step.

GitHub secrets are the source of truth for the app's configuration. To change a value, update the secret and re-run the latest `CI` workflow on `main`:

```bash
gh secret set SLACK_BOT_TOKEN
```

Deploys run one at a time and are never cancelled halfway through a restart. A newer push to a pull request cancels the run before it, but runs on `main` all finish, since they can end in a deploy.

## What a deploy does

The `deploy` job builds the Console first, page and Worker, so nothing ships if it fails. It then runs the bot's `deploy` task, which bundles the bot and runs [`apps/bot/scripts/deploy.ts`](../apps/bot/scripts/deploy.ts):

1. Writes the env file from the configuration variables into a temporary directory, so secrets never land in the working tree. It sets `SENTRY_ENVIRONMENT` to `production` and `SENTRY_RELEASE` to the commit SHA.
2. Downloads the one dependency that can't be bundled, DAVE's native add-on for Linux x64 (`@snazzah/davey`, which `@discordjs/voice` needs to decrypt [recorded](recording.md) audio), with `npm pack`, and packs it as a small `node_modules` tree.
3. Copies `apps/bot/dist/main.js`, its source map, that archive, the systemd unit and the env file to the VM over `gcloud compute ssh`, with a one-hour SSH key.
4. Installs them under `/opt/virtual-office-notifier` and `/etc`, replacing the previous `node_modules`, reloads systemd, enables the service and restarts it.
5. Waits 15 seconds and fails, printing the last 50 log lines, if the service isn't running.

Last, the Console's `deploy` task runs `wrangler deploy`, which picks up the Worker and page that were just built through the `wrangler.json` the build generates. It sets the Worker's `SENTRY_DSN` from the `SENTRY_CONSOLE_DSN` secret, `SENTRY_ENVIRONMENT` to `production` and `SENTRY_RELEASE` to the commit SHA.

The [unit](../apps/bot/deploy/virtual-office-notifier.service) runs as the unprivileged `notifier` user with systemd's sandboxing turned on. It restarts 30 seconds after a crash and gives up after 5 failed starts in 10 minutes, so a bad token doesn't keep hammering Discord's login.

## Logs

```bash
gcloud compute ssh virtual-office-notifier --zone=us-central1-a -- journalctl -u virtual-office-notifier -f
```

The Console's Worker logs are in Cloudflare:

```bash
pnpm --filter console exec wrangler tail
```

## Monitoring

With `SENTRY_DSN` set, the bot sends errors, traces and logs to [Sentry](https://sentry.io) through [`@sentry/effect`](https://docs.sentry.io/platforms/javascript/guides/effect/). Everything still goes to the journal as well. Turning it on is a secret and a re-run of CI: see [Sentry](setup.md#sentry).

- **Issues.** A crash, including at startup, is an error. A Slack call that only failed after retries is a warning; lost access or a rejected payload is an error. Discord client errors are errors, and every AI model failing to write a headline or reply is a warning. So are Clef failing and the Slack Socket Mode connection dropping. For the [database](database.md), every retry while it's unreachable and every update it rejects is a warning, and an update that could only be logged, or a database client that couldn't be created, is an error. These never include the update itself.
- **Traces.** Each announcement is its own trace: the Slack post with each attempt, and the AI model calls. HTTP client spans are turned off, so request details never leave the VM.
- **Logs.** Every log line, linked to the trace it was logged in. Only the message is sent, not the annotations.

### The Console

With `SENTRY_CONSOLE_DSN` set, the Console reports to a Sentry project of its own, from both the Worker ([`apps/console/worker/Observability.ts`](../apps/console/worker/Observability.ts), through [`@sentry/cloudflare`](https://docs.sentry.io/platforms/javascript/guides/cloudflare/)) and the page ([`apps/console/src/app/telemetry/telemetry.ts`](../apps/console/src/app/telemetry/telemetry.ts), through [`@sentry/angular`](https://docs.sentry.io/platforms/javascript/guides/angular/)).

- **Issues.** A defect or a `5xx` in an `/api/*` handler is an error, using its `[ErrorReporter.severity]` when it has one; a `4xx` isn't reported. On the page, every error that reaches Angular's `ErrorHandler` is an error.
- **Traces.** Each `/api/*` request is a trace named after its route, like `GET /api/recordings/:id`. The page's load and its `/api/*` calls are traced too, and join the Worker's traces.
- **Logs.** The Worker's log lines, with the message only.

The page runs inside Discord's Activity frame, which only lets it reach mapped URLs. So it asks the Worker where to report at `/api/telemetry`, and sends everything to `POST /api/sentry`, which forwards it to Sentry only if it's for the Console's DSN. That traffic isn't traced, and without a DSN both routes are off.

Both projects fit in Sentry's free Developer plan: the office sees a handful of errors and a few thousand spans a month, against 5,000 errors and 5 million spans shared by every project.

What Sentry does and doesn't receive about people is in [Privacy](privacy.md#sentry).

## Troubleshooting

| Symptom                                                    | Cause                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exits at startup naming a variable                         | It's missing or empty. Check `.env` locally, or the GitHub secret in production.                                                                                                                                                                                                                                                                                                                        |
| `Office voice channel not found` in the logs               | `DISCORD_OFFICE_CHANNEL_ID` is wrong, or the bot isn't in the server or can't view the channel. It keeps running in case the bot is added later, but reminders stay off until it restarts.                                                                                                                                                                                                              |
| Every announcement shows up twice                          | Two copies are running, for example `pnpm --filter bot dev` with the production tokens.                                                                                                                                                                                                                                                                                                                 |
| `Slack rejected the post` with `AccessRevoked`             | The token was revoked, the app uninstalled, or the bot isn't in the channel. Reinstall the app or invite the bot, and update the secrets.                                                                                                                                                                                                                                                               |
| The bot never answers in Slack                             | Check `office.responder_settings.enabled` (see [Answering in Slack](slack.md#answering-in-slack)), then `office.slack_decisions` for why. No rows at all means the events aren't arriving: look for `Lost the Slack connection, reconnecting` warnings and check the app's Socket Mode, events and scopes.                                                                                              |
| No banter shows up                                         | Look for `Skipped banter` warnings: the reason says why the database couldn't be read. Without the database there's no banter at all. If every AI model failed, the log says `Nothing to announce, no AI model wrote the banter`.                                                                                                                                                                       |
| Posts always use the fixed headlines                       | Every AI model is failing. Look for `AI model couldn't write it` warnings and their reason. `DailyLimit` means the OpenRouter key has used up its free requests for the day.                                                                                                                                                                                                                            |
| `Couldn't set up the database, retrying` in the logs       | The bot can't reach the database or run the migrations. The `reason` says why, for example a wrong password in `DATABASE_URL` or a paused Supabase project. Announcements carry on, and observations are buffered until it connects. See [When the database is down](database.md#when-the-database-is-down).                                                                                            |
| `Couldn't record to the database, retrying` in the logs    | The database went away after connecting, or a write took over 10 seconds. Writing resumes where it left off once it's back.                                                                                                                                                                                                                                                                             |
| `The database rejected an update` in the logs              | Postgres refused a row. It's in `office.rejected_updates` with the error.                                                                                                                                                                                                                                                                                                                               |
| `logging this instead` or `logging it instead` in the logs | Something couldn't be stored at all: the buffer was full, the bot was shutting down, or setting it aside failed too. The `entry` annotation has the full JSON.                                                                                                                                                                                                                                          |
| The service has stopped and isn't restarting               | systemd gave up after 5 failed starts in 10 minutes. Check the logs, then merge a fix, or update the secret and re-run the latest `CI` workflow on `main`.                                                                                                                                                                                                                                              |
| The Console says `The bot isn't in the office yet`         | The bot hasn't seen anyone join, or `office.recording_status` isn't being updated: look for `Couldn't update the recording status` warnings.                                                                                                                                                                                                                                                            |
| Pressing Start does nothing                                | Check `office.recording_requests`: no row means the Worker can't reach the database through Hyperdrive (the page says `/api/status answered 503`; check the Hyperdrive config's credentials); a row with no `outcome` means the bot isn't reading them (`Couldn't handle recording requests` in the logs); `ignored` says why. See [Starting and stopping](recording.md#starting-and-stopping).         |
| A summary stays on `Rewriting…`                            | The recording's `summary_rewrite_edit_id` is still set. Look for `Couldn't rewrite the summary, trying again later` or `Gave up rewriting the summary` in the logs; the bot tries again at its next restart.                                                                                                                                                                                            |
| A title or agenda stays on `Saving…`                       | Check `office.recording_edits`: no row means the Worker couldn't store it (`/api/recordings/<id>/edits answered 503`, often a missing `GRANT` on `recording_edits` or its sequence); a row with no `outcome` means the bot isn't applying them (`Couldn't apply recording edits` in the logs). A title or tick that's applied but not in Slack logs `Couldn't update the recording's summary in Slack`. |
| The Stats tab says `/api/stats answered 503`               | The Worker couldn't read the stats; `Couldn't read the office stats` in its [logs](#logs) has the `reason`. `permission denied` means the `activity` role is missing the `GRANT SELECT` on `office.voice_activity` and `office.office_activity` from the [database role](setup.md#database-role); the Now tab still works without it. Once it's fixed, press **Try again**.                             |
| Clips are recorded but never transcribed                   | Look for `Couldn't reach the transcriber` or `daily allocation is used up` warnings. The clips stay `pending` and are picked up when Workers AI is back.                                                                                                                                                                                                                                                |
| `Couldn't change the bot's nickname` in the logs           | Give the bot the Change Nickname permission (see [Discord Activity](setup.md#discord-activity)). Recording still works without it.                                                                                                                                                                                                                                                                      |
| `Couldn't archive a clip` in the logs                      | The VM can't write to the bucket: check its scopes and the service account's roles on the bucket (see [Cloud Storage](setup.md#cloud-storage)). The clip was still transcribed from memory.                                                                                                                                                                                                             |
