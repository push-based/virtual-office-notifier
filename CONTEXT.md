# Virtual Office

A bot that watches the team's Discord voice channel, the virtual office, and talks about it in Slack. People can also have it record and transcribe the office on demand.

## Language

### Recording on demand

**Office Recorder**:
The Discord Activity that people in the office open to start or stop a recording and to see whether one is running.
_Avoid_: recorder page, Activity page

**Recording request**:
One press of Start or Stop in the Office Recorder, by one person, which the bot later either acts on or ignores.
_Avoid_: command, press, action

**Request outcome**:
What the bot did about a recording request: started a recording, stopped one, or ignored the request.
_Avoid_: result, response

**Ignore reason**:
Why the bot ignored a recording request, such as the request being too old or the person not being in the office.
_Avoid_: rejection, error

**Recording status**:
What the Office Recorder shows: whether the bot is in the office, who is there, and the recording that is running, if any.
_Avoid_: state, office state
