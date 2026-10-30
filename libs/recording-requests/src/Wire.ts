import type * as SignIn from "activity-sign-in/SignInApi";

import type * as Stats from "./OfficeStats.ts";
import type * as Schemas from "./RecordingRequest.ts";

export type RequestAction = typeof Schemas.RequestAction.Encoded;

export type RequestSubmission = typeof Schemas.RequestSubmission.Encoded;

export type IgnoreReason = typeof Schemas.IgnoreReason.Encoded;

export type Occupant = typeof Schemas.Occupant.Encoded;

export type RunningRecording = typeof Schemas.RunningRecording.Encoded;

export type RecordingStatus = typeof Schemas.RecordingStatus.Encoded;

export type PendingRequest = typeof Schemas.PendingRequest.Encoded;

export type StartedRequest = typeof Schemas.StartedRequest.Encoded;

export type StoppedRequest = typeof Schemas.StoppedRequest.Encoded;

export type IgnoredRequest = typeof Schemas.IgnoredRequest.Encoded;

export type HandledRequest = StartedRequest | StoppedRequest | IgnoredRequest;

export type SubmittedRequest = typeof Schemas.SubmittedRequest.Encoded;

export type StatsRange = typeof Stats.StatsRange.Encoded;

export type OfficeStats = typeof Stats.OfficeStats.Encoded;

export type PersonTime = typeof Stats.PersonTime.Encoded;

export type PersonDays = typeof Stats.PersonDays.Encoded;

export type BusyHour = typeof Stats.BusyHour.Encoded;

export type SignInConfig = typeof SignIn.SignInConfig.Encoded;

export type SignInCode = typeof SignIn.SignInCode.Encoded;

export type SignedInSession = typeof SignIn.SignedInSession.Encoded;

export const REQUEST_EXPIRY_MS = 60_000;

export const CHECK_INTERVAL_MS = 2_000;

export const ANSWER_WINDOW_MS = REQUEST_EXPIRY_MS + 2 * CHECK_INTERVAL_MS;

export const RECORDING_LIMIT_MS = 4 * 60 * 60 * 1000;
