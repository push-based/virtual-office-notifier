export type RequestAction = "start" | "stop";

export type IgnoreReason =
  | "expired"
  | "not_in_office"
  | "already_recording"
  | "not_recording"
  | "office_empty";

export interface Occupant {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface RunningRecording {
  readonly id: string;
  readonly startedAt: string;
  readonly startedByName: string;
  readonly endsAt: string;
}

export interface RecordingStatus {
  readonly botInOffice: boolean;
  readonly occupants: ReadonlyArray<Occupant>;
  readonly recording: RunningRecording | null;
  readonly updatedAt: string;
}

export interface PendingRequest {
  readonly id: number;
  readonly outcome: null;
}

export interface StartedRequest {
  readonly id: number;
  readonly outcome: "started";
}

export interface StoppedRequest {
  readonly id: number;
  readonly outcome: "stopped";
}

export interface IgnoredRequest {
  readonly id: number;
  readonly outcome: "ignored";
  readonly reason: IgnoreReason;
  readonly explanation: string;
}

export type HandledRequest = StartedRequest | StoppedRequest | IgnoredRequest;

export type SubmittedRequest = PendingRequest | HandledRequest;

export const REQUEST_EXPIRY_MS = 60_000;

export const CHECK_INTERVAL_MS = 2_000;

export const ANSWER_WINDOW_MS = REQUEST_EXPIRY_MS + 2 * CHECK_INTERVAL_MS;

export const RECORDING_LIMIT_MS = 4 * 60 * 60 * 1000;
