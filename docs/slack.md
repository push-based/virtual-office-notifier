# What it posts in Slack

Everything the bot says in Slack goes to the one channel in `SLACK_CHANNEL_ID`: the opened and emptied announcements, the weekday reminder, the banter and its replies. This page is what each one looks like, when it goes out and how the AI-written ones are made. Setting up the Slack app and the AI providers is in [Setting it up](setup.md#slack-app).

## The cards

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

The button opens the office in Discord, the opened card carries the opener's avatar, and the times show in each reader's own time zone. When an AI model writes the headline and button label, the card adds a `✨ Headline by <model>` line. See [AI headlines](#ai-headlines).

Banter is always written by an AI model, from what actually happened in the office:

> 🎬 Wednesday's crew arrived like a flash mob: Barbara, Alan, Grace and Linus all joined within 8 minutes, cameras snapped on in unison, then off together 40 minutes later.
>
> `🚪 Join the ensemble`
>
> ✨ Banter by nvidia/nemotron-3-ultra-550b-a55b:free · 🤖 AI is a hallucination machine.

A [recording](recording.md#the-summary) also ends in a Slack post, with its summary, action items and transcript.

## When it posts

| Post     | Trigger                                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opened   | The first person joins the empty office. Moving in from another voice channel counts as joining.                                                                                                    |
| Emptied  | The last person leaves. Moving to another voice channel counts as leaving. The recap is left out for an occupancy that was already under way when the bot started, since it missed the beginning.   |
| Reminder | Weekdays at 11:15 office time (UTC+2). It's a fixed offset, so it doesn't shift with daylight saving. Skipped if the office wasn't found at startup, since there's nothing to link to.              |
| Banter   | At random, between 1 and 2½ hours apart, from 09:00 to 18:00 office time on weekdays, and at most 5 a day. See [Banter](#banter).                                                                   |
| Reply    | In the thread, when someone mentions the bot or Clef decides a reply under one of its posts wants an answer, 09:00 to 18:00 office time on weekdays. See [Answering in Slack](#answering-in-slack). |

Only the first person in and the last person out are announced. Joins and leaves in between aren't, to keep the channel quiet. It only watches the one office and ignores bots, itself included. Mute, deafen and camera changes, soundboard sounds and emoji reactions aren't announced, only [recorded](database.md#whats-recorded).

The bot counts whoever is already in the office at startup, so a restart mid-occupancy doesn't announce the office opening again.

The fixed opened and emptied headlines are picked at random from a few phrasings. The reminder rotates through its phrasings by date, so each one comes up once before any repeats.

The original design is in [issue #1](https://github.com/push-based/virtual-office-notifier/issues/1).

## AI headlines

Optional. With neither [AI provider](setup.md#ai-providers) configured, every post uses the fixed phrasings.

Every opened, emptied and reminder post gets a fresh headline and join button label from a free AI model, and the card credits the model that wrote them.

**What the model sees and returns**

- The model never sees anyone's name. For an opened office it writes a `{name}` placeholder that's filled in afterwards, and the other posts don't name anyone.
- The reply must be exactly two lines: a headline of up to 160 characters and a button label of up to 30. The headline has the placeholder exactly once for an opened office and not at all otherwise, and neither line may contain Slack link syntax. The reply is escaped before it's posted.
- Nothing checks that what the model says is true, and it does get things wrong.

**Which model writes it**

- Each post picks OpenRouter or Workers AI at random to go first and falls back to the other, using whichever are configured.
- Within a provider, models are tried one at a time in a random order. The first in its list goes first at least half the time (`openrouter/free` by default, which lets OpenRouter choose any free model that's up).
- A model that fails, takes longer than a minute, or replies with something unusable is skipped for the next one, and each skip is logged as `AI model couldn't write it` with the model and the reason.
- If OpenRouter says the key's daily free limit is used up (50 requests a day without credits, 1,000 with at least $10 of credit), the rest of OpenRouter's models are skipped, since they'd all be refused too, and Workers AI is tried if it hasn't been already. The same goes for Workers AI when Cloudflare says the day's allowance is used up.
- If every model fails, the post goes out with the fixed headline and label.

Workers AI includes 10,000 Neurons a day for free, which covers a few hundred headlines on the default models. [Clef](#answering-in-slack), replies, [banter](#banter) and [transcription](recording.md#what-the-bot-captures) come out of the same allowance, so replies try OpenRouter first.

## Banter

Up to five times a working day, at random, an AI model reads what happened in the office and posts something playful about it. It needs the [database](setup.md#database) and at least one [AI provider](setup.md#ai-providers). Without the database, every chance is skipped with a `Skipped banter` warning.

**When it posts**

- After a random wait of 60 to 150 minutes, it checks whether it's 09:00 to 18:00 office time on a weekday, and whether fewer than 5 have gone out since midnight office time. If so, it posts; either way, it waits again.
- Each one is stored in [`banter_posts`](database.md#whats-recorded) before the AI writes it, so the daily limit holds across restarts, and one the AI couldn't write still counts. That keeps it to at most 5 attempts' worth of AI requests a day.
- If every model fails, nothing is posted. There's no fixed fallback.

**What the model sees and returns**

- It picks one stretch of time at random: today so far, yesterday and today, this week so far (from Monday), or last week.
- The model gets the time, who's in the office right now, and every entry of the [`office_activity`](database.md#the-views) view in that stretch, as is, with times in office time: `Wed 30 Sep 15:00 Barbara CameraOn` or `Wed 30 Sep 15:03 Alan PlayedSound airhorn`. A busy stretch is cut to its latest 400 entries, and the model is told how many were left out.
- People are named with their `real_name` when it's filled in, or their Discord display name. Who's in right now comes from what this run of the bot recorded.
- The prompt asks for something playful and warm, never mean, that only says what the log shows. The reply must be exactly two lines: a message of up to 300 characters and a button label of up to 30, with no Slack link syntax. The reply is escaped before it's posted.
- Nothing checks that what the model says is true, and it does get things wrong, so every bit of banter says it's AI-written and may be made up.

**Which model writes it**

The same way as the headlines, except OpenRouter uses `OPENROUTER_BANTER_MODELS`. Its defaults leave out the `openrouter/free` router, because it often picks a small model that misses the point of the log or makes things up.

**Trying it on made-up data**

[`apps/bot/scripts/try-banter.ts`](../apps/bot/scripts/try-banter.ts) runs the scenarios in [`apps/bot/scripts/banter-scenarios.ts`](../apps/bot/scripts/banter-scenarios.ts): a busy Friday, an empty office, a mute marathon, a lone regular, last week's early bird and a camera party. It never posts to Slack or touches the database.

```bash
node --env-file=.env apps/bot/scripts/try-banter.ts
```

On its own it only prints the prompts. With `--call-ai` it asks one OpenRouter model once per scenario, with no fallback, so a run is at most 6 requests. `BANTER_MODEL` picks the model (the first of the banter defaults otherwise) and `BANTER_SCENARIO` runs just one scenario by name.

```bash
node --env-file=.env apps/bot/scripts/try-banter.ts --call-ai
```

## Answering in Slack

When someone mentions the bot or replies under one of its posts, it can answer, react or stay out of it. It needs the [database](setup.md#database), and stays off until it's switched on there. Mentions also need at least one [AI provider](setup.md#ai-providers), and replies under the bot's posts need Cloudflare for Clef. The design is in [issue #18](https://github.com/push-based/virtual-office-notifier/issues/18).

**What it considers**

- Only messages in the `SLACK_CHANNEL_ID` channel.
- **Mentions of the bot.** These always get a reply, within the limits below, in the thread they're in, or in a new thread under a mention that isn't in one.
- **Replies in threads under the bot's own posts**: announcements, reminders, banter and its own replies. [Clef](https://blog.cloudflare.com/clef-decision-models/), a decision model on Workers AI, decides whether to reply, react with an emoji or ignore it.
- Nothing else: other channels, DMs, top-level messages that don't mention it, other bots and itself, edits, deletions and joins. A mention inside a thread under its post is handled once, as a mention.

**How it decides**

- Clef gets the bot's post, the last few messages in the thread and the new one, each cut to 1,000 characters. It answers with a choice and a confidence for the action (`reply`, `react` or `ignore`) and for the emoji. The bot acts only when the action's confidence is at least `min_confidence`. Every request is stored with Clef's answer, so the threshold can be tuned on real data later.
- The reply is written by the [banter](#banter) models, OpenRouter first, in the same warm and gently teasing voice. The model gets the thread (up to the last `writer_thread_messages` messages), who's in the office right now and this week's [`office_activity`](database.md#the-views), at most 400 entries. The reply must be one message of up to 600 characters with no Slack link or mention syntax. It's escaped and posted in the thread with a line crediting the model and saying it's AI.
- Slack text is untrusted. The model has no tools, and what it writes is checked and escaped, so a message that tries to give it instructions can only change what it says, not what it does.
- People in the thread are shown by their Slack name, or by their office name when they're linked: `office.members.slack_user_id` first, then a case-insensitive match of their Slack real name against `real_name`. The model is told not to assume anyone else in the thread is anyone in the log.

**Limits**

- Only 09:00 to 18:00 office time on weekdays, mentions included.
- At most `max_replies_per_day` replies and `max_reactions_per_day` reactions per office day, and `max_replies_per_thread` replies in any one thread. Mentions count. When it couldn't act anyway, Clef isn't asked. A reply that's over a limit is never turned into a reaction.
- Each thread keeps only its latest waiting message: an older one is skipped as `superseded`. Mentions wait separately, so chatter can't push one out. Threads take turns, one message at a time, in the order they first spoke, and a message that waited more than `stale_after_seconds` is skipped as `stale`.
- Every message it considers is [recorded](database.md#whats-recorded) with what it did and why: `replied`, `reacted` or `ignored`, because of `clef`, `mention`, `low_confidence`, `daily_cap`, `thread_cap`, `outside_hours`, `stale`, `superseded`, `clef_failed` or `no_model`.
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
