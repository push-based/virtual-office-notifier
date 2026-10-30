import { identity, pipe, Schema, SchemaTransformation, String } from "effect";

import { AGENDA_MAX_LENGTH, TITLE_MAX_LENGTH } from "./Wire.ts";

export const RecordingId = Schema.String.check(Schema.isUUID());

const blankAsNull = (text: string): string | null => (text === "" ? null : text);

const optionalText = (maxLength: number, tidy: (text: string) => string) =>
  Schema.NullOr(Schema.String).pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.String.check(Schema.isMaxLength(maxLength))),
      SchemaTransformation.transform({
        decode: (text) => (text === null ? null : blankAsNull(tidy(text))),
        encode: identity,
      }),
    ),
  );

export const Title = optionalText(TITLE_MAX_LENGTH, (text) =>
  pipe(text, String.replace(/\s+/g, " "), String.trim),
);

export type Title = typeof Title.Type;

export const Agenda = optionalText(AGENDA_MAX_LENGTH, String.trim);

export type Agenda = typeof Agenda.Type;

export interface RecordingPlan {
  readonly title: string | null;
  readonly agenda: string | null;
}

export const NO_PLAN: RecordingPlan = { title: null, agenda: null };

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
  title: Schema.NullOr(Schema.String),
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

export const ActionItem = Schema.Struct({
  id: Schema.Finite,
  text: Schema.String,
  owner: Schema.NullOr(OfficeMember),
  done: Schema.Boolean,
});

export type ActionItem = typeof ActionItem.Type;

export const RecordingDetail = Schema.Struct({
  ...ListedRecording.fields,
  agenda: Schema.NullOr(Schema.String),
  stopReason: Schema.NullOr(StopReason),
  stoppedBy: Schema.NullOr(OfficeMember),
  summary: Schema.NullOr(Schema.String),
  summaryModel: Schema.NullOr(Schema.String),
  slackPermalink: Schema.NullOr(Schema.String),
  clips: Schema.Array(TranscribedClip),
  actionItems: Schema.NullOr(Schema.Array(ActionItem)),
  members: Schema.Array(OfficeMember),
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
