import type { NoticeKind } from "design-system";
import type { RecordingPause, RunningRecording } from "recording-requests/wire";

export type {
  HandledRequest,
  Occupant,
  RecordingPause,
  RecordingStatus,
  RequestAction,
  RequestSubmission,
  RunningRecording,
  SubmittedRequest,
} from "recording-requests/wire";

export interface Notice {
  readonly kind: NoticeKind;
  readonly text: string;
}

export type OfficePhase =
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "connecting" }
  | { readonly kind: "away" }
  | { readonly kind: "idle" }
  | { readonly kind: "recording"; readonly recording: RunningRecording }
  | {
      readonly kind: "paused";
      readonly recording: RunningRecording;
      readonly pause: RecordingPause;
    };
