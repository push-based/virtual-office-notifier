import type { RecordingStatus } from "./models";

export interface Presence {
  readonly details: string;
  readonly state: string | null;
  readonly timestamps: { readonly start: number } | null;
}

export const describePresence = (status: RecordingStatus): Presence => {
  if (status.recording !== null)
    return {
      details: "Recording the office",
      state: `Started by ${status.recording.startedByName}`,
      timestamps: { start: Date.parse(status.recording.startedAt) },
    };

  return status.botInOffice
    ? { details: "In the office", state: "Not recording", timestamps: null }
    : { details: "Office is empty", state: null, timestamps: null };
};

export const samePresence = (left: Presence, right: Presence): boolean =>
  left.details === right.details &&
  left.state === right.state &&
  left.timestamps?.start === right.timestamps?.start;
