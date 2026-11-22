import { DateTime, Schema } from "effect";

import type { RecordingStatus } from "office-domain/RecordingRequest";

export const Presence = Schema.Struct({
  details: Schema.String,
  state: Schema.NullOr(Schema.String),
  timestamps: Schema.NullOr(Schema.Struct({ start: Schema.Finite })),
});

export type Presence = typeof Presence.Type;

export const describePresence = (status: RecordingStatus): Presence => {
  const { recording } = status;

  if (recording !== null)
    return recording.pause === null
      ? {
          details: "Recording the office",
          state: `Started by ${recording.startedByName}`,
          timestamps: { start: DateTime.toEpochMillis(recording.startedAt) },
        }
      : {
          details: "Recording paused",
          state: `Paused by ${recording.pause.byName}`,
          timestamps: { start: DateTime.toEpochMillis(recording.startedAt) },
        };

  return status.botInOffice
    ? { details: "In the office", state: "Not recording", timestamps: null }
    : { details: "Office is empty", state: null, timestamps: null };
};

export const samePresence = (left: Presence, right: Presence): boolean =>
  left.details === right.details &&
  left.state === right.state &&
  left.timestamps?.start === right.timestamps?.start;
