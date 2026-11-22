import { DateTime } from "effect";
import type { ConsentStatus } from "office-domain/Consent";

export const agreed: ConsentStatus = {
  standing: "agreed",
  since: DateTime.makeUnsafe("2026-11-06T08:42:00.000Z"),
  pendingWithdrawal: null,
  pendingErasure: null,
  refusedErasure: null,
  admin: false,
};
