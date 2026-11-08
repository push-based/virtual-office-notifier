# Running it in production

The bot runs on a GCP Always Free `e2-micro` VM under systemd, and the Console runs as a Cloudflare Worker. There must be exactly one running copy of the bot, otherwise every announcement is posted twice.

Deploys only happen from CI: merging a pull request into `main` runs the checks and then deploys the bot and the Console. Each only ships when what would be deployed differs from what's running, so a merge that changes one of them leaves the other alone, and a merge that changes neither deploys nothing. There are no manual deploys. To change a configuration value, update the GitHub secret and re-run the latest `CI` workflow on `main`; the new value is part of what's compared, so the piece that reads it is deployed again.

- [The VM](#the-vm)
- [Deploying from CI](#deploying-from-ci)
- [What a deploy does](#what-a-deploy-does)
- [Logs](#logs)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## The VM

The VM itself is in the Alchemy program, [`infra/alchemy.run.ts`](../infra/alchemy.run.ts): a Debian 12 `e2-micro` in `us-central1-a`, with the default compute service account, the `default` and `storage-rw` scopes, an external IP (it reaches Discord, Slack and the AI providers through it, as there's no Cloud NAT), OS Login on and deletion protection on. The deploy keeps it that way. A change that would replace it, such as another machine type, fails the deploy instead, because deletion protection stops the old VM from being deleted and Alchemy keeps it even if it's taken out of the program. Changing the machine type or the scopes needs a stopped VM, which is done by hand.

What runs on it is set up by hand once:

1. SSH in (`gcloud compute ssh virtual-office-notifier --zone=us-central1-a`) and install Node 26 from NodeSource:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_26.x | sudo bash -
   sudo apt-get install -y nodejs
   ```

2. Create the service user and app directory:

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin notifier
   sudo mkdir -p /opt/virtual-office-notifier
   ```

The deploy writes the env file and installs the systemd unit, so there's nothing else to do on the VM. Set up CI below; the first deploy starts the service.

## Deploying from CI

The `deploy` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) authenticates to GCP through Workload Identity Federation, so there's no service account key to leak, and only pushes to `main` on this repo can get a token.

Who the deploy is, and what it may do, is a second Alchemy stack, [`infra/admin.run.ts`](../infra/admin.run.ts). CI never deploys it, so CI can't grant itself anything. It holds:

- the `github-deploy` service account;
- the `github` Workload Identity pool and its OIDC provider, which only trust pushes to `main` on `push-based/virtual-office-notifier`;
- what `github-deploy` may do: act as the VM's service account, SSH and sudo on the VM through OS Login, read the project's metadata and wait on VM changes through the custom `githubDeployProjectReader` role, and manage the recordings bucket. Only pushes to `main` can act as it;
- the read-only `github-plan` service account the `plan` job on pull requests acts as, with the custom `githubPlanReader` role: it can read the VM and the bucket, and change nothing;
- the `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT` and `GCP_PLAN_SERVICE_ACCOUNT` repository secrets.

Deploy it from your machine whenever it changes, logged in to `gcloud` as a project owner and to `gh` as a repo admin, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_DEPLOY_TOKEN` in the root `.env` for the state store. Look at the plan first:

```bash
vp run infra#admin-plan
```

```bash
vp run infra#admin-deploy
```

On a new GCP project, turn on the APIs it needs first with `gcloud services enable iamcredentials.googleapis.com oslogin.googleapis.com`, and the VM needs `enable-oslogin=TRUE` in its metadata.

The repository secrets:

| Secret                                                                                                     | Source                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`                                                                           | Set by the admin stack: the Workload Identity provider                                                                                                              |
| `GCP_SERVICE_ACCOUNT`                                                                                      | Set by the admin stack: the `github-deploy` service account email                                                                                                   |
| `DISCORD_BOT_TOKEN`, `DISCORD_OFFICE_CHANNEL_ID`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID` | Your local `.env`                                                                                                                                                   |
| `DATABASE_URL`                                                                                             | The Supabase session pooler connection string. See [Database](setup.md#database).                                                                                   |
| `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `RECORDINGS_BUCKET`, `SENTRY_DSN`   | Optional, your local `.env`                                                                                                                                         |
| `CLOUDFLARE_DEPLOY_TOKEN`                                                                                  | Set by hand, not from `.env`: the token Alchemy deploys the Console with. See [Worker](setup.md#worker). Without it, the deploy job fails before shipping anything. |
| `SENTRY_CONSOLE_DSN`                                                                                       | Optional, the Console's own Sentry project. See [Sentry](setup.md#sentry).                                                                                          |

What each variable means is in [Configuration](setup.md#configuration). `CLOUDFLARE_ACCOUNT_ID` is also part of the Console build's cache fingerprint, so the deploy job sets it for every step.

GitHub secrets are the source of truth for the app's configuration. To change a value, update the secret and re-run the latest `CI` workflow on `main`:

```bash
gh secret set SLACK_BOT_TOKEN
```

Deploys run one at a time and are never cancelled halfway through a restart. A newer push to a pull request cancels the run before it, but runs on `main` all finish, since they can end in a deploy.

## What a deploy does

The `deploy` job runs after the `check` job built and tested every package for the commit, and restores that run's task cache, so the bot's build replays instead of running again. Nothing in the job looks at which files the merge touched: each piece compares what it's about to ship with what's live, and stops when they're the same.

The bot's `deploy` task bundles the bot and runs [`apps/bot/scripts/deploy.ts`](../apps/bot/scripts/deploy.ts):

1. Builds the env file's lines from the configuration variables. It sets `SENTRY_ENVIRONMENT` to `production` and `SENTRY_RELEASE` to the commit SHA.
2. Fingerprints the release: a SHA-256 over `apps/bot/dist/main.js`, its source map, the version of DAVE's native add-on it packs, the systemd unit and the env file without its `SENTRY_RELEASE` line ([`apps/bot/scripts/Release.ts`](../apps/bot/scripts/Release.ts)). The bundle is a deterministic build, so the same sources give the same fingerprint on any runner.
3. Writes the env file into a temporary directory, so secrets never land in the working tree, and downloads the one dependency that can't be bundled, DAVE's native add-on for Linux x64 (`@snazzah/davey`, which `@discordjs/voice` needs to decrypt [recorded](recording.md) audio), with `npm pack`, packed as a small `node_modules` tree.
4. Copies the bundle, its source map, that archive, the systemd unit, the env file and the fingerprint to the VM over one `gcloud compute ssh` connection, with a one-hour SSH key. It's always one connection: a second one re-registers the runner's key in OS Login with a new expiry, and the VM refuses it for a moment.
5. On the VM, if the fingerprint equals the one in `/opt/virtual-office-notifier/release` and the service is active, it prints `The bot already runs this release. Nothing to deploy.` and stops: the bot keeps running, and keeps reporting to Sentry under the commit that actually built it. Otherwise it installs everything under `/opt/virtual-office-notifier` and `/etc`, replacing the previous `node_modules`, reloads systemd, enables the service and restarts it.
6. Waits 15 seconds and fails, printing the last 50 log lines, if the service isn't running. The fingerprint is only written once that check passes, so a deploy that failed is never recorded and the next run deploys again. A service that stopped is deployed again too, whatever its fingerprint says.

Last, the `infra` package's `deploy` task runs `alchemy deploy --stage prod` on [`infra/alchemy.run.ts`](../infra/alchemy.run.ts), the infrastructure described in code with [Alchemy](https://alchemy.run). It hashes the Console's inputs, its own files, the lockfile and the libs its build imported, and when they haven't changed since the last deploy it leaves the Worker alone. When they have, it builds the Console, page and Worker, with Vite and deploys it as the `virtual-office-recorder` Worker, binding the `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` and `SENTRY_CONSOLE_DSN` repository secrets as secrets, `SENTRY_ENVIRONMENT` as `production` and the Hyperdrive config as `DATABASE`. The Console's Sentry release isn't a binding, since a binding that changed on every commit would make every merge a Console deploy: the build bakes the commit SHA in as `__SENTRY_RELEASE__`, from `GITHUB_SHA`, so the release is the commit that last changed the Console. The Worker reports it and hands it to the page over `/api/telemetry`, and Sentry's browser SDK reads that global on its own too. Alchemy also keeps the Hyperdrive config and the Supabase CA it trusts as described in [Hyperdrive](setup.md#hyperdrive), with the password from the `ACTIVITY_DATABASE_PASSWORD` secret, and the VM, the clips bucket and its IAM bindings, all diffed against its state so only what changed is touched.

A merge used to restart the bot whatever it changed. It doesn't any more: a bot that's running the release it would get is left alone, with its voice connection and any recording intact. To restart it by hand, SSH in and run `sudo systemctl restart virtual-office-notifier`.

On a pull request, the `plan` job runs `alchemy plan --stage prod` and shows what merging it would change. It uses placeholders for the secrets, which a plan can't compare anyway. Alchemy keeps what it owns in a state store in the Cloudflare account, the `alchemy-state-store` Worker, and creates it on the first deploy if it's missing. Telemetry to Alchemy is turned off.

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

- **Issues.** A crash, including at startup, is an error. A Slack call that only failed after retries is a warning; lost access or a rejected payload is an error. Discord client errors are errors, and every AI model failing to write a headline or reply is a warning. So is Clef failing. A voice join that doesn't connect within 20 seconds is a warning, `Couldn't join the office voice channel`, once until a join works again, with the same history as below. Losing the voice connection while recording is a warning, the first time in each recording, with the step the connection was stuck at and how the join went: when the bot asked to join, when Discord sent the voice state and server, each step after that and any voice WebSocket close code, timed from the join. A dropped Slack Socket Mode connection is only reported when reconnecting has failed three times in a row, since Slack drops them now and then. Recording requests, edits, the recording status and clips the bot can't read or write are a warning once per outage for each, and again only after it recovered; a row that doesn't decode is an error, since that's a bug rather than an outage. For the [database](database.md), every retry while it's unreachable and every update it rejects is a warning, and an update that could only be logged, or a database client that couldn't be created, is an error. These never include the update itself.
- **Traces.** Each announcement is its own trace: the Slack post with each attempt, and the AI model calls. So is each batch of recording requests or edits and each transcribed clip the bot handles. Checking for them while there's nothing to do isn't traced. HTTP client spans are turned off, so request details never leave the VM. Each voice join is an `OfficeVoice.join` span, and each recording's wait for that connection a `VoiceCapture.connect` span, with the step it got to (`voice.step`) and the same join history (`voice.history`), so slow joins show up even when they connect.
- **Logs.** Every log line, linked to the trace it was logged in. Only the message is sent, not the annotations.

### The Console

With `SENTRY_CONSOLE_DSN` set, the Console reports to a Sentry project of its own, from both the Worker ([`apps/console/worker/Observability.ts`](../apps/console/worker/Observability.ts), through [`@sentry/cloudflare`](https://docs.sentry.io/platforms/javascript/guides/cloudflare/)) and the page ([`apps/console/src/app/telemetry/telemetry.ts`](../apps/console/src/app/telemetry/telemetry.ts), through [`@sentry/angular`](https://docs.sentry.io/platforms/javascript/guides/angular/)).

- **Issues.** A defect or a `5xx` in an `/api/*` handler is an error, using its `[ErrorReporter.severity]` when it has one; a `4xx` isn't reported. On the page, every error that reaches Angular's `ErrorHandler` is an error. A `GET` the page gave up on after its retries, or a `POST`, that got no answer or a 502, 503 or 504 is a warning, `<url> kept answering <status>`, with the response's status, its `retry-after`, `cf-ray`, `server`, `via` and `content-type` headers and the first 200 characters of its body; each retry before that is a breadcrumb with the same details.
- **Traces.** Each `/api/*` request is a trace named after its route, like `GET /api/recordings/:id`. The page's load and its `/api/*` calls are traced too, and join the Worker's traces.
- **Logs.** The Worker's log lines, with the message only.

The page runs inside Discord's Activity frame, which only lets it reach mapped URLs. So it asks the Worker where to report at `/api/telemetry`, and sends everything to `POST /api/sentry`, which forwards it to Sentry only if it's for the Console's DSN. That traffic isn't traced, and without a DSN both routes are off.

Both projects fit in Sentry's free Developer plan: the office sees a handful of errors and a few thousand spans a month, against 5,000 errors and 5 million spans shared by every project.

What Sentry does and doesn't receive about people is in [Privacy](privacy.md#sentry).

## Troubleshooting

| Symptom                                                         | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exits at startup naming a variable                              | It's missing or empty. Check `.env` locally, or the GitHub secret in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Office voice channel not found` in the logs                    | `DISCORD_OFFICE_CHANNEL_ID` is wrong, or the bot isn't in the server or can't view the channel. It keeps running in case the bot is added later, but reminders stay off until it restarts.                                                                                                                                                                                                                                                                                                                                                 |
| Every announcement shows up twice                               | Two copies are running, for example `pnpm --filter bot dev` with the production tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Slack rejected the post` with `AccessRevoked`                  | The token was revoked, the app uninstalled, or the bot isn't in the channel. Reinstall the app or invite the bot, and update the secrets.                                                                                                                                                                                                                                                                                                                                                                                                  |
| The bot never answers in Slack                                  | Check `office.responder_settings.enabled` (see [Answering in Slack](slack.md#answering-in-slack)), then `office.slack_decisions` for why. No rows at all means the events aren't arriving: look for `Lost the Slack connection, reconnecting` warnings and check the app's Socket Mode, events and scopes.                                                                                                                                                                                                                                 |
| No banter shows up                                              | Look for `Skipped banter` warnings: the reason says why the database couldn't be read. Without the database there's no banter at all. If every AI model failed, the log says `Nothing to announce, no AI model wrote the banter`. Banter that disappears the next morning is [quiet banter](slack.md#banter) that nobody reacted to or replied under; `deleted_at` in `office.slack_posts` says when.                                                                                                                                      |
| Posts always use the fixed headlines                            | Every AI model is failing. Look for `AI model couldn't write it` warnings and their reason. `DailyLimit` means the OpenRouter key has used up its free requests for the day.                                                                                                                                                                                                                                                                                                                                                               |
| `Couldn't set up the database, retrying` in the logs            | The bot can't reach the database or run the migrations. The `reason` says why, for example a wrong password in `DATABASE_URL` or a paused Supabase project. Announcements carry on, and observations are buffered until it connects. See [When the database is down](database.md#when-the-database-is-down).                                                                                                                                                                                                                               |
| `Couldn't record to the database, retrying` in the logs         | The database went away after connecting, or a write took over 10 seconds. Writing resumes where it left off once it's back.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `The database rejected an update` in the logs                   | Postgres refused a row. It's in `office.rejected_updates` with the error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `logging this instead` or `logging it instead` in the logs      | Something couldn't be stored at all: the buffer was full, the bot was shutting down, or setting it aside failed too. The `entry` annotation has the full JSON.                                                                                                                                                                                                                                                                                                                                                                             |
| The service has stopped and isn't restarting                    | systemd gave up after 5 failed starts in 10 minutes. Check the logs, then merge a fix, or update the secret and re-run the latest `CI` workflow on `main`. A stopped service is always deployed again, even when the release hasn't changed.                                                                                                                                                                                                                                                                                               |
| The Console says `The bot isn't in the office yet`              | The bot hasn't seen anyone join, or `office.recording_status` isn't being updated: look for `Couldn't update the recording status` warnings.                                                                                                                                                                                                                                                                                                                                                                                               |
| `Couldn't reach the bot: … answered 503` that clears on its own | Discord's Activity proxy (`discordsays.com`) sometimes answers 503 without passing the request on, so the Worker never sees it: the page's Sentry trace has the failed call but no Worker span. The page asks again up to 3 times, 2 seconds apart, for any `GET` that got no answer or a 502, 503 or 504, and only shows the notice once those fail too. It never repeats a `POST`. Giving up is a Sentry warning with the proxy's answer: a `retry-after` header or a rate-limit message in the body means the page is asking too often. |
| Pressing Start does nothing                                     | Check `office.recording_requests`: no row means the Worker can't reach the database through Hyperdrive (the page says `/api/status answered 503`; check the Hyperdrive config's credentials); a row with no `outcome` means the bot isn't reading them (`Couldn't handle recording requests` in the logs: `the database isn't available` is an outage, `a row couldn't be read` is a bug); `ignored` says why. See [Starting and stopping](recording.md#starting-and-stopping).                                                            |
| A summary stays on `Rewriting…`                                 | The recording's `summary_rewrite_edit_id` is still set. Look for `Couldn't rewrite the summary, trying again later` or `Gave up rewriting the summary` in the logs; the bot tries again at its next restart.                                                                                                                                                                                                                                                                                                                               |
| A title or agenda stays on `Saving…`                            | Check `office.recording_edits`: no row means the Worker couldn't store it (`/api/recordings/<id>/edits answered 503`, often a missing `GRANT` on `recording_edits` or its sequence); a row with no `outcome` means the bot isn't applying them (`Couldn't apply recording edits` in the logs). A title or tick that's applied but not in Slack logs `Couldn't update the recording's summary in Slack`.                                                                                                                                    |
| The Stats tab says `/api/stats answered 503`                    | The Worker couldn't read the stats; `Couldn't read the office stats` in its [logs](#logs) has the `reason`. `permission denied` means the `activity` role is missing the `GRANT SELECT` on `office.voice_activity` and `office.office_activity` from the [database role](setup.md#database-role); the Now tab still works without it. Once it's fixed, press **Try again**.                                                                                                                                                                |
| `Lost the office voice connection, joining again` in the logs   | The bot's voice connection in the office didn't connect within 20 seconds, or dropped and didn't come back within 5. It joins again 5 seconds later. The `Couldn't join the office voice channel` Sentry warning has the step it was stuck at and its history. Recordings carry on once it's back.                                                                                                                                                                                                                                         |
| `Lost the voice connection, rejoining` in the logs              | The bot rejoins 5 seconds later, and nothing is recorded until it's back. The Sentry warning's `reason` says where the connection stopped, and its `history` shows the steps before that: `stuck at signalling` means Discord never sent the voice server or state, `connecting (UDP handshake)` means the one UDP packet that finds the bot's address was lost, and any other step is the voice WebSocket.                                                                                                                                |
| Clips are recorded but never transcribed                        | Look for `Couldn't reach the transcriber` or `daily allocation is used up` warnings. The clips stay `pending` and are picked up when Workers AI is back.                                                                                                                                                                                                                                                                                                                                                                                   |
| `Couldn't change the bot's nickname` in the logs                | Give the bot the Change Nickname permission (see [Discord Activity](setup.md#discord-activity)). Recording still works without it.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Couldn't archive a clip` in the logs                           | The VM can't write to the bucket: check its scopes and the service account's roles on the bucket (see [Cloud Storage](setup.md#cloud-storage)). The clip was still transcribed from memory.                                                                                                                                                                                                                                                                                                                                                |
