import { DateTime, Option, Schema } from "effect";

import { CONSENT_NOTICE_VERSION } from "./Wire.ts";

export const ConsentEventKind = Schema.Literals([
  "asked",
  "agreed",
  "declined",
  "timed_out",
  "left",
  "disconnected",
  "withdrawn",
]);

export type ConsentEventKind = typeof ConsentEventKind.Type;

export const Wording = Schema.Literals(["first", "again"]);

export type Wording = typeof Wording.Type;

export const Delivery = Schema.Literals(["direct_message", "voice_chat", "undelivered"]);

export type Delivery = typeof Delivery.Type;

export const ConsentStanding = Schema.Literals(["agreed", "withdrawn", "not_agreed"]);

export type ConsentStanding = typeof ConsentStanding.Type;

export const WithdrawalOutcome = Schema.Literals(["withdrawn", "ignored"]);

export type WithdrawalOutcome = typeof WithdrawalOutcome.Type;

export const SubmittedWithdrawal = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.NullOr(WithdrawalOutcome),
});

export type SubmittedWithdrawal = typeof SubmittedWithdrawal.Type;

export const ErasureOutcome = Schema.Literals(["erased", "refused", "cancelled"]);

export type ErasureOutcome = typeof ErasureOutcome.Type;

export const ErasureDecision = Schema.Literals(["now", "refused", "cancelled"]);

export type ErasureDecision = typeof ErasureDecision.Type;

export const RefusalGround = Schema.Literals(["legal_obligation", "legal_claim"]);

export type RefusalGround = typeof RefusalGround.Type;

export const SubmittedErasure = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.NullOr(ErasureOutcome),
  dueAt: Schema.DateTimeUtcFromString,
});

export type SubmittedErasure = typeof SubmittedErasure.Type;

export const PendingErasure = Schema.Struct({
  id: Schema.Finite,
  requestedAt: Schema.DateTimeUtcFromString,
  dueAt: Schema.DateTimeUtcFromString,
  decision: Schema.NullOr(ErasureDecision),
});

export type PendingErasure = typeof PendingErasure.Type;

export const Refusal = Schema.Struct({
  id: Schema.Finite,
  refusedAt: Schema.DateTimeUtcFromString,
  ground: RefusalGround,
  reason: Schema.String,
});

export type Refusal = typeof Refusal.Type;

export const ConsentStatus = Schema.Struct({
  standing: ConsentStanding,
  since: Schema.NullOr(Schema.DateTimeUtcFromString),
  pendingWithdrawal: Schema.NullOr(Schema.Finite),
  pendingErasure: Schema.NullOr(PendingErasure),
  refusedErasure: Schema.NullOr(Refusal),
  admin: Schema.Boolean,
});

export type ConsentStatus = typeof ConsentStatus.Type;

export const ErasureInventory = Schema.Struct({
  voiceActivity: Schema.Int,
  soundsAndEmoji: Schema.Int,
  slackMessages: Schema.Int,
  slackReactions: Schema.Int,
  clips: Schema.Int,
  audioFiles: Schema.Int,
  recordingsSpokenIn: Schema.Int,
  recordingsStartedStoppedOrPaused: Schema.Int,
  recordingRequests: Schema.Int,
  recordingEdits: Schema.Int,
  actionItemsOwned: Schema.Int,
  names: Schema.Array(Schema.String),
  linesMentioningThem: Schema.Int,
  recordingTextsMentioningThem: Schema.Int,
  slackPostsMentioningThem: Schema.Int,
  slackMessagesMentioningThem: Schema.Int,
});

export type ErasureInventory = typeof ErasureInventory.Type;

export const ErasureRefusal = Schema.Struct({
  ground: RefusalGround,
  reason: Schema.NonEmptyString,
});

export type ErasureRefusal = typeof ErasureRefusal.Type;

export const ErasureCase = Schema.Struct({
  id: Schema.Finite,
  userId: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  requestedAt: Schema.DateTimeUtcFromString,
  dueAt: Schema.DateTimeUtcFromString,
  decision: Schema.NullOr(ErasureDecision),
  decidedBy: Schema.NullOr(Schema.String),
  decidedByName: Schema.NullOr(Schema.String),
  refusal: Schema.NullOr(ErasureRefusal),
  seenBy: Schema.Array(Schema.String),
  seenByNames: Schema.Array(Schema.NullOr(Schema.String)),
  inventory: ErasureInventory,
});

export type ErasureCase = typeof ErasureCase.Type;

export const Decisive = Schema.Struct({
  kind: Schema.Literals(["agreed", "withdrawn"]),
  noticeVersion: Schema.Finite,
  happenedAt: Schema.DateTimeUtcFromDate,
});

export type Decisive = typeof Decisive.Type;

export interface Standing {
  readonly standing: ConsentStanding;
  readonly since: Option.Option<DateTime.Utc>;
}

export const NOT_AGREED: Standing = { standing: "not_agreed", since: Option.none() };

export const standingOf = (latest: Option.Option<Decisive>): Standing =>
  Option.match(latest, {
    onNone: () => NOT_AGREED,
    onSome: ({ kind, noticeVersion, happenedAt }) =>
      kind === "withdrawn"
        ? { standing: "withdrawn", since: Option.some(happenedAt) }
        : noticeVersion === CONSENT_NOTICE_VERSION
          ? { standing: "agreed", since: Option.some(happenedAt) }
          : NOT_AGREED,
  });
