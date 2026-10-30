import { describe, expect, it } from "vite-plus/test";

import { describePresence, samePresence } from "./describe-presence";
import type { RecordingStatus, RunningRecording } from "./models";

const idle: RecordingStatus = {
  botInOffice: true,
  occupants: [],
  recording: null,
  updatedAt: "2026-10-27T12:00:00Z",
};

const anna: RunningRecording = {
  id: "1",
  startedAt: "2026-10-27T12:00:00Z",
  startedByName: "Anna",
  endsAt: "2026-10-27T16:00:00Z",
};

const recording: RecordingStatus = { ...idle, recording: anna };

describe("describePresence", () => {
  it("names who started the recording and lets Discord count up from its start", () => {
    expect(describePresence(recording)).toEqual({
      details: "Recording the office",
      state: "Started by Anna",
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
      updatedAt: "2026-10-27T12:00:03Z",
    };

    expect(samePresence(describePresence(recording), describePresence(later))).toBe(true);
  });

  it("tells a different starter apart", () => {
    const other: RecordingStatus = {
      ...recording,
      recording: { ...anna, startedByName: "Ben" },
    };

    expect(samePresence(describePresence(recording), describePresence(other))).toBe(false);
  });

  it("tells a different phase apart", () => {
    expect(samePresence(describePresence(recording), describePresence(idle))).toBe(false);
  });
});
