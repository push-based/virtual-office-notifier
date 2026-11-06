import type { ConsentStatus } from "recording-requests/wire";

import { formatOfficeTime } from "../history/describe-recording";

export interface ConsentView {
  readonly heading: string;
  readonly description: string;
  readonly canWithdraw: boolean;
}

export const describeConsent = (status: ConsentStatus): ConsentView => {
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
