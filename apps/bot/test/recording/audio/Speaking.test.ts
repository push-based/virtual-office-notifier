import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration } from "effect";

import {
  noVoices,
  SPEAKING_HOLD,
  speakingAt,
  startedSpeaking,
  stoppedSpeaking,
} from "../../../src/recording/audio/Speaking.ts";

const at = DateTime.makeUnsafe("2026-10-30T12:00:00Z");

const later = (duration: Duration.Input) => DateTime.addDuration(at, duration);

describe("Speaking", () => {
  it("counts someone as speaking from when they start", () => {
    const voices = startedSpeaking(noVoices, "u1");

    assert.deepStrictEqual(speakingAt(voices, at), new Set(["u1"]));
    assert.deepStrictEqual(speakingAt(voices, later("1 hour")), new Set(["u1"]));
  });

  it("keeps them speaking until the hold after they stop runs out", () => {
    const voices = stoppedSpeaking(startedSpeaking(noVoices, "u1"), "u1", at);

    assert.deepStrictEqual(speakingAt(voices, at), new Set(["u1"]));
    assert.deepStrictEqual(speakingAt(voices, later("1999 millis")), new Set(["u1"]));
    assert.deepStrictEqual(speakingAt(voices, later(SPEAKING_HOLD)), new Set());
  });

  it("treats a short pause as one stretch of speaking", () => {
    const paused = stoppedSpeaking(startedSpeaking(noVoices, "u1"), "u1", at);
    const resumed = startedSpeaking(paused, "u1");

    assert.deepStrictEqual(speakingAt(resumed, later("10 seconds")), new Set(["u1"]));
  });

  it("ignores someone stopping who was never heard starting", () => {
    assert.strictEqual(stoppedSpeaking(noVoices, "u1", at), noVoices);
  });

  it("tracks each speaker on their own", () => {
    const voices = stoppedSpeaking(
      startedSpeaking(startedSpeaking(noVoices, "u1"), "u2"),
      "u1",
      at,
    );

    assert.deepStrictEqual(speakingAt(voices, later("5 seconds")), new Set(["u2"]));
  });
});
