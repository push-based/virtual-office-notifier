import { describe, expect, it } from "vite-plus/test";

import { describeConsent } from "./describe-consent";

describe("describeConsent", () => {
  it("says when someone agreed, in office time, and lets them withdraw", () => {
    expect(
      describeConsent({
        standing: "agreed",
        since: "2026-11-06T08:42:00.000Z",
        pendingWithdrawal: null,
        pendingErasure: null,
      }),
    ).toEqual({
      heading: "You agreed to being recorded",
      description: "You agreed on Fri 6 Nov, 10:42, UTC+2.",
      canWithdraw: true,
      canErase: true,
    });
  });

  it("doesn't offer to withdraw again while a withdrawal is waiting for the bot", () => {
    const view = describeConsent({
      standing: "agreed",
      since: "2026-11-06T08:42:00.000Z",
      pendingWithdrawal: 3,
      pendingErasure: null,
    });

    expect(view.heading).toBe("Withdrawing your consent…");
    expect(view.canWithdraw).toBe(false);
    expect(view.canErase).toBe(false);
  });

  it("says nothing new is recorded once someone withdrew", () => {
    const view = describeConsent({
      standing: "withdrawn",
      since: "2026-11-06T08:42:00.000Z",
      pendingWithdrawal: null,
      pendingErasure: null,
    });

    expect(view.description).toContain("Nothing new is recorded about you");
    expect(view.canWithdraw).toBe(false);
  });

  it("explains the bot asks on joining when someone hasn't agreed", () => {
    expect(
      describeConsent({
        standing: "not_agreed",
        since: null,
        pendingWithdrawal: null,
        pendingErasure: null,
      }),
    ).toEqual({
      heading: "You haven't agreed yet",
      description:
        "The bot asks everyone who joins the office. Until you agree, nothing is recorded about you.",
      canWithdraw: false,
      canErase: true,
    });
  });

  it("offers nothing while the bot is deleting someone's data", () => {
    const view = describeConsent({
      standing: "agreed",
      since: "2026-11-06T08:42:00.000Z",
      pendingWithdrawal: null,
      pendingErasure: 4,
    });

    expect(view.heading).toBe("Deleting your data…");
    expect(view.canWithdraw).toBe(false);
    expect(view.canErase).toBe(false);
  });

  it("lets anyone delete their data, even without having agreed", () => {
    expect(
      describeConsent({
        standing: "not_agreed",
        since: null,
        pendingWithdrawal: null,
        pendingErasure: null,
      }).canErase,
    ).toBe(true);
  });
});
