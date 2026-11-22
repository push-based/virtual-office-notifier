import { describe, expect, it } from "vite-plus/test";

import { outcomeNotice } from "./notices.ts";

describe("outcomeNotice", () => {
  it("passes on the bot's explanation for ignoring a request", () => {
    expect(
      outcomeNotice({
        id: 1,
        outcome: "ignored",
        reason: "already_recording",
        explanation: "Someone already started a recording.",
      }),
    ).toEqual({
      kind: "error",
      text: "Someone already started a recording.",
    });
  });

  it("reports a request the bot never answered as an error", () => {
    expect(outcomeNotice(null).kind).toBe("error");
  });
});
