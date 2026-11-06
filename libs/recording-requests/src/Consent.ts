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

export const ErasureOutcome = Schema.Literal("erased");

export type ErasureOutcome = typeof ErasureOutcome.Type;

export const SubmittedErasure = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.NullOr(ErasureOutcome),
});

export type SubmittedErasure = typeof SubmittedErasure.Type;

export const ConsentStatus = Schema.Struct({
  standing: ConsentStanding,
  since: Schema.NullOr(Schema.DateTimeUtcFromString),
  pendingWithdrawal: Schema.NullOr(Schema.Finite),
  pendingErasure: Schema.NullOr(Schema.Finite),
});

export type ConsentStatus = typeof ConsentStatus.Type;

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
