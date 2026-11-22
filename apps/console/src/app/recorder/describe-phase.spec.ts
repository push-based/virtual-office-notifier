import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { describePhase } from "./describe-phase.ts";
import { chris } from "./fixtures.ts";

const now = Date.parse("2026-10-27T12:12:34Z");

const endingSoon = { ...chris, endsAt: DateTime.makeUnsafe("2026-10-27T12:59:34Z") };

describe("describePhase", () => {
  it("shows the running clock, who started it and the time left", () => {
    expect(describePhase({ kind: "recording", recording: endingSoon }, now)).toEqual({
      heading: "Recording · 00:12:34",
      description: "Started by Chris · 47m left",
      live: true,
    });
  });

  it("shows who paused and for how long instead of the clock, and keeps counting down", () => {
    const pause = { since: DateTime.makeUnsafe("2026-10-27T12:09:00Z"), byName: "Ben" };

    expect(
      describePhase({ kind: "paused", recording: { ...endingSoon, pause }, pause }, now),
    ).toEqual({
      heading: "Paused by Ben · 3m",
      description: "Started by Chris · 47m left",
      live: false,
    });
  });
});
