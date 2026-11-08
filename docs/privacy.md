# Privacy

Each feature below sends or keeps something about people, so tell the team before turning it on. [Where the data sits](#where-the-data-sits) is every place it ends up, and [running it for anyone else](#running-it-for-anyone-else) is what the GDPR expects of you once the office holds someone who hasn't agreed to all this.

## Consent

Everyone who joins the office is asked whether they agree to being recorded, and nothing about them is recorded until they do. The design is in [issue #161](https://github.com/push-based/virtual-office-notifier/issues/161).

- **Asking.** When someone joins and hasn't agreed to the current notice, the bot sends them a DM with what the office records, why, and **I agree** and **No thanks** buttons. If their DMs are closed, it asks in the voice channel's chat instead, mentioning them, and only they can press the buttons. Someone who comes back after saying no, or after not answering, is asked again in different words.
- **A minute to answer.** **No thanks**, or no answer within a minute, and the bot disconnects them from the office, with a sad goodbye. Leaving before answering just lets the question lapse.
- **Nothing before a yes.** Until they agree, none of their voice activity, sounds or emoji reach the database, they're left out of who's in the office in the Console, their speech isn't captured in a recording, and they can't start one. A clip of speech that began before they agreed is dropped too. They don't open the office in Slack either: the **Opened** post waits for whoever agrees first. Their voice activity in that minute is held in memory and recorded once they agree, so the record starts when they really joined; their sounds and emoji in that minute are dropped.
- **Once is enough.** Someone who agreed isn't asked again, until they withdraw or the notice changes. The notice has a version, `CONSENT_NOTICE_VERSION` in [`libs/recording-requests/src/Wire.ts`](../libs/recording-requests/src/Wire.ts), and raising it asks everyone again on their next join.
- **Withdrawing.** The Console's **Privacy** tab says when you agreed, and **Withdraw consent** withdraws it: the bot records it, shows you out of the office if you're in, and sends you a DM. Nothing new is recorded about you from then on, and you're asked again next time you join. What was already recorded stays until you ask for it to be deleted.
- **Deleting your data.** **Delete my data**, on the same tab, asks for everything the office holds about you to be deleted, after a confirmation. Your consent is withdrawn on the spot: the bot shows you out if you're in, nothing new is recorded about you, and it sends you a DM with the date. The deletion itself runs 30 days later, the month the GDPR gives us (Article 12(3)) to check whether anything has to be kept, or sooner if an admin decides so. When it runs, the bot:
  - deletes your voice activity, sounds and emoji, your member record, the Slack messages and reactions of yours it kept with what it decided about them, and your clips in every recording, audio included;
  - takes your name, and mentions of your Slack account, out of everything that's left: other people's lines in transcripts, recording titles, agendas, summaries and action items, other people's Slack messages it kept, and its own posts, which it edits in Slack too, dropping your avatar from the **Opened** post. You're cleared as the owner of any action item, and recordings, requests and edits you made say "a former member";
  - writes each recording you spoke in again from what's left: a new transcript in the thread, a new summary and new action items, unless someone has already ticked or reassigned them, in which case they stay without you;
  - deletes your consent history, and keeps one row with no personal data as proof the erasure happened, then sends you a DM.

  Your name is matched as it's written, full and first name, from three letters up, so a nickname the office never stored isn't caught, and a name that's also a word can be replaced where it starts a sentence ("Will"). A post the bot can no longer edit, or a channel it can no longer read, is skipped and reported as an error to fix by hand. Slack messages of your own stay in Slack, where you can delete them yourself, and so do other people's Slack messages that mention you. If you come back, you're asked as if you'd never been. Supabase's backups and Cloud Storage's soft delete keep deleted data for up to 7 days.

- **The 30 days.** The request goes to the office admins at once, as a Discord DM and a Slack DM each, with exactly what will be deleted: how many rows of activity, sounds and emoji, Slack messages and reactions, spoken lines and audio files, which recordings get rewritten, and where your name will be taken out. They can **Delete now**, which runs it within a minute, **Let it run**, which only notes they've seen it, or **Refuse**, which the GDPR allows only on two grounds here (Article 17(3)): a legal obligation to keep the data, or an ongoing legal claim that needs it. A refusal needs a typed reason, which you get word for word in a DM together with a link to the data protection authorities you can complain to (Article 12(4)), and your consent stays withdrawn. If nobody acts, the deletion runs on the due date. The admins are listed in [`libs/recording-requests/src/Admins.ts`](../libs/recording-requests/src/Admins.ts), and only they can act, whether from Discord, Slack or the Console: every press is checked against that list on the server.
- **Cancelling.** You can cancel from the Privacy tab until the deletion runs. If you come back to the office in the meantime, the consent question says that agreeing cancels the request, and agreeing does. Nobody who has agreed to being recorded is ever erased: the bot checks again inside the deleting transaction, and cancels instead.

- **Proof.** Every question, answer, disconnect and withdrawal is kept in `office.consent_events`, with which version of the notice was shown and how it was delivered, as [the database](database.md#whats-recorded) describes, until that person's data is deleted.
- **When the database is down.** The bot reads who already agreed once, when it starts, and keeps it in memory, so an outage after that changes nothing: answers are kept in memory and written once it's back. If it can't read that at startup, it waits for the database before asking anyone, and nobody is recorded, announced or shown out until it can. Without `DATABASE_URL`, everyone is asked, and answers only last until the bot restarts.
- **After a restart.** Whoever is already in the office is asked if they haven't agreed, and let in quietly once they do, as if they'd been there all along, so the office isn't announced as opening again.

## Presence in Slack

The announcements broadcast people's presence to a wider audience. The opened post shows who opened the office, with their Discord display name and avatar, and the emptied post shows the [recap](slack.md#the-cards): how long the office was open and how many people came by. Tell the team before turning it on.

## AI providers

For [headlines](slack.md#ai-headlines), the AI providers only get the instructions and a few example headlines, never names or anything else from Discord.

[Banter](slack.md#banter) is different: the model gets the recorded office activity for up to a week, with everyone's name, and can name people in what it writes. The defaults are free models, and providers of free models may keep and train on what they're sent. Tell the team before turning it on.

## The activity record

The [database](database.md#whats-recorded) keeps a detailed record of each person's activity in the office: when they joined and left, when they muted, deafened, turned on their camera or streamed, and every soundboard sound and emoji they sent, with their Discord user ID and display name, and a real name if one is filled in. Nothing is deleted unless someone [asks for their data to be deleted](#consent). Tell the team it's being recorded before turning it on.

## Answering in Slack

When [answering in Slack](slack.md#answering-in-slack) is on, the bot reads mentions of it and replies under its posts in the office Slack channel. Those messages, the thread around them, people's Slack and office names and this week's office activity go to Clef on Cloudflare and to free AI models, which may keep and train on them. Every message it considers is stored with what it did, and every reaction to its posts is stored, with Slack user IDs. Nothing is deleted unless someone [asks for their data to be deleted](#consent). Tell the team before switching it on.

## Recording

While anyone is in the office, the bot is in the channel too. It's muted and deafened. It keeps a voice connection open so a recording can start without rejoining, but outside a recording it stays deafened and never listens to anyone's audio, so it doesn't hear or record anything anyone says.

The exception is a [recording](recording.md), which someone in the office has to start on purpose. For as long as it's on, the bot is un-deafened and renamed `🔴 Recording`, everything said is kept as audio in the bucket and as text in the database, the audio goes to Whisper on Cloudflare, the transcript goes to the free AI models for a summary and its action items, and the summary, action items and transcript are posted to Slack. The Console's [recording history](recording.md#recording-history) shows every recording, its summary and its transcript to anyone who can open the Console, as everyone in the Slack channel already sees them. Nothing is deleted unless someone [asks for their data to be deleted](#consent). Tell the team how it works before turning it on.

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

## How we run it

It's an internal tool for one team. Everyone the bot records works here and is in the office by choice, and we asked the team before each feature went on and they agreed to it. Nothing it keeps leaves the team's own Slack, Console and infrastructure.

That agreement is the whole basis for it. There's no sign-up screen and no way to export one person's data, because the people in the office are the people who run it and they can be asked.

## Running it for anyone else

Asking around the table stops being enough as soon as someone in the office hasn't agreed: a client, a guest, a contractor, a new hire nobody briefed, or anyone at all if this is run as a service or for a team that isn't yours. Everything it keeps is personal data under the GDPR, and recorded speech is as personal as it gets. From then on you're the controller, and the code does none of this for you:

- **A lawful basis you've written down.** Consent is the obvious one for recording what people say, and consent has to be freely given, which it isn't when the employer is the one asking. Legitimate interests is the usual alternative and needs a balancing test you keep.
- **Telling people, before the bot is in the room.** What's recorded, why, how long it's kept, who it goes to and what the free models may do with it. The sections above are the content; delivering it is yours.
- **Access, erasure and the rest of the rights.** Erasure is built in, as **Delete my data** under [Consent](#consent). Nothing can be exported per person, so an access request means doing it by hand across the database, the bucket and Slack, as [above](#where-the-data-sits). Keeping it forever needs a reason of its own.
- **Agreements with everyone it's sent to.** Supabase, Google Cloud, Cloudflare, OpenRouter and whichever models answer, Slack, Discord and Sentry are all processors or recipients. The free models are the awkward ones: their providers may keep and train on what they're sent, and that can't be taken back.
- **Transfers.** The database is in Ireland, the VM and the clips bucket are in the US, and the models are wherever their provider runs them.
- **A DPIA, most likely.** Recording colleagues, keeping it forever and feeding it to models is the kind of systematic monitoring that asks for one before you start. Where there's a works council, this is usually theirs to agree to as well.

None of that is legal advice. It's the list of things the code doesn't do, so nobody assumes it does.
