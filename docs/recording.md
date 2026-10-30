# Recording the office

Anyone in the office can have the bot record what's said, from the **Console**, a Discord Activity opened from the rocket button in the voice channel. Each person's speech is kept as audio, transcribed with Whisper, and the summary lands in Slack with the full transcript. The design is in [issue #21](https://github.com/push-based/virtual-office-notifier/issues/21).

It needs the [database](database.md), the bot's Cloudflare account for Whisper, and the Console deployed as a Discord Activity. The steps outside the code are in [the setup guide](setup.md#console).

The Console has three tabs:

- **Now**: the recording status, who's in the office and which of them the bot hears speaking, and the Start, Stop, Pause and Resume buttons.
- **History**: the [recording history](#recording-history), every recording newest first.
- **Stats**: the [office stats](#office-stats) for this week, this month or all time.

Like everything else, recording can't break the announcements. A database, Whisper, storage or Slack outage is logged and retried, and recording itself needs none of them to carry on.

## Starting and stopping

Anyone in the office opens the Console and presses **Start**. Pressing it writes a recording request to `office.recording_requests`; the bot checks for new requests every 2 seconds, and only acts on one from someone who's in the office right now. Anyone in the office can press **Stop**, not just whoever started it. The Now tab shows the state, who's in the room, and when the recording would stop by itself.

A recording stops when someone presses **Stop**, when the office empties, or after 4 hours, whichever comes first, paused or not: the 4 hours include pauses. If the bot restarts mid-recording and the office is still occupied, it carries on under the same recording, still paused if it was; otherwise the recording ends as `bot_restarted`.

Once every clip of a stopped recording is transcribed, the transcript is built with office names and times in office time (UTC+2), the [banter](slack.md#banter) models write [the summary](#the-summary), and the summary is posted to the Slack channel with the full transcript attached in its thread. If nobody said anything, nothing is posted. If no model could write a summary, the post says so and the transcript is still attached.

The summary's link in Slack is stored with the recording, from Slack's `chat.getPermalink`. At startup the bot also links any summary posted without one, and only logs a summary it can't link.

## What the bot captures

While recording, the bot un-deafens, opens an audio connection and is renamed `🔴 Recording`, so everyone in the channel can see it's listening. Discord gives it one stream per speaker, so each stretch of speech becomes a clip of that one person with no speaker detection needed. A clip ends after 1.5 seconds of silence, or at 5 minutes.

- Each clip is written as Ogg/Opus, exactly as Discord sent it, and uploaded to `RECORDINGS_BUCKET` under `recordings/<recording>/<user>/<time>.ogg` with the VM's own identity. Clips are never deleted.
- Clips under half a second are kept but never transcribed, since that's where Whisper makes things up.
- Clips are transcribed one at a time in the background with `WHISPER_MODEL` on Workers AI, in `TRANSCRIPTION_LANGUAGE`. A clip that fails stays pending and is retried, up to 10 times.
- When Workers AI's daily allocation is used up (10,000 Neurons, about 3.5 hours of speech, shared with headlines, banter and Clef), transcription waits for the reset at midnight UTC. Nothing is lost, just late.

## Pausing

Anyone in the office can press **Pause** to go off the record, and anyone can press **Resume**. While paused the bot captures nothing: it drops the audio connection, deafens and is renamed `⏸️ Recording paused`, and the Console shows who paused it and for how long. Each pause leaves one line such as `14:20–14:35 Paused by Ben` in the transcript, which the summary model reads too.

## Title and agenda

Above **Start**, a collapsed **Add a title and agenda** area takes an optional title (up to 80 characters) and agenda (up to 500), sent with the Start request so the recording has them from its first second. Left empty, Start works as before. The design is in [issue #49](https://github.com/push-based/virtual-office-notifier/issues/49).

Afterwards, anyone who can open the Console can change either one on any recording that isn't silent, whether or not they're in the office: on the status card while it's running, or behind **Edit** on its page. Each change is a **recording edit** written to `office.recording_edits`; the bot applies it on its next check, keeps it on record, and the page says `Saving…` until then. Clearing the title brings back the default heading.

The title heads the Slack post (`📝 *Deploy retro* · <date>, 1h 12m`, with `📝 Deploy retro, 1h 12m` as the notification), and when it changes after the post is in Slack, the bot edits the post's heading with `chat.update`. The summary model gets the title and agenda above the transcript, as what people meant to cover rather than what happened. Changing the agenda of a finished recording rewrites its summary.

## The summary

The **Add a title and agenda** area also has a **Summary** field, the **summary style**. The design is in [issue #51](https://github.com/push-based/virtual-office-notifier/issues/51).

| Style                   | What it gives                                                                                         | Length                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Brief** (default)     | What was discussed and any decisions.                                                                 | Under 1,200 characters.                                     |
| **Detailed**            | What was said grouped by topic, each with its points and decisions.                                   | Under 2,800 characters, so it still fits one Slack section. |
| **Decisions & actions** | Only what was decided, with the [action items](#action-items) listed below it like every other style. | Under 1,200 characters.                                     |

Each style has its own prompt and its own length check, and a Detailed summary gets more room to answer from Workers AI. The style goes with the Start request, and changing it later is a recording edit like the title and agenda. On a running or transcribing recording it only decides how the summary will be written. The post's footer names the style: `✨ Detailed summary by <model>`.

A finished recording's summary is **rewritten** when someone changes its summary style or its agenda, or presses **Rewrite summary** on its page, which keeps the style and is there for a summary that came out wrong or that no model could write.

- Each rewrite is a recording edit on record, and the bot writes it straight after applying the edit. Edits made while a rewrite is being written don't each get one: once it's done, the bot writes one more with the latest settings.
- The bot edits the summary in the original post with `chat.update` and adds one note to its thread, `✨ Summary rewritten as Detailed by Ben`, or `✨ Summary rewritten by Ben` when the style is the same as the summary it replaces. Every version is kept in `office.recording_summaries`.
- A rewrite also pulls the action items out again, retiring the old ones (`replaced_at`), but only while nobody has ticked, unticked or reassigned any of them; after that they're kept as they are.
- If no model can rewrite it, the summary stays as it was. The page says `Rewriting…` until it's done, and a rewrite still waiting when the bot restarts is written once it's back.

## Action items

When a recording finishes, the [banter](slack.md#banter) models are asked separately for its **action items**: a JSON list of what needs doing and who took it on, checked against a schema. The design is in [issue #52](https://github.com/push-based/virtual-office-notifier/issues/52).

- Each owner is matched to someone who was in the office during the recording (who was there when it started, who came in, who spoke and who started it), by their full name or a first name only one of them has; anyone else is **Unassigned**. The summary leaves action items out.
- The Slack post lists them in their own block below the summary, in order, with plain names rather than @-mentions, and done ones struck through with ✅. If no model answers, the post says `No action items could be pulled out`.
- On the recording's page, the **Action items** section shows each one with its owner's avatar and name and a checkbox. Anyone who can open the Console can tick or untick one and change its owner to anyone from the office. Each change is a recording edit, kept on record, and the bot edits the Slack post with `chat.update`, without a note in the thread.
- Items can't be reworded or deleted: a wrong one can be ticked done.

## Recording history

The **History** tab lists every recording, newest first, 20 at a time with **Show older**, refreshed every 15 seconds. Each one is **Running**, **Transcribing** (stopped, with speech still waiting for Whisper), **Finished** (summary posted to Slack) or **Silent** (nobody spoke, so nothing was posted), and shows when it started in office time, how long it ran, who started it and who spoke.

Tapping one that isn't silent opens its page: how it stopped, the summary as posted, **Open in Slack**, and the transcript built from the clips, one line per clip and grouped by speaker, leaving out skipped and failed clips. A running or transcribing recording shows the transcript so far and refreshes every 5 seconds. Anyone who can open the Console sees every recording, as everyone in the Slack channel already does.

## Office stats

The **Stats** tab shows the office stats for this week, this month or all time. It counts everything when it's opened or the range changes, and never polls. Each total is worked out in SQL from the `office.voice_activity` and `office.office_activity` views and `office.recordings`, so the Console's database role needs their `GRANT` from [the setup guide](setup.md#database-role). Without it, the tab answers `503` and the rest of the Console works as before.

- Weeks start on Monday and months on the 1st, both at midnight in office time, UTC+2.
- **Time in the office** runs from `Joined` (or `AlreadyThere`, for anyone in when the bot started) to that person's next `Left`. Someone who's still in counts until now. When the bot stopped without seeing them leave, the stay ends at the last thing that run of the bot saw. Stays that cross the start of the range only count from the start.
- **First in** and **last out** count, for each day, who arrived first and who left last. A day where someone's still in has no last out yet.
- **Busiest hours** is a weekday × hour grid of how many people were in on average, over every such hour in the range.
- **Soundboard**, **emoji** and **recordings** count what happened in the range, with the top 10 of each list.

## Rich Presence

While someone has the Console open, their Discord profile shows it too: `Recording the office`, `Started by <name>` and the time since it started, or `In the office` / `Not recording`, or `Office is empty`. It only changes when the recording starts, stops or changes hands, and if Discord refuses it, the page carries on and the browser console says `Couldn't update the Rich Presence`. Setting it needs the `rpc.activities.write` scope, so everyone who had already allowed the Console is asked to allow it once more. The design is in [issue #53](https://github.com/push-based/virtual-office-notifier/issues/53).

## Checking audio and Whisper

Received audio has to decrypt, since Discord's voice is end-to-end encrypted (DAVE), and Whisper has to accept Ogg/Opus as is. [`apps/bot/scripts/try-recording.ts`](../apps/bot/scripts/try-recording.ts) checks both: it joins the office with audio on for a minute, writes one `.ogg` per stretch of speech into `recordings-check/`, and sends the first one to Whisper. Have someone say a few words while it runs. It needs the Discord token and channel, and the Cloudflare account and token for the Whisper step; it never touches the database or Slack.

```bash
node --env-file=.env apps/bot/scripts/try-recording.ts --seconds 60
```
