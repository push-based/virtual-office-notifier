# Virtual Office

A bot that watches the team's Discord voice channel, the virtual office, and talks about it in Slack. People can also have it record and transcribe the office on demand.

## Language

### Recording on demand

**Office Recorder**:
The Discord Activity that people in the office open to start or stop a recording and to see whether one is running.
_Avoid_: recorder page, Activity page

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

**Recording status**:
What the Office Recorder shows: whether the bot is in the office, who is there, and the recording that is running, if any.
_Avoid_: state, office state
