import type { HandledRequest, Notice } from "./models";

export const outcomeNotice = (result: HandledRequest | null): Notice => {
  if (result === null)
    return { kind: "error", text: "The bot hasn't answered yet. Try again in a moment." };

  switch (result.outcome) {
    case "started":
      return { kind: "info", text: "Recording started." };
    case "stopped":
      return {
        kind: "info",
        text: "Recording stopped. The summary lands in Slack once it's transcribed.",
      };
    case "ignored":
      return { kind: "error", text: result.explanation };
  }
};

export const unreachableNotice = (reason: string): Notice => ({
  kind: "error",
  text: `Couldn't reach the bot: ${reason}`,
});
