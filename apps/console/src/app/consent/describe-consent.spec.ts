import type { ConsentStatus } from "recording-requests/wire";
import { describe, expect, it } from "vite-plus/test";

import { describeConsent } from "./describe-consent";

const agreed: ConsentStatus = {
  standing: "agreed",
  since: "2026-11-06T08:42:00.000Z",
  pendingWithdrawal: null,
  pendingErasure: null,
  refusedErasure: null,
  admin: false,
};

const pending = {
  id: 9,
  requestedAt: "2026-11-08T12:00:00.000Z",
  dueAt: "2026-12-08T12:00:00.000Z",
  decision: null,
};

describe("describeConsent", () => {
  it("says when someone agreed, in office time, and lets them withdraw or ask for deletion", () => {
    expect(describeConsent(agreed)).toEqual({
      heading: "You agreed to being recorded",
      description: "You agreed on Fri 6 Nov, 10:42, UTC+2.",
      canWithdraw: true,
      canErase: true,
      canCancel: false,
      refusal: null,
    });
  });

  it("doesn't offer to withdraw again while a withdrawal is waiting for the bot", () => {
    const view = describeConsent({ ...agreed, pendingWithdrawal: 3 });

    expect(view.heading).toBe("Withdrawing your consent…");
    expect(view.canWithdraw).toBe(false);
    expect(view.canErase).toBe(false);
  });

  it("says nothing new is recorded once someone withdrew", () => {
    const view = describeConsent({ ...agreed, standing: "withdrawn" });

    expect(view.heading).toBe("You withdrew your consent");
    expect(view.description).toContain("Nothing new is recorded about you");
    expect(view.canWithdraw).toBe(false);
    expect(view.canErase).toBe(true);
  });

  it("says when the deletion will run, and lets them cancel until then", () => {
    const view = describeConsent({ ...agreed, pendingErasure: pending });

    expect(view.heading).toBe("Your data will be deleted on Tue 8 Dec, 14:00, UTC+2");
    expect(view.description).toContain("You asked on Sun 8 Nov, 14:00");
    expect(view.canCancel).toBe(true);
    expect(view.canWithdraw).toBe(false);
    expect(view.canErase).toBe(false);
  });

  it("follows the admins' decision while the bot carries it out", () => {
    expect(
      describeConsent({ ...agreed, pendingErasure: { ...pending, decision: "now" } }).heading,
    ).toBe("Deleting your data…");
    expect(
      describeConsent({ ...agreed, pendingErasure: { ...pending, decision: "refused" } }).heading,
    ).toBe("Your deletion request was refused");
    expect(
      describeConsent({ ...agreed, pendingErasure: { ...pending, decision: "cancelled" } })
        .canCancel,
    ).toBe(false);
  });

  it("carries a refusal so the person can read why", () => {
    const refusal = {
      id: 9,
      refusedAt: "2026-11-09T09:00:00.000Z",
      ground: "legal_claim" as const,
      reason: "Evidence in the supplier dispute.",
    };

    const view = describeConsent({ ...agreed, standing: "withdrawn", refusedErasure: refusal });

    expect(view.refusal).toEqual(refusal);
    expect(view.canErase).toBe(true);
  });
});
