import { describe, expect, it } from "vitest";

import { outcomeNotice, unreachableNotice } from "./notices";

describe("outcomeNotice", () => {
  it("confirms a started recording", () => {
    expect(outcomeNotice({ id: 1, handled: true, outcome: "started" })).toEqual({
      kind: "info",
      text: "Recording started.",
    });
  });

  it("says where the summary goes once stopped", () => {
    expect(outcomeNotice({ id: 1, handled: true, outcome: "stopped" }).kind).toBe("info");
  });

  it("passes on the bot's reason for ignoring a request", () => {
    expect(outcomeNotice({ id: 1, handled: true, outcome: "ignored", reasonText: "Already recording." })).toEqual({
      kind: "error",
      text: "Already recording.",
    });
  });

  it("falls back to a generic reason", () => {
    expect(outcomeNotice({ id: 1, handled: true, outcome: "ignored", reasonText: null }).text).toBe(
      "The bot couldn't do that right now.",
    );
  });

  it("reports a request the bot never answered", () => {
    expect(outcomeNotice(null).kind).toBe("error");
  });
});

describe("unreachableNotice", () => {
  it("includes the reason", () => {
    expect(unreachableNotice("/api/state answered 500")).toEqual({
      kind: "error",
      text: "Couldn't reach the bot: /api/state answered 500",
    });
  });
});
