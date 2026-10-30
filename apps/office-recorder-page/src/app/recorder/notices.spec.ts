import { describe, expect, it } from "vite-plus/test";

import { outcomeNotice, unreachableNotice } from "./notices";

describe("outcomeNotice", () => {
  it("confirms a started recording", () => {
    expect(outcomeNotice({ id: 1, outcome: "started" })).toEqual({
      kind: "info",
      text: "Recording started.",
    });
  });

  it("says where the summary goes once stopped", () => {
    expect(outcomeNotice({ id: 1, outcome: "stopped" }).kind).toBe("info");
  });

  it("passes on the bot's explanation for ignoring a request", () => {
    expect(
      outcomeNotice({ id: 1, outcome: "ignored", reason: "already_recording", explanation: "Someone already started a recording." }),
    ).toEqual({
      kind: "error",
      text: "Someone already started a recording.",
    });
  });

  it("reports a request the bot never answered", () => {
    expect(outcomeNotice(null).kind).toBe("error");
  });
});

describe("unreachableNotice", () => {
  it("includes the reason", () => {
    expect(unreachableNotice("/api/status answered 500")).toEqual({
      kind: "error",
      text: "Couldn't reach the bot: /api/status answered 500",
    });
  });
});
