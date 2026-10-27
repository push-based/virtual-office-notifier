import type { NoticeKind } from "../../design-system";

export interface Occupant {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface Recording {
  readonly id: string;
  readonly startedAt: string;
  readonly startedByName: string;
  readonly endsAt: string;
}

export interface RecordingStatus {
  readonly botInOffice: boolean;
  readonly occupants: ReadonlyArray<Occupant>;
  readonly recording: Recording | null;
}

export type RecordingAction = "start" | "stop";

export interface PendingRequest {
  readonly id: number;
  readonly handled: false;
}

export interface CompletedRequest {
  readonly id: number;
  readonly handled: true;
  readonly outcome: "started" | "stopped";
}

export interface IgnoredRequest {
  readonly id: number;
  readonly handled: true;
  readonly outcome: "ignored";
  readonly reasonText: string | null;
}

export type HandledRequest = CompletedRequest | IgnoredRequest;

export type RequestResult = PendingRequest | HandledRequest;

export interface Notice {
  readonly kind: NoticeKind;
  readonly text: string;
}

export type OfficePhase =
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "connecting" }
  | { readonly kind: "away" }
  | { readonly kind: "idle" }
  | { readonly kind: "recording"; readonly recording: Recording };
