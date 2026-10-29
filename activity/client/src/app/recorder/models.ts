import type { RunningRecording } from "recording-requests/wire";

import type { NoticeKind } from "../../design-system";

export type {
  HandledRequest,
  Occupant,
  RecordingStatus,
  RequestAction,
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
  | { readonly kind: "recording"; readonly recording: RunningRecording };
