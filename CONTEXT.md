# Virtual Office

A bot that watches the team's Discord voice channel, the virtual office, and talks about it in Slack. People can also have it record and transcribe the office on demand.

## Language

### Recording on demand

**Office Recorder**:
The Discord Activity that people in the office open to start or stop a recording and to see whether one is running.
_Avoid_: recorder page, Activity page

**Recording**:
One stretch of the office captured by the bot, from when someone starts it until it stops. A recording is Running, Transcribing, Finished or Silent.
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
Every recording, newest first, as the Office Recorder lists it, the running one included.
_Avoid_: archive, past recordings, log

**Recording request**:
One press of Start, Stop, Pause or Resume in the Office Recorder, by one person, which the bot later either acts on or ignores.
_Avoid_: command, press, action

**Request outcome**:
What the bot did about a recording request: started a recording, stopped one, or ignored the request.
_Avoid_: result, response

**Ignore reason**:
Why the bot ignored a recording request, such as the request being too old or the person not being in the office.
_Avoid_: rejection, error

**Pause**:
A stretch of a running recording that is off the record: the bot captures nothing until someone resumes it.
_Avoid_: mute, break, hold

**Title**:
An optional name for a recording, given before it starts or at any time after, shown in the Office Recorder and as the heading of its Slack post.
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
One change to a recording's title, agenda, summary style or action items, by one person, which the bot applies and keeps on record.
_Avoid_: update, rename

**Office stats**:
Totals over the recorded voice activity for this week, this month or all time, in office time: time in the office, first in and last out, the busiest hours, the soundboard leaderboard, top reactions and recordings.
_Avoid_: analytics, metrics, dashboard

**Office time**:
UTC+2 all year, with no daylight saving. Days, weeks and hours in the office stats, the reminder and the transcripts are all in office time.
_Avoid_: local time, CET

**Recording status**:
What the Office Recorder shows: whether the bot is in the office, who is there, and the recording that is running, if any.
_Avoid_: state, office state
