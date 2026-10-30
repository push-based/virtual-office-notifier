# Virtual Office

A bot that watches the team's Discord voice channel, the virtual office, and talks about it in Slack. People can also have it record and transcribe the office on demand.

## Language

### Bot and Console

**Bot**:
The always-on member of the office that joins while it's occupied, records voice activity, posts to Slack, and is the only one that acts on recording requests and recording edits.
_Avoid_: daemon, server, worker

**Console**:
What people open as a Discord Activity to see what the bot is doing and to file recording requests and recording edits for it; it never changes the office or a recording itself.
_Avoid_: Office Recorder, Activity, recorder page, app, dashboard

### Office presence

**Office**:
The team's one Discord voice channel that the bot watches, the virtual office.
_Avoid_: channel, room, voice channel

**Occupancy**:
One stretch of the office having people in it, from the first person joining to the last one leaving.
_Avoid_: session, visit, opening

**Opened**:
The office going from empty to occupied as the first person joins, which the bot announces in Slack.
_Avoid_: started, joined

**Emptied**:
The office going from occupied to empty as the last person leaves, which the bot announces in Slack with the recap.
_Avoid_: closed, ended

**Recap**:
How an occupancy went: how long the office was open and how many people stopped by.
_Avoid_: summary, report

**Voice activity**:
Everything Discord reports about people in the office, such as joining, leaving, muting or turning on a camera, together with the voice effects sent there, as the bot records it.
_Avoid_: activity on its own, events, logs

**Voice effect**:
A soundboard sound or emoji reaction someone sends in the office.
_Avoid_: expression, effect on its own

**Reminder**:
The weekday Slack post at 11:15 office time inviting people into the office.
_Avoid_: nudge, ping

**Banter**:
A Slack post an AI model writes about recent voice activity, at most five a day, at random times between 09:00 and 18:00 office time.
_Avoid_: chatter, commentary, small talk

### Recording on demand

**Recording**:
One stretch of the office captured by the bot, from when someone starts it until someone stops it, the office empties, or it hits its time limit. A recording is Running, Transcribing, Finished or Silent.
_Avoid_: session, meeting, call

**Running**:
A recording that hasn't stopped yet.
_Avoid_: active, live, in progress

**Transcribing**:
A recording that has stopped, with speech still waiting for Whisper, so it has no summary yet.
_Avoid_: processing, pending

**Finished**:
A recording whose transcript and summary are done and posted to Slack.
_Avoid_: done, complete, posted

**Silent**:
A recording that stopped with nothing said, so it has no summary and nothing in Slack.
_Avoid_: empty, blank

**Recording history**:
Every recording, newest first, as the Console lists it, the running one included.
_Avoid_: archive, past recordings, log

**Recording request**:
One press of Start, Stop, Pause or Resume in the Console, by one person, which the bot later either acts on or ignores.
_Avoid_: command, press, action

**Request outcome**:
What the bot did about a recording request: started, stopped, paused or resumed a recording, or ignored the request.
_Avoid_: result, response

**Ignore reason**:
Why the bot ignored a recording request or a recording edit, such as the request being too old, the person not being in the office, or the recording being silent.
_Avoid_: rejection, error

**Pause**:
A stretch of a running recording that is off the record: the bot captures nothing until someone resumes it.
_Avoid_: mute, break, hold

**Title**:
An optional name for a recording, given before it starts or at any time after, shown in the Console and as the heading of its Slack post.
_Avoid_: name, subject, topic

**Agenda**:
An optional note on what a recording is meant to cover, which the summary takes into account.
_Avoid_: description, notes, context

**Summary style**:
How a recording's summary is written: Brief, Detailed, or Decisions & actions.
_Avoid_: format, mode, template

**Action item**:
A piece of follow-up work someone took on in a recording, owned by one person from the office or unassigned, and open until someone marks it done.
_Avoid_: task, todo, follow-up

**Recording edit**:
One change to a recording's title, agenda, summary style or action items, by one person, which the bot later applies or ignores and keeps on record either way.
_Avoid_: update, rename

**Edit outcome**:
What the bot did about a recording edit: applied it or ignored it.
_Avoid_: result, response

**Office stats**:
Totals over the recorded voice activity for this week, this month or all time, in office time: time in the office, first in and last out, the busiest hours, the soundboard leaderboard, top reactions and recordings.
_Avoid_: analytics, metrics, dashboard

**Office time**:
UTC+2 all year, with no daylight saving. Days, weeks and hours in the office stats, the reminder and the transcripts are all in office time.
_Avoid_: local time, CET

**Recording status**:
What the Console shows: whether the bot is in the office, who is there and which of them the bot hears speaking, and the recording that is running, if any.
_Avoid_: state, office state
