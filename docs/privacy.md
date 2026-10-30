# Privacy

Each feature below sends or keeps something about people, so tell the team before turning it on.

## Presence in Slack

The announcements broadcast people's presence to a wider audience. The opened post shows who opened the office, with their Discord display name and avatar, and the emptied post shows the [recap](slack.md#the-cards): how long the office was open and how many people came by. Tell the team before turning it on.

## AI providers

For [headlines](slack.md#ai-headlines), the AI providers only get the instructions and a few example headlines, never names or anything else from Discord.

[Banter](slack.md#banter) is different: the model gets the recorded office activity for up to a week, with everyone's name, and can name people in what it writes. The defaults are free models, and providers of free models may keep and train on what they're sent. Tell the team before turning it on.

## The activity record

The [database](database.md#whats-recorded) keeps a detailed record of each person's activity in the office: when they joined and left, when they muted, deafened, turned on their camera or streamed, and every soundboard sound and emoji they sent, with their Discord user ID and display name, and a real name if one is filled in. Nothing is ever deleted. Tell the team it's being recorded before turning it on.

## Answering in Slack

When [answering in Slack](slack.md#answering-in-slack) is on, the bot reads mentions of it and replies under its posts in the office Slack channel. Those messages, the thread around them, people's Slack and office names and this week's office activity go to Clef on Cloudflare and to free AI models, which may keep and train on them. Every message it considers is stored with what it did, and every reaction to its posts is stored, with Slack user IDs. Nothing is ever deleted. Tell the team before switching it on.

## Recording

While anyone is in the office, the bot is in the channel too. It's muted and deafened and never opens an audio connection, so it doesn't hear or record anything anyone says.

The exception is a [recording](recording.md), which someone in the office has to start on purpose. For as long as it's on, the bot is un-deafened and renamed `🔴 Recording`, everything said is kept as audio in the bucket and as text in the database, the audio goes to Whisper on Cloudflare, the transcript goes to the free AI models for a summary and its action items, and the summary, action items and transcript are posted to Slack. The Console's [recording history](recording.md#recording-history) shows every recording, its summary and its transcript to anyone who can open the Console, as everyone in the Slack channel already sees them. Nothing is ever deleted. Tell the team how it works before turning it on.

## Sentry

[Sentry](operations.md#monitoring), when it's configured, gets error reports, timings, database queries without their values, and log messages without their annotations, so no names or Discord user IDs. User IDs are also redacted in the announcement logs; an update the database couldn't store is logged in full, but only to the journal.
