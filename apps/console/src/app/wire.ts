import * as SignIn from "activity-sign-in/SignInApi";
import { Schema } from "effect";
import * as Consent from "recording-requests/Consent";
import * as Stats from "recording-requests/OfficeStats";
import * as History from "recording-requests/Recording";
import * as Edits from "recording-requests/RecordingEdit";
import * as Requests from "recording-requests/RecordingRequest";

export * from "recording-requests/wire";

export const RequestAction = Schema.toEncoded(Requests.RequestAction);

export type RequestAction = typeof RequestAction.Type;

export const RequestSubmission = Schema.toEncoded(Requests.RequestSubmission);

export type RequestSubmission = typeof RequestSubmission.Type;

export const RecordingStatus = Schema.toEncoded(Requests.RecordingStatus);

export type RecordingStatus = typeof RecordingStatus.Type;

export const SubmittedRequest = Schema.toEncoded(Requests.SubmittedRequest);

export type SubmittedRequest = typeof SubmittedRequest.Type;

export const HandledRequest = Schema.toEncoded(
  Schema.Union([
    Requests.StartedRequest,
    Requests.StoppedRequest,
    Requests.PausedRequest,
    Requests.ResumedRequest,
    Requests.IgnoredRequest,
  ]),
);

export type HandledRequest = typeof HandledRequest.Type;

export const OfficeMember = Schema.toEncoded(History.OfficeMember);

export type OfficeMember = typeof OfficeMember.Type;

export const ListedRecording = Schema.toEncoded(History.ListedRecording);

export type ListedRecording = typeof ListedRecording.Type;

export const RecordingPage = Schema.toEncoded(History.RecordingPage);

export type RecordingPage = typeof RecordingPage.Type;

export const RecordingDetail = Schema.toEncoded(History.RecordingDetail);

export type RecordingDetail = typeof RecordingDetail.Type;

export const ActionItem = Schema.toEncoded(History.ActionItem);

export type ActionItem = typeof ActionItem.Type;

export const SummaryStyle = Schema.toEncoded(History.SummaryStyle);

export type SummaryStyle = typeof SummaryStyle.Type;

export const RecordingChange = Schema.toEncoded(Edits.RecordingChange);

export type RecordingChange = typeof RecordingChange.Type;

export const SubmittedEdit = Schema.toEncoded(Edits.SubmittedEdit);

export type SubmittedEdit = typeof SubmittedEdit.Type;

export const HandledEdit = Schema.toEncoded(Schema.Union([Edits.AppliedEdit, Edits.IgnoredEdit]));

export type HandledEdit = typeof HandledEdit.Type;

export const StatsRange = Schema.toEncoded(Stats.StatsRange);

export type StatsRange = typeof StatsRange.Type;

export const OfficeStats = Schema.toEncoded(Stats.OfficeStats);

export type OfficeStats = typeof OfficeStats.Type;

export const ConsentStatus = Schema.toEncoded(Consent.ConsentStatus);

export type ConsentStatus = typeof ConsentStatus.Type;

export const SubmittedWithdrawal = Schema.toEncoded(Consent.SubmittedWithdrawal);

export type SubmittedWithdrawal = typeof SubmittedWithdrawal.Type;

export const SubmittedErasure = Schema.toEncoded(Consent.SubmittedErasure);

export type SubmittedErasure = typeof SubmittedErasure.Type;

export const ErasureCase = Schema.toEncoded(Consent.ErasureCase);

export type ErasureCase = typeof ErasureCase.Type;

export const ErasureCases = Schema.Array(ErasureCase);

export type ErasureCases = typeof ErasureCases.Type;

export const ErasureRefusal = Schema.toEncoded(Consent.ErasureRefusal);

export type ErasureRefusal = typeof ErasureRefusal.Type;

export const RefusalGround = Schema.toEncoded(Consent.RefusalGround);

export type RefusalGround = typeof RefusalGround.Type;

export const SignInConfig = Schema.toEncoded(SignIn.SignInConfig);

export type SignInConfig = typeof SignInConfig.Type;

export const SignInCode = Schema.toEncoded(SignIn.SignInCode);

export type SignInCode = typeof SignInCode.Type;

export const SignedInSession = Schema.toEncoded(SignIn.SignedInSession);

export type SignedInSession = typeof SignedInSession.Type;
