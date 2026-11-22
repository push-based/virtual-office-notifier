import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { RecordingStatus } from "office-domain/RecordingRequest";
import { describePresence, samePresence } from "./describe-presence.ts";
import { chris, idle, paused, recording } from "./fixtures.ts";

describe("describePresence", () => {
  it("names who started the recording and lets Discord count up from its start", () => {
    expect(describePresence(recording)).toEqual({
      details: "Recording the office",
      state: "Started by Chris",
      timestamps: { start: Date.parse("2026-10-27T12:00:00Z") },
    });
  });

  it("says who paused the recording while it's paused", () => {
    expect(describePresence(paused)).toEqual({
      details: "Recording paused",
      state: "Paused by Ben",
      timestamps: { start: Date.parse("2026-10-27T12:00:00Z") },
    });
  });

  it("says nothing is recording while the bot is in the office", () => {
    expect(describePresence(idle)).toEqual({
      details: "In the office",
      state: "Not recording",
      timestamps: null,
    });
  });

  it("says the office is empty while the bot is away", () => {
    expect(describePresence({ ...idle, botInOffice: false })).toEqual({
      details: "Office is empty",
      state: null,
      timestamps: null,
    });
  });
});

describe("samePresence", () => {
  it("ignores who is in the office and when the status was written", () => {
    const later: RecordingStatus = {
      ...recording,
      occupants: [{ userId: "2", displayName: "Ben", avatarUrl: null, speaking: true }],
      updatedAt: DateTime.makeUnsafe("2026-10-27T12:00:03Z"),
    };

    expect(samePresence(describePresence(recording), describePresence(later))).toBe(true);
  });

  it("tells a different starter apart", () => {
    const other: RecordingStatus = {
      ...recording,
      recording: { ...chris, startedByName: "Ben" },
    };

    expect(samePresence(describePresence(recording), describePresence(other))).toBe(false);
  });

  it("tells a different phase apart", () => {
    expect(samePresence(describePresence(recording), describePresence(idle))).toBe(false);
  });

  it("tells a pause apart from the recording running", () => {
    expect(samePresence(describePresence(recording), describePresence(paused))).toBe(false);
  });
});
