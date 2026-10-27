import { Data, DateTime, Duration, Option, Schema, SchemaTransformation } from "effect";

export const RECORDING_LIMIT = Duration.hours(4);

export const MIN_CLIP_DURATION = Duration.millis(500);

export const MAX_TRANSCRIPTION_ATTEMPTS = 10;

export const REQUEST_EXPIRY = Duration.minutes(1);

export const RowId = Schema.Union([
  Schema.Finite,
  Schema.FiniteFromString,
  Schema.BigInt.pipe(
    Schema.decodeTo(
      Schema.Finite,
      SchemaTransformation.transform({ decode: (id) => Number(id), encode: (id) => globalThis.BigInt(id) }),
    ),
  ),
]);

export const RequestAction = Schema.Literals(["start", "stop"]);

export type RequestAction = typeof RequestAction.Type;

export const RequestOutcome = Schema.Literals(["started", "stopped", "ignored"]);

export type RequestOutcome = typeof RequestOutcome.Type;

export const IgnoredReason = Schema.Literals(["expired", "not_in_office", "already_recording", "not_recording", "office_empty"]);

export type IgnoredReason = typeof IgnoredReason.Type;

export const StopReason = Schema.Literals(["requested", "office_emptied", "time_limit", "bot_restarted"]);

export type StopReason = typeof StopReason.Type;

export const TranscriptionStatus = Schema.Literals(["pending", "done", "skipped", "failed"]);

export type TranscriptionStatus = typeof TranscriptionStatus.Type;

export interface RecordingRequest {
  readonly id: number;
  readonly requestedAt: DateTime.Utc;
  readonly requestedBy: string;
  readonly requestedByName: string;
  readonly action: RequestAction;
}

export interface ActiveRecording {
  readonly id: string;
  readonly startedAt: DateTime.Utc;
  readonly startedBy: string;
}

export const endsAt = (recording: ActiveRecording): DateTime.Utc => DateTime.addDuration(recording.startedAt, RECORDING_LIMIT);

export const isOverLimit = (recording: ActiveRecording, now: DateTime.Utc): boolean =>
  DateTime.isGreaterThanOrEqualTo(now, endsAt(recording));

export type RequestDecision = Data.TaggedEnum<{
  Start: {};
  Stop: {};
  Ignore: { readonly reason: IgnoredReason };
}>;

export const RequestDecision = Data.taggedEnum<RequestDecision>();

export const decideRequest = (
  request: RecordingRequest,
  occupants: ReadonlySet<string>,
  active: Option.Option<ActiveRecording>,
  now: DateTime.Utc,
): RequestDecision => {
  if (DateTime.isGreaterThan(now, DateTime.addDuration(request.requestedAt, REQUEST_EXPIRY))) {
    return RequestDecision.Ignore({ reason: "expired" });
  }

  if (occupants.size === 0) return RequestDecision.Ignore({ reason: "office_empty" });

  if (!occupants.has(request.requestedBy)) return RequestDecision.Ignore({ reason: "not_in_office" });

  if (request.action === "start") {
    return Option.isSome(active) ? RequestDecision.Ignore({ reason: "already_recording" }) : RequestDecision.Start();
  }

  return Option.isSome(active) ? RequestDecision.Stop() : RequestDecision.Ignore({ reason: "not_recording" });
};

export const OccupantSchema = Schema.Struct({
  userId: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});

export type Occupant = typeof OccupantSchema.Type;

export const RecordingStatusSchema = Schema.Struct({
  botInOffice: Schema.Boolean,
  occupants: Schema.Array(OccupantSchema),
  recording: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      startedAt: Schema.String,
      startedByName: Schema.String,
      endsAt: Schema.String,
    }),
  ),
  updatedAt: Schema.String,
});

export type RecordingStatus = typeof RecordingStatusSchema.Type;

export const RecordingRequestBody = Schema.Struct({ action: RequestAction });

export const RequestResultSchema = Schema.Struct({
  id: Schema.Finite,
  handled: Schema.Boolean,
  outcome: Schema.NullOr(RequestOutcome),
  reason: Schema.NullOr(Schema.String),
  reasonText: Schema.NullOr(Schema.String),
});

export type RequestResult = typeof RequestResultSchema.Type;

export const SessionUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});

export type SessionUser = typeof SessionUser.Type;

export const TokenResponse = Schema.Struct({
  accessToken: Schema.String,
  session: Schema.String,
  user: SessionUser,
});

export type TokenResponse = typeof TokenResponse.Type;

export const ignoredReasonText = (reason: string): string => {
  switch (reason) {
    case "expired":
      return "The bot only saw that after a minute, so it ignored it. Press it again.";
    case "not_in_office":
      return "You need to be in the office voice channel to do that.";
    case "already_recording":
      return "Someone already started a recording.";
    case "not_recording":
      return "There's no recording to stop.";
    case "office_empty":
      return "The office is empty, so there's nothing to record.";
    default:
      return "The bot couldn't do that right now.";
  }
};
