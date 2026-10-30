import { Data, DateTime, Duration, Option, Schema, SchemaTransformation } from "effect";

import { CHECK_INTERVAL_MS, RECORDING_LIMIT_MS, REQUEST_EXPIRY_MS } from "./Wire.ts";

export const RECORDING_LIMIT = Duration.millis(RECORDING_LIMIT_MS);

export const REQUEST_EXPIRY = Duration.millis(REQUEST_EXPIRY_MS);

export const CHECK_INTERVAL = Duration.millis(CHECK_INTERVAL_MS);

export const RowId = Schema.Union([
  Schema.Finite,
  Schema.FiniteFromString,
  Schema.BigInt.pipe(
    Schema.decodeTo(
      Schema.Finite,
      SchemaTransformation.transform({
        decode: (id) => Number(id),
        encode: (id) => globalThis.BigInt(id),
      }),
    ),
  ),
]);

export const RequestAction = Schema.Literals(["start", "stop"]);

export type RequestAction = typeof RequestAction.Type;

export const RequestSubmission = Schema.Struct({ action: RequestAction });

export const RequestOutcome = Schema.Literals(["started", "stopped", "ignored"]);

export type RequestOutcome = typeof RequestOutcome.Type;

export const IgnoreReason = Schema.Literals([
  "expired",
  "not_in_office",
  "already_recording",
  "not_recording",
  "office_empty",
]);

export type IgnoreReason = typeof IgnoreReason.Type;

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

export const endsAt = (recording: ActiveRecording): DateTime.Utc =>
  DateTime.addDuration(recording.startedAt, RECORDING_LIMIT);

export const isOverLimit = (recording: ActiveRecording, now: DateTime.Utc): boolean =>
  DateTime.isGreaterThanOrEqualTo(now, endsAt(recording));

export type RequestDecision = Data.TaggedEnum<{
  Start: {};
  Stop: { readonly recording: ActiveRecording };
  Ignore: { readonly reason: IgnoreReason };
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

  if (!occupants.has(request.requestedBy))
    return RequestDecision.Ignore({ reason: "not_in_office" });

  if (request.action === "start") {
    return Option.isSome(active)
      ? RequestDecision.Ignore({ reason: "already_recording" })
      : RequestDecision.Start();
  }

  return Option.match(active, {
    onNone: () => RequestDecision.Ignore({ reason: "not_recording" }),
    onSome: (recording) => RequestDecision.Stop({ recording }),
  });
};

export const explain = (reason: IgnoreReason): string => {
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
  }
};

export const Occupant = Schema.Struct({
  userId: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});

export type Occupant = typeof Occupant.Type;

export const RunningRecording = Schema.Struct({
  id: Schema.String,
  startedAt: Schema.DateTimeUtcFromString,
  startedByName: Schema.String,
  endsAt: Schema.DateTimeUtcFromString,
});

export const RecordingStatus = Schema.Struct({
  botInOffice: Schema.Boolean,
  occupants: Schema.Array(Occupant),
  recording: Schema.NullOr(RunningRecording),
  updatedAt: Schema.DateTimeUtcFromString,
});

export type RecordingStatus = typeof RecordingStatus.Type;

export const PendingRequest = Schema.Struct({ id: Schema.Finite, outcome: Schema.Null });

export const StartedRequest = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.Literal("started"),
});

export const StoppedRequest = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.Literal("stopped"),
});

export const IgnoredRequest = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.Literal("ignored"),
  reason: IgnoreReason,
  explanation: Schema.String,
});

export const SubmittedRequest = Schema.Union([
  PendingRequest,
  StartedRequest,
  StoppedRequest,
  IgnoredRequest,
]);

export type SubmittedRequest = typeof SubmittedRequest.Type;
