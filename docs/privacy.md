# Privacy

Each feature below sends or keeps something about people, so tell the team before turning it on. [Where the data sits](#where-the-data-sits) is every place it ends up, and [running it for anyone else](#running-it-for-anyone-else) is what the GDPR expects of you once the office holds someone who hasn't agreed to all this.

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

While anyone is in the office, the bot is in the channel too. It's muted and deafened. It keeps a voice connection open so a recording can start without rejoining, but outside a recording it stays deafened and never listens to anyone's audio, so it doesn't hear or record anything anyone says.

The exception is a [recording](recording.md), which someone in the office has to start on purpose. For as long as it's on, the bot is un-deafened and renamed `🔴 Recording`, everything said is kept as audio in the bucket and as text in the database, the audio goes to Whisper on Cloudflare, the transcript goes to the free AI models for a summary and its action items, and the summary, action items and transcript are posted to Slack. The Console's [recording history](recording.md#recording-history) shows every recording, its summary and its transcript to anyone who can open the Console, as everyone in the Slack channel already sees them. Nothing is ever deleted. Tell the team how it works before turning it on.

## Sentry

[Sentry](operations.md#monitoring), when it's configured, gets error reports, timings, database queries without their values, and log messages without their annotations, so no names or Discord user IDs. A lost voice connection also sends the steps of that join, which name no one. User IDs are also redacted in the announcement logs; an update the database couldn't store is logged in full, but only to the journal.

From the Console, Sentry gets the same: no request or response bodies, so no sign-in codes, tokens, titles or agendas; no headers or cookies; no session replays; and no console lines or clicks in the breadcrumbs. It does get the URLs of `/api/*` calls, which carry recording IDs but no names. When Discord's proxy or the Worker can't be reached, it also gets the status, five response headers that say who answered (`retry-after`, `cf-ray`, `server`, `via`, `content-type`) and the first 200 characters of that error response, which comes from the proxy rather than from anyone's data.

## Where the data sits

| What                                                                                                       | Where it lives                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Voice activity, members, Slack messages and decisions, recordings, transcripts, summaries and action items | The Supabase Postgres [database](database.md), on AWS in `eu-west-1`, Ireland                                                     |
| The audio of every recording                                                                               | The private `virtual-office-notifier-recordings` bucket on Google Cloud Storage, in `us-central1`, with no rule deleting anything |
| The bot's process and its journal                                                                          | The [VM](operations.md#the-vm) in `us-central1-a`                                                                                 |
| Announcements, banter, replies, summaries, action items and transcripts                                    | The office Slack channel, for as long as the workspace keeps messages                                                             |
| Discord user IDs, display names and avatars                                                                | Discord, which the bot reads people from and never writes people to                                                               |
| Speech, transcripts and office activity with everyone's names                                              | Cloudflare Workers AI and OpenRouter while a request is in flight, and with the providers of the free models afterwards           |
| Error reports and timings, with no names or Discord user IDs                                               | [Sentry](#sentry), when it's configured                                                                                           |

## Why it's kept

| What                                                             | Why                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The activity record: voice activity, soundboard sounds and emoji | To understand how the office is used: who's in it and when, how long it stays open, how busy it gets and how that changes, as the [office stats](recording.md#office-stats) show. And to give [banter](slack.md#banter) something to write about.           |
| Slack messages, decisions and reactions                          | To [answer in Slack](slack.md#answering-in-slack), and to judge how the bot's posts land.                                                                                                                                                                   |
| Recordings: the audio, transcripts, summaries and action items   | To transcribe meetings and whatever else is discussed in the office, so nobody has to take notes, the way Google Meet transcribes a meeting. They're a record of the company's own work and decisions, kept for reference afterwards, like meeting minutes. |

All of it is kept indefinitely. How the office is used only means something over months and years, and the transcripts are company records. The exception is someone asking for their data to be deleted, which [issue #161](https://github.com/push-based/virtual-office-notifier/issues/161) makes possible from the Console.

## How we run it

It's an internal tool for one team. Nobody has to be in the office: it's a voice channel people choose to sit in, not somewhere their work, meetings or standing depend on, and everyone can be reached the usual ways without it. Recording is part of what the office is. The activity record, the soundboard sounds and emoji, and recordings are what the announcements, banter, stats and summaries are made from, so they can't be switched off for one person. Coming into the office means agreeing to them, and anyone who doesn't want that can stay out of the channel and lose nothing else.

Today that agreement is the team's: we asked them before each feature went on and they agreed to it. Nothing it keeps leaves the team's own Slack, Console and infrastructure. There's no notice yet, no record of who agreed and no way to export or erase one person's data. [Issue #161](https://github.com/push-based/virtual-office-notifier/issues/161) adds them: everyone who joins is asked for their consent and shown out if they don't give it within a minute, nothing about them is recorded until they agree, and the Console gets buttons to withdraw consent and delete everything kept about them.

## Running it for anyone else

Asking around the table stops being enough as soon as someone in the office hasn't agreed: a client, a guest, a contractor, a new hire nobody briefed, or anyone at all if this is run as a service or for a team that isn't yours. Everything it keeps is personal data under the GDPR, and recorded speech is as personal as it gets. From then on you're the controller, and the code does none of this for you:

- **A lawful basis you've written down.** Consent is the obvious one for recording what people say, and consent has to be freely given. Recording as a condition of being in the office holds up only while the office really is optional: if anyone's work, meetings or standing come to depend on being there, saying no costs them something, and their consent no longer counts. That's the usual risk when the employer is the one asking. Legitimate interests is the usual alternative and needs a balancing test you keep.
- **Telling people, before the bot is in the room.** What's recorded, why, how long it's kept, who it goes to and what the free models may do with it. The sections above are the content; delivering it is yours.
- **Access, erasure and the rest of the rights.** Nothing is ever deleted and nothing can be exported or erased per person, so a request means doing it by hand across the database, the bucket and Slack, as [above](#where-the-data-sits). Keeping it forever needs a reason you've written down, as [why it's kept](#why-its-kept) is ours.
- **Agreements with everyone it's sent to.** Supabase, Google Cloud, Cloudflare, OpenRouter and whichever models answer, Slack, Discord and Sentry are all processors or recipients. The free models are the awkward ones: their providers may keep and train on what they're sent, and that can't be taken back.
- **Transfers.** The database is in Ireland, the VM and the clips bucket are in the US, and the models are wherever their provider runs them.
- **A DPIA, most likely.** Recording colleagues, keeping it forever and feeding it to models is the kind of systematic monitoring that asks for one before you start. Where there's a works council, this is usually theirs to agree to as well.

None of that is legal advice. It's the list of things the code doesn't do, so nobody assumes it does.
