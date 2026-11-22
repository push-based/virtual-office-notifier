import { DateTime } from "effect";
import type { RecordingStatus, RunningRecording } from "office-domain/RecordingRequest";

export const idle: RecordingStatus = {
  botInOffice: true,
  occupants: [{ userId: "u2", displayName: "Ben", avatarUrl: null, speaking: false }],
  recording: null,
  updatedAt: DateTime.makeUnsafe("2026-10-27T12:00:00Z"),
};

export const chris: RunningRecording = {
  id: "r1",
  startedAt: DateTime.makeUnsafe("2026-10-27T12:00:00Z"),
  startedByName: "Chris",
  endsAt: DateTime.makeUnsafe("2026-10-27T16:00:00Z"),
  pause: null,
  title: "Deploy retro",
  agenda: null,
  summaryStyle: "brief",
};

export const recording: RecordingStatus = { ...idle, recording: chris };

export const paused: RecordingStatus = {
  ...idle,
  recording: {
    ...chris,
    pause: { since: DateTime.makeUnsafe("2026-10-27T12:20:00Z"), byName: "Ben" },
  },
};
