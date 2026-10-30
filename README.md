<p align="center"><img src="assets/icon.svg" alt="Virtual Office Notifier icon" width="128"></p>

# Virtual Office Notifier

[![CI](https://github.com/push-based/virtual-office-notifier/actions/workflows/ci.yml/badge.svg)](https://github.com/push-based/virtual-office-notifier/actions/workflows/ci.yml)

Posts to Slack when someone opens our Discord "virtual office" voice channel, and again when it empties out, so people know when they can jump in. On weekdays it also posts a reminder to come hang out, and a few bits of AI-written banter about what's been going on in the office. When someone mentions it or replies under one of its posts, it can answer, react or stay out of it. It also records what happens in the office channel to a Postgres database.

- [Features](#features)
- [What it posts](#what-it-posts)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Development](#development)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Announces the edges of a session only.** The first person in opens the office and the last person out empties it. Joins and leaves in between aren't announced, to keep the Slack channel quiet.
- **Recaps each session** with how long the office was open and how many different people came by.
- **Weekday reminder** at 11:15 UTC+2.
- **Office banter.** Up to five times a working day, at random, an AI model reads what happened in the office and posts something playful about it.
- **Slack cards** with a button that opens the office in Discord, the opener's avatar, and times shown in each reader's own time zone.
- **AI-written headlines** from free models on OpenRouter or Cloudflare Workers AI, falling back to fixed phrasings.
- **Answers in Slack**, but only when an answer is wanted. Mentions always get a reply; for replies under its posts, [Clef](#answering-in-slack) decides whether to reply, react or ignore. It's switched on and tuned in the database, and capped per day and per thread.
- **Restart-safe.** It counts whoever is already in the channel at startup, so a restart mid-session doesn't announce the office opening again.
- **Keeps going when Slack doesn't.** Failed posts are retried with backoff and logged, and never crash the process.
- **Records voice activity** in the office channel to a [database](#database): joins, leaves, mute, deafen, camera and streaming, exactly as Discord reports them, plus soundboard sounds and emoji reactions. The database can never stop the announcements.
- **Records the office on demand.** Anyone in the office can press a button in a Discord Activity to record what's said. Each person's speech is kept as audio, transcribed with Whisper, and the summary lands in Slack with the full transcript. See [Recording the office](#recording-the-office).
- **Office stats** in the same Activity, for this week, this month or all time: time in the office per person, who's first in and last out, the busiest days and hours, the soundboard leaderboard, the top emoji reactions and how much was recorded. See [Office stats](#office-stats).
- **Optional Sentry monitoring** of errors, traces and logs.

## What it posts

Each post is a Block Kit card. With the fixed phrasings, they look like this:

> 🎙️ **Ada** opened the virtual office — everyone's welcome to join!
>
> `🎧 Join the office`
>
> 🔊 Opened on Discord at 4:05 PM

> 🪑 The virtual office is empty right now — jump in and get it going!
>
> **Open for** 2h 14m · **Stopped by** 5 people
>
> `🎧 Jump in`
>
> 🔇 Emptied at 6:19 PM

> ⏰ Daily reminder: come hang out in the virtual office!
>
> `🎧 Join the office`

When an AI model writes the headline and button label, the card adds a `✨ Headline by <model>` line. See [AI headlines](#ai-headlines).

Banter is always written by an AI model, from what's actually happened in the office:

> 🎬 Wednesday's crew arrived like a flash mob: Barbara, Alan, Grace and Linus all joined within 8 minutes, cameras snapped on in unison, then off together 40 minutes later.
>
> `🚪 Join the ensemble`
>
> ✨ Banter by nvidia/nemotron-3-ultra-550b-a55b:free · 🤖 AI is a hallucination machine.

### When it posts

| Post     | Trigger                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opened   | The first person joins the empty office channel. Moving in from another voice channel counts as joining.                                                                                       |
| Emptied  | The last person leaves. Moving to another voice channel counts as leaving. The recap is left out for a session that was already under way when the bot started, since it missed the beginning. |
| Reminder | Weekdays at 11:15 UTC+2. It's a fixed offset, so it doesn't shift with daylight saving. Skipped if the office channel wasn't found at startup, since there's nothing to link to.               |
| Banter   | At random, between 1 and 2½ hours apart, from 09:00 to 18:00 UTC+2 on weekdays, and at most 5 a day. See [Banter](#banter).                                                                    |
| Reply    | In the thread, when someone mentions the bot or Clef decides a reply under one of its posts wants an answer, 09:00 to 18:00 UTC+2 on weekdays. See [Answering in Slack](#answering-in-slack).  |

It only watches the one office channel and ignores bots, itself included. Mute, deafen and video changes, soundboard sounds and emoji reactions aren't announced, only [recorded](#database).

The fixed opened and emptied headlines are picked at random from a few phrasings. The reminder rotates through its phrasings by date, so each one comes up once before any repeats.

The original design is in [issue #1](https://github.com/push-based/virtual-office-notifier/issues/1).

## How it works

Discord only pushes voice-state changes over its Gateway WebSocket, so this is an always-on Node.js process rather than a webhook or serverless function. It's written in TypeScript with [Effect](https://effect.website) v4, uses [discord.js](https://discord.js.org) to receive `voiceStateUpdate` events, and posts to Slack with a bot token through `chat.postMessage`. It listens to Slack over a [Socket Mode](https://api.slack.com/apis/socket-mode) WebSocket, so the VM needs no public endpoint either.

```mermaid
flowchart LR
  Discord[Discord Gateway] -->|voiceStateUpdate| Gateway[DiscordGateway]
  Gateway -->|Opened / Emptied| Program
  Schedule[Weekday schedule] -->|Reminder / Banter| Program
  Schedule <-.->|activity and banter count| Postgres
  Program --> Notifier[SlackNotifier]
  Notifier <-->|headline + label| Writer[HeadlineWriter]
  Writer <-.->|optional| AI[OpenRouter / Workers AI]
  Notifier -->|chat.postMessage| Slack[Slack]
  Slack -->|Socket Mode events| Responder
  Responder <-.->|reply, react or ignore| Clef[Clef on Workers AI]
  Responder <-->|reply| ReplyWriter
  ReplyWriter <-.-> AI
  Responder -->|replies and reactions| Slack
  Responder <-.->|settings, caps and decisions| Postgres
  Gateway -->|voice observations and effects| Recorder[ActivityRecorder]
  Program -->|join / leave the office| Gateway
  Recorder -->|in order, in the background| Log[ActivityLog]
  Log --> Postgres[(Supabase Postgres)]
```

Events are handled one at a time, so one that arrives while a Slack post is being retried waits its turn and messages stay in order. Each call to Slack's Web API times out after 10 seconds and is retried up to 4 times with jittered exponential backoff from 1 second, or after Slack's `Retry-After` when rate-limited (`ratelimited` or a 429). Slack answers `200` with `ok: false` when it refuses something, so failures are told apart by Slack's error code: `invalid_auth`, `token_revoked`, `account_inactive`, `channel_not_found` and `not_in_channel` mean the bot has lost access, and anything else means it rejected what was sent. Neither is retried. Either way the failure is logged and the next event is handled as normal.

Answering in Slack runs in its own fiber too, so nothing on the Slack side can hold up or stop the announcements. See [Answering in Slack](#answering-in-slack).

Recording runs alongside, in its own fiber, so a slow Slack post never holds it up. See [Database](#database) for how it handles the database being down.

Discord only sends soundboard sounds and emoji reactions (`voiceChannelEffectSend`) to clients in the voice channel. So while anyone is in the office, the bot is too: it joins when the office opens and leaves when it empties, already muted and deafened. It only sends the gateway's voice-state message and never opens an audio connection, so it can't hear or send anything. It also leaves an empty office at startup, in case an earlier run left it behind. Whenever its Discord connection comes back after a drop, it goes back to where it should be. If someone disconnects it by hand, it's back the next time the office opens.

The one exception is a [recording](#recording-the-office): for as long as one is on, the bot un-deafens, opens an audio connection and is renamed `🔴 Recording`, so everyone in the channel can see it's listening. It goes back to muted and deafened the moment the recording stops or is paused, and is renamed `⏸️ Recording paused` while paused.

| Module                                                                               | Responsibility                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/bot/src/main.ts`](apps/bot/src/main.ts)                                       | Entry point. Provides the layers and runs the program.                                                                                                                                                                                                                                                           |
| [`apps/bot/src/Program.ts`](apps/bot/src/Program.ts)                                 | Merges office events with reminders and posts each one to Slack, and records voice activity alongside.                                                                                                                                                                                                           |
| [`apps/bot/src/DiscordGateway.ts`](apps/bot/src/DiscordGateway.ts)                   | Logs in to Discord, finds the office channel and turns voice-state updates into office events and observations to record.                                                                                                                                                                                        |
| [`apps/bot/src/OfficeEvent.ts`](apps/bot/src/OfficeEvent.ts)                         | The event types and the occupancy tracking that decides when the office opens or empties.                                                                                                                                                                                                                        |
| [`apps/bot/src/Reminder.ts`](apps/bot/src/Reminder.ts)                               | The weekday reminder schedule.                                                                                                                                                                                                                                                                                   |
| [`apps/bot/src/Banter.ts`](apps/bot/src/Banter.ts)                                   | When to post banter, which stretch of activity it covers, and the log the AI model reads.                                                                                                                                                                                                                        |
| [`apps/bot/src/OfficeHistory.ts`](apps/bot/src/OfficeHistory.ts)                     | Reads the recorded activity and who's in, and keeps count of the banter posted.                                                                                                                                                                                                                                  |
| [`apps/bot/src/Storage.ts`](apps/bot/src/Storage.ts)                                 | Sets up the database once for recording and reading, or turns both off without `DATABASE_URL`.                                                                                                                                                                                                                   |
| [`apps/bot/src/HeadlineWriter.ts`](apps/bot/src/HeadlineWriter.ts)                   | Asks the AI providers for a headline or banter and a button label, and checks the reply.                                                                                                                                                                                                                         |
| [`apps/bot/src/SlackMessage.ts`](apps/bot/src/SlackMessage.ts)                       | Builds the Block Kit message, including the fixed phrasings.                                                                                                                                                                                                                                                     |
| [`apps/bot/src/SlackClient.ts`](apps/bot/src/SlackClient.ts)                         | Slack's Web API: posting, reacting, reading threads and names, with retries and error classification.                                                                                                                                                                                                            |
| [`apps/bot/src/SlackNotifier.ts`](apps/bot/src/SlackNotifier.ts)                     | Posts the announcements, reminders and banter, and records each post.                                                                                                                                                                                                                                            |
| [`apps/bot/src/SlackSocket.ts`](apps/bot/src/SlackSocket.ts)                         | The Socket Mode connection: acks every event at once, drops redeliveries and reconnects.                                                                                                                                                                                                                         |
| [`apps/bot/src/SlackEvent.ts`](apps/bot/src/SlackEvent.ts)                           | Decodes Slack events and decides which ones the bot considers.                                                                                                                                                                                                                                                   |
| [`apps/bot/src/Responder.ts`](apps/bot/src/Responder.ts)                             | Waits for messages per thread, handles them one at a time, applies the limits, and replies, reacts or ignores.                                                                                                                                                                                                   |
| [`apps/bot/src/ReplyDecider.ts`](apps/bot/src/ReplyDecider.ts)                       | Asks Clef whether to reply, react or ignore, and applies the confidence threshold.                                                                                                                                                                                                                               |
| [`apps/bot/src/CloudflareDecisionModel.ts`](apps/bot/src/CloudflareDecisionModel.ts) | An Effect `DecisionModel` for Clef on Workers AI.                                                                                                                                                                                                                                                                |
| [`apps/bot/src/ReplyWriter.ts`](apps/bot/src/ReplyWriter.ts)                         | Asks the AI providers for a reply, and checks it.                                                                                                                                                                                                                                                                |
| [`apps/bot/src/AiWriting.ts`](apps/bot/src/AiWriting.ts)                             | The model fallback, timeouts and daily-limit handling shared by both writers.                                                                                                                                                                                                                                    |
| [`apps/bot/src/SlackHistory.ts`](apps/bot/src/SlackHistory.ts)                       | Reads the responder settings and keeps the Slack posts, messages, decisions and reactions.                                                                                                                                                                                                                       |
| [`apps/bot/src/VoiceObservation.ts`](apps/bot/src/VoiceObservation.ts)               | Decides which voice-state updates are worth recording.                                                                                                                                                                                                                                                           |
| [`apps/bot/src/VoiceEffect.ts`](apps/bot/src/VoiceEffect.ts)                         | Soundboard sounds and emoji reactions, and which ones are worth recording.                                                                                                                                                                                                                                       |
| [`apps/bot/src/BotPresence.ts`](apps/bot/src/BotPresence.ts)                         | Whether the bot should be in the office, from who's there at startup and the office opening and emptying.                                                                                                                                                                                                        |
| [`apps/bot/src/Recorder.ts`](apps/bot/src/Recorder.ts)                               | Starts and stops [recordings](#recording-the-office) on request, stores the clips, transcribes them in the background and posts the summary.                                                                                                                                                                     |
| [`apps/bot/src/Recording.ts`](apps/bot/src/Recording.ts)                             | Why a recording stopped, and the clip rules: the shortest clip worth transcribing and how often to retry one.                                                                                                                                                                                                    |
| [`apps/bot/src/RecordingStore.ts`](apps/bot/src/RecordingStore.ts)                   | The repository for recordings and their clips.                                                                                                                                                                                                                                                                   |
| [`apps/bot/src/VoiceCapture.ts`](apps/bot/src/VoiceCapture.ts)                       | The audio connection: one stream of Opus packets per speaker, cut into clips at pauses.                                                                                                                                                                                                                          |
| [`apps/bot/src/OggOpus.ts`](apps/bot/src/OggOpus.ts)                                 | Writes Opus packets into an Ogg file without transcoding.                                                                                                                                                                                                                                                        |
| [`apps/bot/src/ClipArchive.ts`](apps/bot/src/ClipArchive.ts)                         | Uploads clips to Cloud Storage with the VM's own identity, and fetches them back.                                                                                                                                                                                                                                |
| [`apps/bot/src/Transcriber.ts`](apps/bot/src/Transcriber.ts)                         | Whisper on Workers AI.                                                                                                                                                                                                                                                                                           |
| [`apps/bot/src/SummaryWriter.ts`](apps/bot/src/SummaryWriter.ts)                     | Builds the transcript and asks the AI providers for a summary.                                                                                                                                                                                                                                                   |
| [`apps/office-recorder/`](apps/office-recorder)                                      | The Discord Activity: the Angular page with the button in `src/`, and the Cloudflare Worker in `worker/` that signs people in, serves the recording requests and the page. One Vite config builds and serves both, through the [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/). |
| [`libs/activity-sign-in/`](libs/activity-sign-in)                                    | Sign-in for a Discord Activity: the Discord OAuth code exchange, the signed 12-hour sessions and the sign-in part of the HTTP API.                                                                                                                                                                               |
| [`libs/design-system/`](libs/design-system)                                          | The page's components, pipes and design tokens.                                                                                                                                                                                                                                                                  |
| [`libs/recording-requests/`](libs/recording-requests)                                | The recording requests and the recording status, shared by the bot, the Worker and the page: the rules for a request, the SQL on both sides, the Activity's HTTP API with its handlers, and the types the page reads, derived from the schemas. The words it uses are in [`CONTEXT.md`](CONTEXT.md).             |
| [`apps/bot/src/ActivityRecorder.ts`](apps/bot/src/ActivityRecorder.ts)               | Buffers observations and writes them in order, retrying outages and setting aside rows the database rejects.                                                                                                                                                                                                     |
| [`apps/bot/src/ActivityLog.ts`](apps/bot/src/ActivityLog.ts)                         | The repository: the SQL that writes sessions, members, snapshots and effects, and tells outages from bad rows.                                                                                                                                                                                                   |
| [`apps/bot/src/Database.ts`](apps/bot/src/Database.ts)                               | Connects to Postgres and runs the migrations in the background, retrying until it works.                                                                                                                                                                                                                         |
| [`apps/bot/src/migrations.ts`](apps/bot/src/migrations.ts)                           | The tables and the `voice_activity` and `office_activity` views, bundled into the app.                                                                                                                                                                                                                           |
| [`apps/bot/src/SupabaseCa.ts`](apps/bot/src/SupabaseCa.ts)                           | Supabase's root certificate, which Node doesn't trust by default.                                                                                                                                                                                                                                                |
| [`apps/bot/src/Config.ts`](apps/bot/src/Config.ts)                                   | Environment variables and the default model lists.                                                                                                                                                                                                                                                               |
| [`apps/bot/src/Observability.ts`](apps/bot/src/Observability.ts)                     | Sends errors, traces and logs to Sentry when it's configured.                                                                                                                                                                                                                                                    |

## Getting started

You'll need Node 26 (see `.nvmrc`), pnpm, a [Discord bot](#discord-bot) and a [Slack app](#slack-app).

```bash
git clone https://github.com/push-based/virtual-office-notifier.git
cd virtual-office-notifier
pnpm install
cp .env.example .env   # then fill in the values
pnpm --filter bot dev
```

Once it logs `Watching the virtual office`, join the office channel and the post should show up in Slack.

> [!WARNING]
> Use a separate Discord bot and Slack app for local runs while production is running. Two copies watching the same channel post every announcement twice.

## Configuration

All configuration comes from environment variables. Copy `.env.example` to `.env` for local runs. `.env` is git-ignored and must never be committed.

| Variable                    | Required     | Description                                                                                                                                                                                     |
| --------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`         | Yes          | Bot token from the Discord Developer Portal. Secret.                                                                                                                                            |
| `DISCORD_OFFICE_CHANNEL_ID` | Yes          | ID of the office voice channel (Developer Mode → right-click the channel → Copy Channel ID).                                                                                                    |
| `SLACK_BOT_TOKEN`           | Yes          | The Slack app's bot token (`xoxb-…`). Secret: anyone with it can post as the bot.                                                                                                               |
| `SLACK_APP_TOKEN`           | Yes          | The Slack app's app-level token (`xapp-…`) with `connections:write`, for Socket Mode. Secret.                                                                                                   |
| `SLACK_CHANNEL_ID`          | Yes          | ID of the Slack channel announcements, reminders and banter go to, and the only one the bot answers in.                                                                                         |
| `OPENROUTER_API_KEY`        | No           | [OpenRouter](https://openrouter.ai/settings/keys) API key for AI headlines. Secret.                                                                                                             |
| `OPENROUTER_MODELS`         | No           | Comma-separated OpenRouter models to try, preferred first. Defaults to `DEFAULT_OPENROUTER_MODELS` in [`apps/bot/src/Config.ts`](apps/bot/src/Config.ts).                                       |
| `OPENROUTER_BANTER_MODELS`  | No           | Comma-separated OpenRouter models to try for [banter](#banter), preferred first. Defaults to `DEFAULT_OPENROUTER_BANTER_MODELS` in [`apps/bot/src/Config.ts`](apps/bot/src/Config.ts).          |
| `CLOUDFLARE_ACCOUNT_ID`     | No           | Cloudflare account ID, for AI headlines from Workers AI. Needs `CLOUDFLARE_API_TOKEN` too.                                                                                                      |
| `CLOUDFLARE_API_TOKEN`      | No           | Workers AI API token. Secret.                                                                                                                                                                   |
| `CLOUDFLARE_MODELS`         | No           | Comma-separated Workers AI models to try, preferred first. Defaults to `DEFAULT_CLOUDFLARE_MODELS` in [`apps/bot/src/Config.ts`](apps/bot/src/Config.ts), all within the free daily allocation. |
| `DATABASE_URL`              | Deploys only | Supabase session pooler connection string, for the [database](#database). Secret. Optional locally, where leaving it out records nothing; the deploy fails without it.                          |
| `RECORDINGS_BUCKET`         | No           | The Cloud Storage bucket [recorded](#recording-the-office) clips are archived in. Without it, clips are only kept in memory until they're transcribed.                                          |
| `WHISPER_MODEL`             | No           | The Workers AI model that transcribes clips. Defaults to `@cf/openai/whisper-large-v3-turbo`.                                                                                                   |
| `TRANSCRIPTION_LANGUAGE`    | No           | The language people speak in the office, as Whisper names it. Defaults to `en`.                                                                                                                 |
| `SENTRY_DSN`                | No           | [Sentry](#monitoring) project DSN. Without it, nothing is sent to Sentry.                                                                                                                       |
| `SENTRY_ENVIRONMENT`        | No           | Environment to tag Sentry data with. Defaults to `development`; the deploy sets `production`.                                                                                                   |
| `SENTRY_RELEASE`            | No           | Release to tag Sentry data with. The deploy sets it to the commit SHA.                                                                                                                          |

The process exits at startup with an error naming the variable if a required one is missing. A blank optional key, account ID or database URL counts as unset.

`OPENROUTER_MODELS`, `OPENROUTER_BANTER_MODELS`, `CLOUDFLARE_MODELS`, `WHISPER_MODEL` and `TRANSCRIPTION_LANGUAGE` aren't passed through the deploy, so production always uses the defaults. Change those in `apps/bot/src/Config.ts`.

### Discord bot

1. Create an application at <https://discord.com/developers/applications> and add a bot. Revealing the token requires the account password.
2. Under **Bot**, turn off **Public Bot**. No privileged intents are needed; the bot only uses `Guilds`, `GuildVoiceStates` and `GuildExpressions` (to keep the server's soundboard sound names up to date).
3. Under **OAuth2 → URL Generator**, pick the `bot` scope with the **View Channels** and **Connect** permissions, open the URL and add the bot to the server. Without **Connect** it can't join the office, so soundboard sounds and emoji reactions aren't recorded, and it logs a warning at startup saying so.

### Slack app

1. Create an app at <https://api.slack.com/apps> → **From scratch** → pick the workspace, or open the app that had the old webhook.
2. **Settings → Socket Mode** → turn it on, and create an app-level token with the `connections:write` scope. That's `SLACK_APP_TOKEN`.
3. **Features → OAuth & Permissions → Bot Token Scopes**: add `chat:write`, `reactions:write`, `reactions:read`, `app_mentions:read`, `channels:history` and `users:read`. If the channel is private, add `groups:history` too.
4. **Features → Event Subscriptions** → turn it on and subscribe to the bot events `app_mention`, `message.channels`, `reaction_added` and `reaction_removed`, plus `message.groups` for a private channel. With Socket Mode on, there's no request URL to fill in.
5. Leave **Interactivity** off. The join buttons only open a link.
6. **Install to Workspace**, and copy the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`.
7. Invite the bot to the channel (`/invite @your-bot`), and copy the channel ID (channel details → **About**, at the bottom) into `SLACK_CHANNEL_ID`.

### AI headlines

Optional. With neither provider configured, every post uses the fixed phrasings.

Every post (opened, emptied and the reminder) gets a fresh headline and join button label from a free AI model, and the card credits the model that wrote them.

**What the model sees and returns**

- The model never sees anyone's name. For an opened office it writes a `{name}` placeholder that's filled in afterwards, and the other posts don't name anyone.
- The reply must be exactly two lines: a headline of up to 160 characters and a button label of up to 30. The headline has the placeholder exactly once for an opened office and not at all otherwise, and neither line may contain Slack link syntax. The reply is escaped before it's posted.
- Nothing checks that what the model says is true, and it does get things wrong, so every bit of banter says it's AI-written and may be made up.

**Which model writes it**

- Each post picks OpenRouter or Workers AI at random to go first and falls back to the other, using whichever are configured.
- Within a provider, models are tried one at a time in a random order. The first in its list goes first at least half the time (`openrouter/free` by default, which lets OpenRouter choose any free model that's up).
- A model that fails, takes longer than a minute, or replies with something unusable is skipped for the next one, and each skip is logged with the model and the reason.
- If OpenRouter says the key's daily free limit is used up (50 requests a day without credits, 1,000 with at least $10 of credit), the rest of OpenRouter's models are skipped, since they'd all be refused too, and Workers AI is tried if it hasn't been already.
- If every model fails, the post goes out with the fixed headline and label.

#### OpenRouter

Create a key at <https://openrouter.ai/settings/keys> and put it in `OPENROUTER_API_KEY`.

Free models come and go on OpenRouter. To change the list, pick from the [free models](https://openrouter.ai/models?max_price=0) and set `OPENROUTER_MODELS`, preferred model first.

#### Cloudflare Workers AI

1. Sign up at <https://dash.cloudflare.com/sign-up/workers-and-pages>. New accounts are on the Workers Free plan.
2. Go to **Workers AI** → **Use REST API** → **Create a Workers AI API Token**, and copy the token into `CLOUDFLARE_API_TOKEN`.
3. Copy the **Account ID** from the same page into `CLOUDFLARE_ACCOUNT_ID`.

Workers AI includes 10,000 Neurons a day for free, which covers a few hundred headlines on the default models. [Clef](#answering-in-slack) and Slack replies come out of the same allowance, so replies try OpenRouter first. When Cloudflare says the day's allowance is used up, the rest of its models are skipped, like OpenRouter's daily limit.

### Banter

Needs the [database](#database) and at least one [AI provider](#ai-headlines). Without the database, every chance is skipped with a `Skipped banter` warning.

**When it posts**

- After a random wait of 60 to 150 minutes, it checks whether it's 09:00 to 18:00 UTC+2 on a weekday, and whether fewer than 5 have gone out since midnight UTC+2. If so, it posts; either way, it waits again.
- Each one is stored in `banter_posts` before the AI writes it, so the daily limit holds across restarts, and one the AI couldn't write still counts. That keeps it to at most 5 attempts' worth of AI requests a day.
- If every model fails, nothing is posted. There's no fixed fallback.

**What the model sees and returns**

- It picks one stretch of time at random: today so far, yesterday and today, this week so far (from Monday), or last week.
- The model gets the time, who's in the office right now, and every entry of the [`office_activity`](#whats-recorded) view in that stretch, as is, with times in UTC+2: `Wed 30 Sep 15:00 Barbara CameraOn` or `Wed 30 Sep 15:03 Alan PlayedSound airhorn`. A busy stretch is cut to its latest 400 entries, and the model is told how many were left out.
- People are named with their `real_name` when it's filled in, or their Discord display name. Who's in right now comes from what this run of the bot recorded.
- The prompt asks for something playful and warm, never mean, that only says what the log shows. The reply must be exactly two lines: a message of up to 300 characters and a button label of up to 30, with no Slack link syntax. The reply is escaped before it's posted.
- Nothing checks that what the model says is true, and it does get things wrong, so every bit of banter says it's AI-written and may be made up.

**Which model writes it**

The same way as the headlines, except OpenRouter uses `OPENROUTER_BANTER_MODELS`. Its defaults leave out the `openrouter/free` router, because it often picks a small model that misses the point of the log or makes things up.

**Trying it on made-up data**

[`apps/bot/scripts/try-banter.ts`](apps/bot/scripts/try-banter.ts) runs the scenarios in [`apps/bot/scripts/banter-scenarios.ts`](apps/bot/scripts/banter-scenarios.ts): a busy Friday, an empty office, a mute marathon, a lone regular, last week's early bird and a camera party. It never posts to Slack or touches the database.

```bash
node --env-file=.env apps/bot/scripts/try-banter.ts
```

On its own it only prints the prompts. With `--call-ai` it asks one OpenRouter model once per scenario, with no fallback, so a run is at most 6 requests. `BANTER_MODEL` picks the model (the first of the banter defaults otherwise) and `BANTER_SCENARIO` runs just one scenario by name.

```bash
node --env-file=.env apps/bot/scripts/try-banter.ts --call-ai
```

### Answering in Slack

Needs the [database](#database), and stays off until it's switched on there. Mentions also need at least one [AI provider](#ai-headlines), and replies under the bot's posts need Cloudflare for Clef. The design is in [issue #18](https://github.com/push-based/virtual-office-notifier/issues/18).

**What it considers**

- Only messages in the `SLACK_CHANNEL_ID` channel.
- **Mentions of the bot.** These always get a reply, within the limits below, in the thread they're in, or in a new thread under a mention that isn't in one.
- **Replies in threads under the bot's own posts**: announcements, reminders, banter and its own replies. [Clef](https://blog.cloudflare.com/clef-decision-models/), a decision model on Workers AI, decides whether to reply, react with an emoji or ignore it.
- Nothing else: other channels, DMs, top-level messages that don't mention it, other bots and itself, edits, deletions and joins. A mention inside a thread under its post is handled once, as a mention.

**How it decides**

- Clef gets the bot's post, the last few messages in the thread and the new one, each cut to 1,000 characters. It answers with a choice and a confidence for the action (`reply`, `react` or `ignore`) and for the emoji. The bot acts only when the action's confidence is at least `min_confidence`. Every request is stored with Clef's answer, so the threshold can be tuned on real data later.
- The reply is written by the [banter](#banter) models, OpenRouter first, in the same warm and gently teasing voice. The model gets the thread (up to the last `writer_thread_messages` messages), who's in the office right now and this week's [`office_activity`](#whats-recorded), at most 400 entries. The reply must be one message of up to 600 characters with no Slack link or mention syntax. It's escaped and posted in the thread with a line crediting the model and saying it's AI.
- Slack text is untrusted. The model has no tools, and what it writes is checked and escaped, so a message that tries to give it instructions can only change what it says, not what it does.
- People in the thread are shown by their Slack name, or by their office name when they're linked: `office.members.slack_user_id` first, then a case-insensitive match of their Slack real name against `real_name`. The model is told not to assume anyone else in the thread is anyone in the log.

**Limits**

- Only 09:00 to 18:00 UTC+2 on weekdays, mentions included.
- At most `max_replies_per_day` replies and `max_reactions_per_day` reactions per office day, and `max_replies_per_thread` replies in any one thread. Mentions count. When it couldn't act anyway, Clef isn't asked. A reply that's over a limit is never turned into a reaction.
- Each thread keeps only its latest waiting message: an older one is skipped as `superseded`. Mentions wait separately, so chatter can't push one out. Threads take turns, one message at a time, in the order they first spoke, and a message that waited more than `stale_after_seconds` is skipped as `stale`.
- Every message it considers is recorded with what it did and why: `replied`, `reacted` or `ignored`, because of `clef`, `mention`, `low_confidence`, `daily_cap`, `thread_cap`, `outside_hours`, `stale`, `superseded`, `clef_failed` or `no_model`.
- If Clef fails or every writing model fails, it stays quiet. Both are logged and reported as warnings.

**Settings**

Everything is in the single row of `office.responder_settings`, read for every message, so a change in Supabase applies to the next one. The database refuses values that can't work.

| Column                   | Default                                                       | What it does                                                                                               |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `enabled`                | `false`                                                       | Switches answering on. While it's off, nothing is decided, posted or recorded, reactions included.         |
| `clef_model`             | `@cf/cloudflare/clef`                                         | The Clef model. `@cf/cloudflare/clef-flash` is faster but weaker on messages that fit none of the choices. |
| `min_confidence`         | `0.7`                                                         | How sure Clef must be, from 0 to 1.                                                                        |
| `max_replies_per_day`    | `20`                                                          | Replies per office day.                                                                                    |
| `max_reactions_per_day`  | `30`                                                          | Reactions per office day.                                                                                  |
| `max_replies_per_thread` | `3`                                                           | Replies in any one thread.                                                                                 |
| `stale_after_seconds`    | `120`                                                         | How long a message can wait for its turn.                                                                  |
| `clef_thread_messages`   | `10`                                                          | Earlier thread messages Clef sees.                                                                         |
| `writer_thread_messages` | `50`                                                          | Earlier thread messages the reply's writer sees.                                                           |
| `reaction_emoji`         | `joy`, `eyes`, `raised_hands`, `heart`, `+1`, `saluting_face` | The emoji Clef picks from, as Slack names them. At least two.                                              |

```sql
UPDATE office.responder_settings SET enabled = true, updated_at = now();
```

### Database

The bot records voice activity in the office channel to a Postgres database on [Supabase](https://supabase.com). It's collected now, to decide later what to use it for. The design is in [issue #10](https://github.com/push-based/virtual-office-notifier/issues/10).

1. Create a project at <https://supabase.com/dashboard>.
2. Click **Connect**, pick the **Session pooler** connection string, and put it in `DATABASE_URL` with the database password filled in. Percent-encode any special characters in the password.

Use the session pooler, not the direct connection: the direct one is IPv6-only unless the project has the IPv4 add-on, and GCP VMs only have IPv4 by default. The transaction pooler (port 6543) doesn't support the prepared statements the client uses.

Locally, leave `DATABASE_URL` out unless you mean to record. `pnpm --filter bot dev` with the production URL writes into the production data.

#### What's recorded

Everything lives in an `office` schema, out of the `public` schema that Supabase serves through its REST API.

| Table                | What's in it                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice_snapshots`    | One row per Discord voice-state update touching the office: joining, leaving, moving in or out, and every change inside. It has the old and new value of every field Discord sends (channel, self and server mute and deafen, camera, streaming, suppressed, request to speak and voice session), as Discord sent them. Bots are left out. `source` is `update`, or `startup` for someone already in the office when the bot started. |
| `voice_effects`      | One row per soundboard sound or emoji reaction someone sent in the office, as Discord sent it: the sound's ID, volume and name (looked up from the server's sounds and Discord's default ones, empty when it couldn't be found), the emoji, and the animation. Bots are left out.                                                                                                                                                     |
| `members`            | One row per Discord user seen, with their latest display name and when they were first and last seen. `real_name` and `slack_user_id` are yours to fill in by hand; the bot never writes them. They link people in Slack threads to the office.                                                                                                                                                                                       |
| `bot_sessions`       | One row per run of the bot, with when it started and stopped. `stopped_at` stays empty when it didn't stop cleanly, so gaps in the data can be told apart from an empty office.                                                                                                                                                                                                                                                       |
| `rejected_updates`   | Anything the database refused to store, as JSON with the error, so it can be fixed and replayed by hand.                                                                                                                                                                                                                                                                                                                              |
| `banter_posts`       | One row per bit of [banter](#banter), with when and which stretch of time it covered, so the daily limit holds across restarts.                                                                                                                                                                                                                                                                                                       |
| `slack_posts`        | Every message the bot posts to Slack: channel, `ts`, thread, kind (`Opened`, `Emptied`, `Reminder`, `Banter` or `Reply`) and the model that wrote it.                                                                                                                                                                                                                                                                                 |
| `slack_messages`     | Every Slack message the bot [considered](#answering-in-slack): who wrote it, their linked office member if any, the text, whether it was a mention and when it arrived.                                                                                                                                                                                                                                                               |
| `slack_decisions`    | One per considered message: Clef's model, the exact request, its choices with their probabilities and confidence, how long it took, the settings in effect, and what the bot did and why.                                                                                                                                                                                                                                             |
| `slack_reactions`    | Every reaction added to or removed from the bot's posts, as Slack sent it, for judging how the posts land.                                                                                                                                                                                                                                                                                                                            |
| `responder_settings` | The [settings](#answering-in-slack) for answering in Slack.                                                                                                                                                                                                                                                                                                                                                                           |
| `recordings`         | One row per [recording](#recording-the-office): when it started and stopped, who started and stopped it, why it stopped, who paused it and since when while it's paused, and once it's finished, the transcript, the summary and the model that wrote it, and where the Slack post is.                                                                                                                                                |
| `recording_events`   | The history of each recording: `started`, `paused` and `resumed` with who did it, `resumed` with the reason `requested` or `bot_restarted`, and `stopped` with the reason.                                                                                                                                                                                                                                                            |
| `recording_requests` | Every press of the Activity's buttons, with who pressed it, and what the bot did about it: `started`, `stopped`, `paused`, `resumed` or `ignored` with the reason.                                                                                                                                                                                                                                                                    |
| `recording_clips`    | One row per stretch of speech: who spoke, when, for how long, where the audio is in the bucket, and the transcript once Whisper has heard it, or why it was skipped or failed.                                                                                                                                                                                                                                                        |
| `recording_status`   | A single row the Activity reads: whether the bot is in the office, who's there, and the recording that's on.                                                                                                                                                                                                                                                                                                                          |

The `voice_activity` view turns the snapshots into readable events with names: `AlreadyThere`, `Joined`, `Left`, `Muted`/`Unmuted`, `Deafened`/`Undeafened`, `ServerMuted`/`ServerUnmuted`, `ServerDeafened`/`ServerUndeafened`, `CameraOn`/`CameraOff` and `StreamStarted`/`StreamStopped`. Anything already on when someone arrives counts as switched on, so joining muted is `Joined` and `Muted`. Deafening in Discord also mutes, so it shows as `Deafened` and `Muted`.

The `office_activity` view is `voice_activity` plus the effects: `PlayedSound` with the sound's name in `detail`, `Reacted` with the emoji, or `SentEffect` for anything else. It's what [banter](#banter) reads.

```sql
SELECT observed_at, coalesce(real_name, display_name) AS who, event, detail
FROM office.office_activity
ORDER BY observed_at DESC
LIMIT 50;
```

Nothing is ever deleted. Migrations live in [`apps/bot/src/migrations.ts`](apps/bot/src/migrations.ts), run once each on the first successful connection, and only ever add.

#### When the database is down

The database can never stop the announcements:

- Connecting happens in the background after startup, so the bot runs normally while it's down. Once connected, it logs `Connected to the database`.
- Observations are buffered in memory and written in order by a single writer, up to 50,000 at a time. When the buffer is full, new ones are refused and logged in full.
- If it can't connect, run the migrations or write, it retries in bursts of 5 attempts 1, 2, 4, 8 and 16 seconds apart, then waits an hour before the next burst. The entry being written keeps its place. Each failed attempt is logged with what went wrong.
- A row the database rejects (a data or constraint error) goes to `rejected_updates` instead, so it can't block everything behind it. If that fails too, it's logged in full.
- On shutdown it spends up to 10 seconds writing what's left, including the session's `stopped_at`. Anything still unwritten is logged in full.

Anything that can't be stored is logged with an `entry` holding the full JSON, so it can be found in the [logs](#logs) and replayed by hand.

The connection is encrypted and checked against Supabase's own root certificate in [`apps/bot/src/SupabaseCa.ts`](apps/bot/src/SupabaseCa.ts), which expires in April 2031.

### Recording the office

Needs the [database](#database), the bot's Cloudflare account for Whisper, and a Discord Activity for the button. The design is in [issue #21](https://github.com/push-based/virtual-office-notifier/issues/21).

**How it works**

- Anyone in the office opens the **Office Recorder** Activity from the rocket button in the voice channel and presses **Start**. Pressing it writes a request to `office.recording_requests`; the bot checks for new requests every 2 seconds, and only acts on one from someone who's in the office right now. Anyone in the office can press **Stop**, not just whoever started it. The Activity shows the state, who's in the room, and when the recording would stop by itself.
- While someone has the Activity open, their Discord profile shows it too: `Recording the office`, `Started by <name>` and the time since it started, or `In the office` / `Not recording`, or `Office is empty`. It only changes when the recording starts, stops or changes hands, and if Discord refuses it, the page carries on and the browser console says `Couldn't update the Rich Presence`. Setting it needs the `rpc.activities.write` scope, so everyone who had already allowed the Activity is asked to allow it once more. The design is in [issue #53](https://github.com/push-based/virtual-office-notifier/issues/53).
- While recording, the bot un-deafens, opens an audio connection and is renamed `🔴 Recording`. Discord gives it one stream per speaker, so each stretch of speech becomes a clip of that one person with no speaker detection needed. A clip ends after 1.5 seconds of silence, or at 5 minutes.
- Anyone in the office can press **Pause** to go off the record, and anyone can press **Resume**. While paused the bot captures nothing: it drops the audio connection and deafens, and the Activity shows who paused it and for how long. Each pause leaves one line such as `14:20–14:35 Paused by Ben` in the transcript, which the summary model reads too.
- A recording stops when someone presses **Stop**, when the office empties, or after 4 hours, whichever comes first, paused or not: the 4 hours include pauses. If the bot restarts mid-recording and the office is still occupied, it carries on under the same recording, still paused if it was; otherwise the recording ends as `bot_restarted`.
- Each clip is written as Ogg/Opus, exactly as Discord sent it, and uploaded to `RECORDINGS_BUCKET` under `recordings/<recording>/<user>/<time>.ogg` with the VM's own identity. Clips are never deleted. Clips under half a second are kept but never transcribed, since that's where Whisper makes things up.
- Clips are transcribed one at a time in the background with `WHISPER_MODEL` on Workers AI, in `TRANSCRIPTION_LANGUAGE`. A clip that fails stays pending and is retried, up to 10 times. When Workers AI's daily allocation is used up (10,000 Neurons, about 3.5 hours of speech, shared with headlines, banter and Clef), transcription waits for the reset at midnight UTC. Nothing is lost, just late.
- Once every clip of a stopped recording is done, the transcript is built with office names and times in UTC+2, the [banter](#banter) models write a summary, and the summary is posted to the Slack channel with the full transcript attached in its thread. If nobody said anything, nothing is posted. If no model could write a summary, the post says so and the transcript is still attached.
- Like everything else, this can't break the announcements. A database, Whisper, storage or Slack outage is logged and retried, and recording itself needs none of them to carry on.

**Setup outside the code**

1. **Discord.** In the Developer Portal, give the bot the **Change Nickname** permission (re-run the OAuth URL from [Discord bot](#discord-bot) with it ticked, or grant it in the server's role settings). Under **OAuth2**, add `https://127.0.0.1` as a redirect and note the **Client ID** and **Client Secret**. Under **Activities → Settings**, enable Activities; under **Activities → URL Mappings**, map `/` to the Worker's `workers.dev` host (without `https://`), once it's deployed.
2. **Slack.** Add the `files:write` bot scope to the app from [Slack app](#slack-app) and reinstall it, so the transcript can be attached.
3. **Cloud Storage.** Create a private bucket in `us-central1`, with no lifecycle rule that deletes objects, and set it as the `RECORDINGS_BUCKET` secret. Give the VM the `storage-rw` scope, which means stopping and starting it once:

   ```bash
   gcloud compute instances stop virtual-office-notifier --zone=us-central1-a
   ```

   ```bash
   gcloud compute instances set-service-account virtual-office-notifier --zone=us-central1-a --scopes=default,storage-rw
   ```

   ```bash
   gcloud compute instances start virtual-office-notifier --zone=us-central1-a
   ```

   Then grant the VM's service account (the project's default compute service account) **Storage Object Creator** and **Storage Object Viewer** on the bucket.

4. **A database role for the Activity.** The Worker never gets the bot's `DATABASE_URL`. In the Supabase SQL editor, with a password of your own:

   ```sql
   CREATE ROLE activity LOGIN PASSWORD 'change-me';
   GRANT USAGE ON SCHEMA office TO activity;
   GRANT SELECT ON office.recording_status, office.recordings, office.members TO activity;
   GRANT SELECT ON office.voice_activity, office.office_activity TO activity;
   GRANT SELECT, INSERT ON office.recording_requests TO activity;
   GRANT USAGE ON SEQUENCE office.recording_requests_id_seq TO activity;
   ```

5. **Hyperdrive.** Workers can't open a TLS connection to Supabase themselves, because they only trust public certificate authorities and Supabase signs its database certificates with its own. So the Worker reaches the database through [Hyperdrive](https://developers.cloudflare.com/hyperdrive/), which connects to Supabase as the `activity` role and checks Supabase's certificate against its root CA. From the repo root, with `wrangler login`, upload the CA (the one in [`apps/bot/src/SupabaseCa.ts`](apps/bot/src/SupabaseCa.ts), saved as a `.pem`) and create the config with caching off, so the Activity always sees the current state:

   ```bash
   pnpm --filter office-recorder exec wrangler cert upload certificate-authority --name supabase-root-2021 --ca-cert supabase-root.pem
   ```

   ```bash
   pnpm --filter office-recorder exec wrangler hyperdrive create virtual-office-recorder-db --origin-host <pooler host> --origin-port 5432 --database postgres --origin-user activity.<ref> --origin-password <password> --sslmode verify-full --ca-certificate-id <CA ID> --caching-disabled
   ```

   Put the new config's ID under `hyperdrive` in [`apps/office-recorder/wrangler.jsonc`](apps/office-recorder/wrangler.jsonc). The pooler host and `<ref>` are the ones in the bot's `DATABASE_URL`. Right after the role's password changes, the pooler can refuse it for a few seconds, so a failed create is worth retrying.

6. **The Worker.** It lives in [`apps/office-recorder/worker/`](apps/office-recorder/worker) and is deployed by CI with `wrangler`. Create an API token in Cloudflare with the **Edit Cloudflare Workers** template and store it as the `CLOUDFLARE_DEPLOY_TOKEN` repository secret; the Workers AI token stays as it is. Without it, the deploy job fails before shipping anything, so the bot and the Activity always go out together. Then set the Worker's own secrets once, from the repo root with `wrangler login`:

   ```bash
   for name in DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET SESSION_SECRET; do pnpm --filter office-recorder exec wrangler secret put $name; done
   ```

   `SESSION_SECRET` is any long random string; it signs the sessions the page gets after Discord's login. The first deploy prints the `workers.dev` host for the URL mapping above.

   The views aren't `security_invoker`, so the role reads them without any grant on the tables underneath. Without the second `GRANT`, the [Stats](#office-stats) tab answers `503` and the rest of the Activity works as before.

**Trying the two things it depends on**

Received audio has to decrypt, since Discord's voice is end-to-end encrypted (DAVE), and Whisper has to accept Ogg/Opus as is. [`apps/bot/scripts/try-recording.ts`](apps/bot/scripts/try-recording.ts) checks both: it joins the office with audio on for a minute, writes one `.ogg` per stretch of speech into `recordings-check/`, and sends the first one to Whisper. Have someone say a few words while it runs. It needs the Discord token and channel, and the Cloudflare account and token for the Whisper step; it never touches the database or Slack.

```bash
node --env-file=.env apps/bot/scripts/try-recording.ts --seconds 60
```

### Office stats

The Office Recorder has two tabs: **Now**, with the recording status and who's in the office, and **Stats**, with the office stats for this week, this month or all time. The Stats tab counts everything when it's opened or the range changes, and never polls. Each total is worked out in SQL from the `office.voice_activity` and `office.office_activity` views and `office.recordings`, so it needs the second `GRANT` in step 4 of [setup](#recording-the-office).

- Weeks start on Monday and months on the 1st, both at midnight in office time, UTC+2.
- **Time in the office** runs from `Joined` (or `AlreadyThere`, for anyone in when the bot started) to that person's next `Left`. Someone who's still in counts until now. When the bot stopped without seeing them leave, the stay ends at the last thing that run of the bot saw. Stays that cross the start of the range only count from the start.
- **First in** and **last out** count, for each day, who arrived first and who left last. A day where someone's still in has no last out yet.
- **Busiest hours** is a weekday × hour grid of how many people were in on average, over every such hour in the range.
- **Soundboard**, **reactions** and **recordings** count what happened in the range, with the top 10 of each list.

## Development

The workspace runs on [Vite+](https://viteplus.dev). Each package defines its tasks in its `vite.config.ts`, and `vp run` runs them in dependency order and caches the results, so a task whose inputs haven't changed replays instead of running again. `pnpm vp` runs the local copy if you don't have `vp` installed globally.

| Command                             | What it does                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm vp run -r typecheck`          | Type-check every package with TypeScript 7.                                                                                                                                                                                                            |
| `pnpm vp run check`                 | Check formatting with Oxfmt and lint with Oxlint, across the whole repo, with the `fmt` and `lint` config in the root `vite.config.ts`. Lint includes the Effect rules. `pnpm vp check --fix` formats every file and applies the automatic lint fixes. |
| `pnpm vp run -r test`               | Run every package's tests with Vitest.                                                                                                                                                                                                                 |
| `pnpm vp run -r build`              | Bundle the bot to `apps/bot/dist/main.js` with a source map, and build the Activity to `apps/office-recorder/dist`: the page in `client/`, type-checked on the way, and the Worker with its generated `wrangler.json` in `worker/`.                    |
| `pnpm vp run office-recorder#check` | Build the Activity and run `wrangler deploy --dry-run` on the result.                                                                                                                                                                                  |
| `pnpm vp run ci`                    | Run all of the above, as CI does.                                                                                                                                                                                                                      |
| `pnpm --filter bot dev`             | Run the bot from source with `.env`.                                                                                                                                                                                                                   |
| `pnpm --filter bot start`           | Run the bot's bundle with `.env`.                                                                                                                                                                                                                      |
| `pnpm --filter office-recorder dev` | Serve the Activity's page with live reload and run its Worker in the Workers runtime on the same origin. See below for the database.                                                                                                                   |

Run a single package's task with `pnpm vp run <package>#<task>`, for example `pnpm vp run bot#test`. `pnpm vp cache clean` clears the task cache.

`pnpm vp run ci` runs every one of these checks in one go: typecheck, check, test, build and the Activity's dry run. CI runs the same task on every pull request and every push to `main`, and a newer push to a pull request cancels the run before it. It sets up Node, pnpm and `vp` with [`setup-vp`](https://github.com/voidzero-dev/setup-vp), and keeps the task cache between runs, including the tasks that passed in a failed run. Dependabot keeps the pinned actions up to date.

`pnpm install` also installs a pre-commit hook, through `vp config` in the `prepare` script. It runs `vp staged`, which runs `vp check --fix` on the staged files, so formatting and lint fixes land in the commit. Lint is type-aware (`lint.options.typeAware`), so rules that need types run too, including the Effect rules.

Running the Activity locally needs a Postgres for its `DATABASE` Hyperdrive binding, with a password in the URL, even if you never record. Set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DATABASE`, for example to `postgres://postgres:postgres@localhost:5432/postgres` (the `office-recorder` preview in [`.claude/launch.json`](.claude/launch.json) uses that), and put the Worker's secrets in `apps/office-recorder/.dev.vars`.

The tests run the program against fakes for Discord, Slack and the AI models, so they need no tokens or network access. `DiscordGateway.layerTest` feeds voice-state updates from a queue through the same occupancy tracking the real gateway uses. The database tests run the real migrations and SQL against an in-process Postgres ([PGlite](https://pglite.dev)), so they need no database either.

The Effect rules come from [`@effect/tsgo`](https://github.com/Effect-TS/tsgo). The `prepare` script swaps the Oxlint and `tsgolint` that Vite+ brings in for its Effect-patched builds, and leaves TypeScript as it is. It only supports exact Oxlint and `oxlint-tsgolint` versions, so upgrade `vite-plus` and `@effect/tsgo` together.

Every Effect rule is an error for the bot, the Worker, `activity-sign-in` and `recording-requests`, so `vp check` fails on any of them, including the rules that are only suggestions by default. Fix the code rather than silencing a rule. The patched `tsgolint` reads its options from the `@effect/language-service` entry in the root [`tsconfig.json`](tsconfig.json), which lists the unstable Effect modules the app is allowed to use in `allowedUnstableApis`, so using a new one means adding it there.

Vite, Vitest, Oxlint and Oxfmt come from Vite+. The catalog in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) points `vite` at Vite+'s core, and its overrides keep a single copy of Vite and Vitest across the workspace, which `@effect/vitest` needs to register its tests with the runner `vp test` starts. Upgrade them by bumping `vite-plus` and `vitest` there together.

The Activity's page and the design system are compiled by [vite-plugin-ngp](https://push-based.github.io/vite-plugin-ngp/getting-started). The plugin only works with the Angular release its compiler was built from, so every `@angular/*` package is pinned to exactly that version in the `angular` catalog in [`pnpm-workspace.yaml`](pnpm-workspace.yaml), with the plugin and the TypeScript 6 that Angular's compiler needs. Upgrade them together there. The Activity's Worker is type-checked with the root's TypeScript 7 instead, from its own [`tsconfig.json`](apps/office-recorder/worker/tsconfig.json), and ngp only compiles the browser build, not the Worker.

The lint rules in `tools/oxlint/anti-slop` are vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop). [`UPSTREAM.md`](tools/oxlint/anti-slop/UPSTREAM.md) records the commit they were copied from.

## Deployment

Runs on a GCP Always Free `e2-micro` VM under systemd. There must be exactly one running copy, otherwise every announcement is posted twice.

Deploys only happen from CI: merging a pull request into `main` runs the checks and then deploys. There are no manual deploys.

### First-time VM setup

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

The deploy writes the env file and installs the systemd unit, so there's nothing else to do on the VM. Set up CI below; the first deploy starts the service.

### Continuous deployment

The `deploy` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) authenticates to GCP through Workload Identity Federation, so there's no service account key to leak, and only pushes to `main` on this repo can get a token.

One-time setup, from the repo root with `gcloud` on the right project and `gh` logged in to the repo owner's account:

```bash
scripts/setup-ci.sh
```

This creates a `github-deploy` service account and a Workload Identity pool trusting this repo's `main` branch, turns on OS Login for the VM, and grants the account SSH and sudo there. It then stores these repository secrets:

| Secret                                                                                                     | Source                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`                                                                           | The Workload Identity provider created above                              |
| `GCP_SERVICE_ACCOUNT`                                                                                      | The `github-deploy` service account email                                 |
| `DISCORD_BOT_TOKEN`, `DISCORD_OFFICE_CHANNEL_ID`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID` | Your local `.env`                                                         |
| `DATABASE_URL`                                                                                             | The Supabase session pooler connection string. See [Database](#database). |
| `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SENTRY_DSN`                        | Optional, your local `.env`                                               |

GitHub secrets are the source of truth for the app's configuration. To change a value, update the secret and re-run the latest `CI` workflow on `main`:

```bash
gh secret set SLACK_BOT_TOKEN
```

### What a deploy does

The `deploy` job builds the Activity first, page and Worker, so nothing ships if it fails. It then runs the bot's `deploy` task, which bundles the bot and runs [`apps/bot/scripts/deploy.ts`](apps/bot/scripts/deploy.ts):

1. Writes the env file from the configuration variables into a temporary directory, so secrets never land in the working tree.
2. Downloads the one dependency that can't be bundled, DAVE's native add-on for Linux x64 (`@snazzah/davey`, which `@discordjs/voice` needs to decrypt [recorded](#recording-the-office) audio), with `npm pack`, and packs it as a small `node_modules` tree.
3. Copies `apps/bot/dist/main.js`, its source map, that archive, the systemd unit and the env file to the VM.
4. Installs them under `/opt/virtual-office-notifier` and `/etc`, replacing the previous `node_modules`, reloads systemd and restarts the service.
5. Waits 15 seconds and fails, printing the last log lines, if the service isn't running.

Last, the Activity's `deploy` task runs `wrangler deploy`, which picks up the Worker and page that were just built through the `wrangler.json` the build generates.

The [unit](apps/bot/deploy/virtual-office-notifier.service) runs as the unprivileged `notifier` user with systemd's sandboxing turned on. It restarts 30 seconds after a crash and gives up after 5 failed starts in 10 minutes, so a bad token doesn't keep hammering Discord's login.

### Logs

```bash
gcloud compute ssh virtual-office-notifier --zone=us-central1-a -- journalctl -u virtual-office-notifier -f
```

### Monitoring

With `SENTRY_DSN` set, the app sends errors, traces and logs to [Sentry](https://sentry.io) through [`@sentry/effect`](https://docs.sentry.io/platforms/javascript/guides/effect/). Everything still goes to the journal as well.

- **Issues.** A crash, including at startup, is an error. A Slack call that only failed after retries is a warning; lost access or a rejected payload is an error. Discord client errors are errors, and every AI model failing to write a headline or reply is a warning. So are Clef failing and the Slack Socket Mode connection dropping. For the [database](#database), every retry while it's unreachable and every update it rejects is a warning, and an update that could only be logged, or a database client that couldn't be created, is an error. These never include the update itself.
- **Traces.** Each announcement is its own trace: the Slack post with each attempt, and the AI model calls. HTTP client spans are turned off, so request details never leave the VM.
- **Logs.** Every log line, linked to the trace it was logged in. Only the message is sent, not the annotations.

To turn it on, create a Node.js project in Sentry and set its DSN as a secret, then re-run the latest `CI` workflow on `main`:

```bash
gh secret set SENTRY_DSN
```

## Troubleshooting

| Symptom                                                    | Cause                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exits at startup naming a variable                         | It's missing or empty. Check `.env` locally, or the GitHub secret in production.                                                                                                                                                                                                                                               |
| `Office voice channel not found` in the logs               | `DISCORD_OFFICE_CHANNEL_ID` is wrong, or the bot isn't in the server or can't view the channel. It keeps running in case the bot is added later, but reminders stay off until it restarts.                                                                                                                                     |
| Every announcement shows up twice                          | Two copies are running, for example `pnpm --filter bot dev` with the production tokens.                                                                                                                                                                                                                                        |
| `Slack rejected the post` with `AccessRevoked`             | The token was revoked, the app uninstalled, or the bot isn't in the channel. Reinstall the app or invite the bot, and update the secrets.                                                                                                                                                                                      |
| The bot never answers in Slack                             | Check `office.responder_settings.enabled`, then `office.slack_decisions` for why. No rows at all means the events aren't arriving: look for `Lost the Slack connection, reconnecting` warnings and check the app's Socket Mode, events and scopes.                                                                             |
| No banter shows up                                         | Look for `Skipped banter` warnings: the reason says why the database couldn't be read. Without the database there's no banter at all. If every AI model failed, the log says `Nothing to announce, no AI model wrote the banter`.                                                                                              |
| Posts always use the fixed headlines                       | Every AI model is failing. Look for `AI model couldn't write it` warnings and their reason. `DailyLimit` means the OpenRouter key has used up its free requests for the day.                                                                                                                                                   |
| `Couldn't set up the database, retrying` in the logs       | The bot can't reach the database or run the migrations. The `reason` says why, for example a wrong password in `DATABASE_URL` or a paused Supabase project. Announcements carry on, and observations are buffered until it connects.                                                                                           |
| `Couldn't record to the database, retrying` in the logs    | The database went away after connecting, or a write took over 10 seconds. Writing resumes where it left off once it's back.                                                                                                                                                                                                    |
| `The database rejected an update` in the logs              | Postgres refused a row. It's in `office.rejected_updates` with the error.                                                                                                                                                                                                                                                      |
| `logging this instead` or `logging it instead` in the logs | Something couldn't be stored at all: the buffer was full, the bot was shutting down, or setting it aside failed too. The `entry` annotation has the full JSON.                                                                                                                                                                 |
| The service has stopped and isn't restarting               | systemd gave up after 5 failed starts in 10 minutes. Check the logs, then merge a fix, or update the secret and re-run the latest `CI` workflow on `main`.                                                                                                                                                                     |
| The Activity says `The bot isn't in the office yet`        | The bot hasn't seen anyone join, or `office.recording_status` isn't being updated: look for `Couldn't update the recording status` warnings.                                                                                                                                                                                   |
| Pressing Start does nothing                                | Check `office.recording_requests`: no row means the Worker can't reach the database through Hyperdrive (the page says `/api/status answered 503`; check the Hyperdrive config's credentials); a row with no `outcome` means the bot isn't reading them (`Couldn't handle recording requests` in the logs); `ignored` says why. |
| Clips are recorded but never transcribed                   | Look for `Couldn't reach the transcriber` or `daily allocation is used up` warnings. The clips stay `pending` and are picked up when Workers AI is back.                                                                                                                                                                       |
| `Couldn't change the bot's nickname` in the logs           | Give the bot the Change Nickname permission. Recording still works without it.                                                                                                                                                                                                                                                 |
| `Couldn't archive a clip` in the logs                      | The VM can't write to the bucket: check its scopes and the service account's roles on the bucket. The clip was still transcribed from memory.                                                                                                                                                                                  |

## Privacy

This broadcasts people's presence to a wider audience. The opening post shows who opened the office, with their Discord display name and avatar, and the empty post shows how long it was open and how many people came by. Tell the team before turning it on.

For headlines, the AI providers only get the instructions and a few example headlines, never names or anything else from Discord.

[Banter](#banter) is different: the model gets the recorded office activity for up to a week, with everyone's name, and can name people in what it writes. The defaults are free models, and providers of free models may keep and train on what they're sent. Tell the team before turning it on.

The [database](#database) keeps a detailed record of each person's activity in the office channel: when they joined and left, when they muted, deafened, turned on their camera or streamed, and every soundboard sound and emoji reaction they sent, with their Discord user ID and display name, and a real name if one is filled in. Nothing is ever deleted. Tell the team it's being recorded before turning it on.

When [answering in Slack](#answering-in-slack) is on, the bot reads mentions of it and replies under its posts in the office Slack channel. Those messages, the thread around them, people's Slack and office names and this week's office activity go to Clef on Cloudflare and to free AI models, which may keep and train on them. Every message it considers is stored with what it did, and every reaction to its posts is stored, with Slack user IDs. Nothing is ever deleted. Tell the team before switching it on.

While anyone is in the office, the bot shows up in the channel too. It's muted and deafened and never opens an audio connection, so it doesn't hear or record anything anyone says. The exception is a [recording](#recording-the-office), which someone in the office has to start on purpose: for as long as it's on, the bot is un-deafened and renamed `🔴 Recording`, everything said is kept as audio in the bucket and as text in the database, the audio goes to Whisper on Cloudflare, the transcript goes to the free AI models for a summary, and the summary and transcript are posted to Slack. Nothing is ever deleted. Tell the team how it works before turning it on.

Sentry, when it's configured, gets error reports, timings, database queries without their values, and log messages without their annotations, so no names or Discord user IDs. User IDs are also redacted in the announcement logs; an update the database couldn't store is logged in full, but only to the journal.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, what the checks are and what a pull request needs. To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## License

[0BSD](LICENSE). Use it for anything, with no conditions. It comes with no warranty, and I'm not liable for anything that comes of using it.
