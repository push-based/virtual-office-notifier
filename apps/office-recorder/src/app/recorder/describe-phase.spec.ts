import { describe, expect, it } from "vite-plus/test";

import { describePhase } from "./describe-phase";

const now = Date.parse("2026-10-27T12:12:34Z");

describe("describePhase", () => {
  it("explains a failed start", () => {
    expect(describePhase({ kind: "failed", reason: "/api/config answered 502" }, now)).toEqual({
      heading: "Couldn't start",
      description: "/api/config answered 502",
      live: false,
    });
  });

  it("asks for patience while connecting", () => {
    expect(describePhase({ kind: "connecting" }, now).heading).toBe("Connecting…");
  });

  it("explains why nothing can start while the bot is away", () => {
    expect(describePhase({ kind: "away" }, now)).toEqual({
      heading: "The bot isn't in the office yet",
      description: "It joins once someone is in the voice channel.",
      live: false,
    });
  });

  it("invites a start when idle", () => {
    expect(describePhase({ kind: "idle" }, now).heading).toBe("Not recording");
  });

  it("shows the running clock, who started it and the time left", () => {
    const recording = {
      id: "1",
      startedAt: "2026-10-27T12:00:00Z",
      startedByName: "Chris",
      endsAt: "2026-10-27T12:59:34Z",
      pause: null,
      title: null,
      agenda: null,
    };

    expect(describePhase({ kind: "recording", recording }, now)).toEqual({
      heading: "Recording · 00:12:34",
      description: "Started by Chris · 47m left",
      live: true,
    });
  });

  it("shows who paused and for how long instead of the clock, and keeps counting down", () => {
    const pause = { since: "2026-10-27T12:09:00Z", byName: "Ben" };

    const recording = {
      id: "1",
      startedAt: "2026-10-27T12:00:00Z",
      startedByName: "Chris",
      endsAt: "2026-10-27T12:59:34Z",
      pause,
      title: null,
      agenda: null,
    };

    expect(describePhase({ kind: "paused", recording, pause }, now)).toEqual({
      heading: "Paused by Ben · 3m",
      description: "Started by Chris · 47m left",
      live: false,
    });
  });
});
