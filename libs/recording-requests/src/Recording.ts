import { Schema } from "effect";

export const RecordingId = Schema.String.check(Schema.isUUID());

export const RecordingState = Schema.Literals(["running", "transcribing", "finished", "silent"]);

export type RecordingState = typeof RecordingState.Type;

export const StopReason = Schema.Literals([
  "requested",
  "office_emptied",
  "time_limit",
  "bot_restarted",
]);

export type StopReason = typeof StopReason.Type;

export const OfficeMember = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});

export type OfficeMember = typeof OfficeMember.Type;

export const ListedRecording = Schema.Struct({
  id: Schema.String,
  state: RecordingState,
  startedAt: Schema.DateTimeUtcFromString,
  stoppedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  startedBy: OfficeMember,
  speakers: Schema.Array(OfficeMember),
});

export type ListedRecording = typeof ListedRecording.Type;

export const RecordingPage = Schema.Struct({
  recordings: Schema.Array(ListedRecording),
  older: Schema.NullOr(Schema.DateTimeUtcFromString),
});

export type RecordingPage = typeof RecordingPage.Type;

export const TranscribedClip = Schema.Struct({
  speaker: OfficeMember,
  startedAt: Schema.DateTimeUtcFromString,
  text: Schema.String,
});

export type TranscribedClip = typeof TranscribedClip.Type;

export const RecordingDetail = Schema.Struct({
  ...ListedRecording.fields,
  stopReason: Schema.NullOr(StopReason),
  stoppedBy: Schema.NullOr(OfficeMember),
  summary: Schema.NullOr(Schema.String),
  summaryModel: Schema.NullOr(Schema.String),
  slackPermalink: Schema.NullOr(Schema.String),
  clips: Schema.Array(TranscribedClip),
});

export type RecordingDetail = typeof RecordingDetail.Type;

export interface RecordingProgress {
  readonly stopped: boolean;
  readonly finished: boolean;
  readonly posted: boolean;
}

export const stateOf = (progress: RecordingProgress): RecordingState => {
  if (!progress.stopped) return "running";

  if (!progress.finished) return "transcribing";

  return progress.posted ? "finished" : "silent";
};
