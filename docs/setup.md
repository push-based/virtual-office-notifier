# Setting it up

How to run the bot against your own Discord server and Slack workspace, and how to switch on each of the optional parts. The order below is the order you'd turn them on: the bot alone first, then AI headlines, the database, the Console and Sentry.

- [What you need](#what-you-need)
- [Discord bot](#discord-bot)
- [Slack app](#slack-app)
- [Configuration](#configuration)
- [AI providers](#ai-providers)
- [Database](#database)
- [Console](#console)
- [Sentry](#sentry)

## What you need

Node 26 (see [`.nvmrc`](../.nvmrc)), pnpm, a [Discord bot](#discord-bot) and a [Slack app](#slack-app). The pnpm version is pinned in [`package.json`](../package.json), and `corepack enable` picks it up.

```bash
git clone https://github.com/push-based/virtual-office-notifier.git
cd virtual-office-notifier
pnpm install
cp .env.example .env   # then fill in the values
pnpm --filter bot dev
```

Once it logs `Watching the virtual office`, join the office and the post should show up in Slack.

> [!WARNING]
> Use a separate Discord bot and Slack app for local runs while production is running. Two copies watching the same office post every announcement twice.

## Discord bot

1. Create an application at <https://discord.com/developers/applications> and add a bot. Revealing the token requires the account password.
2. Under **Bot**, turn off **Public Bot**. No privileged intents are needed; the bot only uses `Guilds`, `GuildVoiceStates` and `GuildExpressions` (to keep the server's soundboard sound names up to date).
3. Under **OAuth2 → URL Generator**, pick the `bot` scope with the **View Channels**, **Connect**, **Send Messages** and **Move Members** permissions, open the URL and add the bot to the server. Without **Connect** it can't join the office, so soundboard sounds and emoji aren't recorded. Without **Move Members** it can't show people out who don't [agree to being recorded](privacy.md#consent), and without **Send Messages** it can't ask someone whose DMs are closed. It logs a warning at startup when **Connect** or **Move Members** is missing.

The bot token goes in `DISCORD_BOT_TOKEN`, and the office's channel ID in `DISCORD_OFFICE_CHANNEL_ID` (Developer Mode → right-click the channel → Copy Channel ID).

[Recording the office](recording.md) needs one more permission and a Discord Activity; see [Discord Activity](#discord-activity) under the Console.

## Slack app

1. Create an app at <https://api.slack.com/apps> → **From scratch** → pick the workspace, or open the app that had the old webhook.
2. **Settings → Socket Mode** → turn it on, and create an app-level token with the `connections:write` scope. That's `SLACK_APP_TOKEN`.
3. **Features → OAuth & Permissions → Bot Token Scopes**: add `chat:write`, `reactions:write`, `reactions:read`, `app_mentions:read`, `channels:history` and `users:read`. If the channel is private, add `groups:history` too.
4. **Features → Event Subscriptions** → turn it on and subscribe to the bot events `app_mention`, `message.channels`, `reaction_added` and `reaction_removed`, plus `message.groups` for a private channel. With Socket Mode on, there's no request URL to fill in.
5. Leave **Interactivity** off. The join buttons only open a link.
6. **Install to Workspace**, and copy the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`.
7. Invite the bot to the channel (`/invite @your-bot`), and copy the channel ID (channel details → **About**, at the bottom) into `SLACK_CHANNEL_ID`.

[Recording the office](recording.md) needs one more scope, so the transcript can be attached; see [Slack scope](#slack-scope) under the Console.

## Configuration

All of the bot's configuration comes from environment variables, read in [`apps/bot/src/Config.ts`](../apps/bot/src/Config.ts). Copy [`.env.example`](../.env.example) to `.env` for local runs. `.env` is git-ignored and must never be committed.

| Variable                    | Required     | Description                                                                                                                                                                                        |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`         | Yes          | Bot token from the Discord Developer Portal. Secret.                                                                                                                                               |
| `DISCORD_OFFICE_CHANNEL_ID` | Yes          | ID of the office voice channel (Developer Mode → right-click the channel → Copy Channel ID).                                                                                                       |
| `SLACK_BOT_TOKEN`           | Yes          | The Slack app's bot token (`xoxb-…`). Secret: anyone with it can post as the bot.                                                                                                                  |
| `SLACK_APP_TOKEN`           | Yes          | The Slack app's app-level token (`xapp-…`) with `connections:write`, for Socket Mode. Secret.                                                                                                      |
| `SLACK_CHANNEL_ID`          | Yes          | ID of the Slack channel announcements, reminders and banter go to, and the only one the bot answers in.                                                                                            |
| `OPENROUTER_API_KEY`        | No           | [OpenRouter](https://openrouter.ai/settings/keys) API key for [AI headlines](slack.md#ai-headlines). Secret.                                                                                       |
| `OPENROUTER_MODELS`         | No           | Comma-separated OpenRouter models to try, preferred first. Defaults to `DEFAULT_OPENROUTER_MODELS` in [`apps/bot/src/Config.ts`](../apps/bot/src/Config.ts).                                       |
| `OPENROUTER_BANTER_MODELS`  | No           | Comma-separated OpenRouter models to try for [banter](slack.md#banter), preferred first. Defaults to `DEFAULT_OPENROUTER_BANTER_MODELS` in [`apps/bot/src/Config.ts`](../apps/bot/src/Config.ts).  |
| `CLOUDFLARE_ACCOUNT_ID`     | No           | Cloudflare account ID, for AI headlines from Workers AI. Needs `CLOUDFLARE_API_TOKEN` too.                                                                                                         |
| `CLOUDFLARE_API_TOKEN`      | No           | Workers AI API token. Secret.                                                                                                                                                                      |
| `CLOUDFLARE_MODELS`         | No           | Comma-separated Workers AI models to try, preferred first. Defaults to `DEFAULT_CLOUDFLARE_MODELS` in [`apps/bot/src/Config.ts`](../apps/bot/src/Config.ts), all within the free daily allocation. |
| `DATABASE_URL`              | Deploys only | Supabase session pooler connection string, for the [database](database.md). Secret. Optional locally, where leaving it out records nothing; the deploy fails without it.                           |
| `RECORDINGS_BUCKET`         | No           | The Cloud Storage bucket [recorded](recording.md#what-the-bot-captures) clips are archived in. Without it, clips are only kept in memory until they're transcribed.                                |
| `WHISPER_MODEL`             | No           | The Workers AI model that transcribes clips. Defaults to `@cf/openai/whisper-large-v3-turbo`.                                                                                                      |
| `TRANSCRIPTION_LANGUAGE`    | No           | The language people speak in the office, as Whisper names it. Defaults to `en`.                                                                                                                    |
| `SENTRY_DSN`                | No           | [Sentry](#sentry) project DSN. Without it, nothing is sent to Sentry.                                                                                                                              |
| `SENTRY_ENVIRONMENT`        | No           | Environment to tag Sentry data with. Defaults to `development`; the deploy sets `production`.                                                                                                      |
| `SENTRY_RELEASE`            | No           | Release to tag Sentry data with. The deploy sets it to the SHA of the commit that last changed the bot.                                                                                            |

The process exits at startup with an error naming the variable if a required one is missing. A blank optional key, account ID or database URL counts as unset.

`OPENROUTER_MODELS`, `OPENROUTER_BANTER_MODELS`, `CLOUDFLARE_MODELS`, `WHISPER_MODEL` and `TRANSCRIPTION_LANGUAGE` aren't passed through the deploy, so production always uses the defaults. Change those in [`apps/bot/src/Config.ts`](../apps/bot/src/Config.ts).

In production, GitHub repository secrets are the source of truth for every variable above, and the deploy writes them to the VM. [Deploying from CI](operations.md#deploying-from-ci) covers how to change one. The Console has a few secrets of its own, which aren't environment variables of the bot:

| Secret                                                   | Where it's set                              | What it's for                                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_DEPLOY_TOKEN`                                | GitHub repository secret                    | A Cloudflare API token that lets the deploy job run `alchemy deploy`, which deploys the Console's Worker. Without it, the deploy job fails before shipping anything. See [Worker](#worker). |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`             | GitHub repository secrets                   | The Discord application's OAuth2 credentials, for signing people in to the Console. See [Worker](#worker).                                                                                  |
| `SESSION_SECRET`                                         | GitHub repository secret                    | Any long random string. It signs the sessions the page gets after Discord's login. See [Worker](#worker).                                                                                   |
| `ACTIVITY_DATABASE_PASSWORD`                             | GitHub repository secret                    | The `activity` role's password, which Hyperdrive connects to Supabase with. See [Hyperdrive](#hyperdrive).                                                                                  |
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DATABASE` | Your shell, for `pnpm --filter console dev` | A local Postgres for the Worker's `DATABASE` binding. See [Toolchain](../CONTRIBUTING.md#toolchain).                                                                                        |

## AI providers

Optional. With neither provider configured, every post uses the fixed phrasings. How the headlines, banter and replies are written, and which model goes first, is in [AI headlines](slack.md#ai-headlines).

### OpenRouter

Create a key at <https://openrouter.ai/settings/keys> and put it in `OPENROUTER_API_KEY`.

Free models come and go on OpenRouter. To change the list, pick from the [free models](https://openrouter.ai/models?max_price=0) and set `OPENROUTER_MODELS`, preferred model first. Without credits, a key gets 50 free requests a day, or 1,000 with at least $10 of credit; once that's used up, the bot skips the rest of OpenRouter's models for the day.

### Cloudflare Workers AI

1. Sign up at <https://dash.cloudflare.com/sign-up/workers-and-pages>. New accounts are on the Workers Free plan.
2. Go to **Workers AI** → **Use REST API** → **Create a Workers AI API Token**, and copy the token into `CLOUDFLARE_API_TOKEN`.
3. Copy the **Account ID** from the same page into `CLOUDFLARE_ACCOUNT_ID`.

Workers AI includes 10,000 Neurons a day for free, which covers a few hundred headlines on the default models. [Clef](slack.md#answering-in-slack), Slack replies and [transcription](recording.md#what-the-bot-captures) come out of the same allowance, so replies try OpenRouter first. When Cloudflare says the day's allowance is used up, the rest of its models are skipped, like OpenRouter's daily limit.

## Database

The bot records voice activity in the office to a Postgres database on [Supabase](https://supabase.com). [Banter](slack.md#banter), [answering in Slack](slack.md#answering-in-slack), [recording](recording.md) and [office stats](recording.md#office-stats) all need it. What ends up in it is in [The database](database.md). The design is in [issue #10](https://github.com/push-based/virtual-office-notifier/issues/10).

1. Create a project at <https://supabase.com/dashboard>.
2. Click **Connect**, pick the **Session pooler** connection string, and put it in `DATABASE_URL` with the database password filled in. Percent-encode any special characters in the password.

Use the session pooler, not the direct connection: the direct one is IPv6-only unless the project has the IPv4 add-on, and GCP VMs only have IPv4 by default. The transaction pooler (port 6543) doesn't support the prepared statements the client uses.

Locally, leave `DATABASE_URL` out unless you mean to record. `pnpm --filter bot dev` with the production URL writes into the production data.

## Console

The Console is the Discord Activity people open to [record the office](recording.md), browse the recording history and see the office stats. It needs the [database](#database), the bot's Cloudflare account for Whisper, a Discord Activity for the page, and a Cloudflare Worker to serve it. Everything below is done once, outside the code.

### Discord Activity

In the Developer Portal, give the bot the **Change Nickname** permission (re-run the OAuth URL from [Discord bot](#discord-bot) with it ticked, or grant it in the server's role settings), so it can rename itself `🔴 Recording` while it listens. Under **OAuth2**, add `https://127.0.0.1` as a redirect and note the **Client ID** and **Client Secret** for the [Worker](#worker). Under **Activities → Settings**, enable Activities; under **Activities → URL Mappings**, map `/` to the Worker's `workers.dev` host (without `https://`), once it's deployed.

### Slack scope

Add the `files:write` bot scope to the app from [Slack app](#slack-app) and reinstall it, so the transcript can be attached to the summary.

### Cloud Storage

The clips bucket, `virtual-office-notifier-recordings`, is in the Alchemy program, [`infra/alchemy.run.ts`](../infra/alchemy.run.ts): private, in `us-central1`, with no lifecycle rule that deletes objects, and with **Storage Object Creator** and **Storage Object Viewer** for the VM's service account. Alchemy never deletes it or its objects, even if it's taken out of the program. The VM's `storage-rw` scope is part of the [VM](operations.md#the-vm) in the same program. Set the bucket's name as the `RECORDINGS_BUCKET` secret:

```bash
gh secret set RECORDINGS_BUCKET --body virtual-office-notifier-recordings
```

### Database role

The Worker never gets the bot's `DATABASE_URL`. It reads and writes through a role of its own. In the Supabase SQL editor, with a password of your own:

```sql
CREATE ROLE activity LOGIN PASSWORD 'change-me';
GRANT USAGE ON SCHEMA office TO activity;
GRANT SELECT ON office.recording_status, office.recordings, office.members TO activity;
GRANT SELECT ON office.voice_activity, office.office_activity TO activity;
GRANT SELECT ON office.recording_clips TO activity;
GRANT SELECT, INSERT ON office.recording_requests TO activity;
GRANT USAGE ON SEQUENCE office.recording_requests_id_seq TO activity;
GRANT SELECT, INSERT ON office.recording_edits TO activity;
GRANT USAGE ON SEQUENCE office.recording_edits_id_seq TO activity;
GRANT SELECT ON office.recording_action_items TO activity;
GRANT SELECT ON office.consent_events TO activity;
GRANT SELECT, INSERT ON office.consent_requests TO activity;
GRANT USAGE ON SEQUENCE office.consent_requests_id_seq TO activity;
```

The views aren't `security_invoker`, so the role reads them without any grant on the tables underneath. Without the grant on `office.voice_activity` and `office.office_activity`, the [Stats](recording.md#office-stats) tab answers `503` and the rest of the Console works as before.

### Hyperdrive

Workers can't open a TLS connection to Supabase themselves, because they only trust public certificate authorities and Supabase signs its database certificates with its own. So the Worker reaches the database through [Hyperdrive](https://developers.cloudflare.com/hyperdrive/), which connects to Supabase as the `activity` role and checks Supabase's certificate against its root CA.

Both are in the Alchemy program, [`infra/alchemy.run.ts`](../infra/alchemy.run.ts): the `supabase-root-2021` CA, uploaded from [`apps/bot/src/database/SupabaseCa.ts`](../apps/bot/src/database/SupabaseCa.ts) so the bot and Hyperdrive trust the same certificate, and the `virtual-office-recorder-db` config with `verify-full` against it and caching off, so the Console always sees the current state. The pooler host and project ref in it are the ones in the bot's `DATABASE_URL`. The deploy reads the `activity` role's password from the `ACTIVITY_DATABASE_PASSWORD` repository secret:

```bash
gh secret set ACTIVITY_DATABASE_PASSWORD
```

To rotate the password, change it in the Supabase SQL editor, update the secret and re-run the latest `CI` workflow on `main`. Until the deploy finishes, the Console can't reach the database. Right after the role's password changes the pooler can refuse it for a few seconds, and Alchemy retries the Hyperdrive update while it does.

[`apps/console/wrangler.jsonc`](../apps/console/wrangler.jsonc) keeps the config's ID for local development, where the `DATABASE` binding points at a local Postgres instead.

### Worker

The Worker lives in [`apps/console/worker/`](../apps/console/worker). CI deploys it, with the page, through the Alchemy program in [`infra/alchemy.run.ts`](../infra/alchemy.run.ts), which builds the Console with Vite and sets the Worker's bindings and secrets. Create an API token in Cloudflare with the **Edit Cloudflare Workers** template, add **Account → Secrets Store: Edit** (for Alchemy's state store), **Account → Hyperdrive: Edit** and **Account → SSL and Certificates: Edit**, and store it as the `CLOUDFLARE_DEPLOY_TOKEN` repository secret; the Workers AI token stays as it is. Without it, the deploy job fails before shipping anything, so the bot and the Console always go out together. Then store the Worker's own secrets as repository secrets; the next deploy binds them:

```bash
gh secret set DISCORD_CLIENT_ID
gh secret set DISCORD_CLIENT_SECRET
openssl rand -base64 48 | gh secret set SESSION_SECRET
```

`DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are the ones from [Discord Activity](#discord-activity). `SESSION_SECRET` is any long random string; it signs the sessions the page gets after Discord's login. The first deploy prints the `workers.dev` host for the URL mapping above.

## Sentry

Optional. With `SENTRY_DSN` set, the bot sends errors, traces and logs to [Sentry](https://sentry.io), and with `SENTRY_CONSOLE_DSN` set, so does the Console; what it sends is in [Monitoring](operations.md#monitoring). To turn it on, create a Node.js project in Sentry and set its DSN as a repository secret, then re-run the latest `CI` workflow on `main`:

```bash
gh secret set SENTRY_DSN
```

The Console reports to a project of its own. Create an Angular project in Sentry, then set its DSN and re-run the latest `CI` workflow on `main`:

```bash
gh secret set SENTRY_CONSOLE_DSN
```
