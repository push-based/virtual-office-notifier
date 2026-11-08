import type { ConsentStatus, Refusal } from "recording-requests/wire";

import { formatOfficeTime } from "../history/describe-recording";

export interface ConsentView {
  readonly heading: string;
  readonly description: string;
  readonly canWithdraw: boolean;
  readonly canErase: boolean;
  readonly canCancel: boolean;
  readonly refusal: Refusal | null;
}

const standingOf = (
  status: ConsentStatus,
): Pick<ConsentView, "heading" | "description" | "canWithdraw"> => {
  if (status.pendingWithdrawal !== null)
    return {
      heading: "Withdrawing your consent…",
      description:
        "The bot is on it. It'll show you out of the office if you're in, and send you a DM.",
      canWithdraw: false,
    };

  switch (status.standing) {
    case "agreed":
      return {
        heading: "You agreed to being recorded",
        description:
          status.since === null
            ? "You agreed when you joined the office."
            : `You agreed on ${formatOfficeTime(status.since)}, UTC+2.`,
        canWithdraw: true,
      };
    case "withdrawn":
      return {
        heading: "You withdrew your consent",
        description:
          status.since === null
            ? "Nothing new is recorded about you. You'll be asked again if you join the office."
            : `You withdrew it on ${formatOfficeTime(status.since)}, UTC+2. Nothing new is recorded about you, and you'll be asked again if you join the office.`,
        canWithdraw: false,
      };
    case "not_agreed":
      return {
        heading: "You haven't agreed yet",
        description:
          "The bot asks everyone who joins the office. Until you agree, nothing is recorded about you.",
        canWithdraw: false,
      };
  }
};

const erasureOf = (
  status: ConsentStatus,
): Pick<ConsentView, "heading" | "description" | "canCancel"> | null => {
  const pending = status.pendingErasure;

  if (pending === null) return null;

  switch (pending.decision) {
    case null:
      return {
        heading: `Your data will be deleted on ${formatOfficeTime(pending.dueAt)}, UTC+2`,
        description: `You asked on ${formatOfficeTime(pending.requestedAt)}. Your consent is withdrawn and nothing new is recorded about you. Until then the office admins check whether anything has to be kept by law: if they decide to keep it, you'll be told why, and if they decide sooner, it's deleted sooner. Coming back to the office and agreeing to being recorded cancels the request.`,
        canCancel: true,
      };
    case "now":
      return {
        heading: "Deleting your data…",
        description:
          "An admin asked for it to run now. Taking your name out of the recordings and the Slack posts can take a few minutes, and the bot will send you a DM when it's done.",
        canCancel: false,
      };
    case "refused":
      return {
        heading: "Your deletion request was refused",
        description: "The bot is sending you the admins' reason as a DM.",
        canCancel: false,
      };
    case "cancelled":
      return {
        heading: "Cancelling your deletion request…",
        description: "The bot is on it. Nothing was deleted.",
        canCancel: false,
      };
  }
};

export const describeConsent = (status: ConsentStatus): ConsentView => {
  const erasure = erasureOf(status);

  if (erasure !== null) return { ...erasure, canWithdraw: false, canErase: false, refusal: null };

  return {
    ...standingOf(status),
    canErase: status.pendingWithdrawal === null,
    canCancel: false,
    refusal: status.refusedErasure,
  };
};
