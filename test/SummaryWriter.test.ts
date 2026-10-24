import { assert, describe, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";

import type { ClipLine, RecordingDetails } from "../src/RecordingStore.ts";
import { hasSpeech, MAX_SUMMARY_LENGTH, speakersOf, SummaryText, transcriptLines, transcriptText } from "../src/SummaryWriter.ts";

// 2026-10-23T08:00:00Z, a Friday, 10:00 in the office.
const start = DateTime.makeUnsafe("2026-10-23T08:00:00Z");

const at = (minutes: number) => DateTime.add(start, { minutes });

const details: RecordingDetails = {
  id: "rec",
  guildId: "g1",
  channelId: "c1",
  startedAt: start,
  stoppedAt: at(95),
  startedByName: "Ada",
  stopReason: "requested",
};

const line = (overrides: Partial<ClipLine> = {}): ClipLine => ({
  userId: "u1",
  who: "Ada",
  startedAt: at(1),
  durationMs: 2000,
  transcription: "done",
  transcript: "Hello everyone.",
  ...overrides,
});

const decode = Schema.decodeUnknownSync(SummaryText);

describe("transcriptLines", () => {
  it("writes one line per clip with the office time and who spoke", () => {
    const lines = transcriptLines([
      line(),
      line({ who: "Grace", startedAt: at(2), transcript: " Hi Ada. " }),
      line({ startedAt: at(3), transcription: "skipped", transcript: null }),
      line({ who: "Grace", startedAt: at(4), transcription: "failed", transcript: null }),
      line({ startedAt: at(5), transcription: "done", transcript: "   " }),
      line({ startedAt: at(6), transcription: "pending", transcript: null }),
    ]);

    assert.deepStrictEqual(lines, ["10:01 Ada: Hello everyone.", "10:02 Grace: Hi Ada.", "10:04 Grace: [couldn't be transcribed]"]);
  });
});

describe("transcriptText", () => {
  it("starts with when the recording was and who started it", () => {
    const text = transcriptText(details, [line()]);

    assert.deepStrictEqual(text.split("\n"), [
      "Office recording from Fri 23 Oct 10:00 to 11:35 (UTC+2), 1h 35m, started by Ada.",
      "",
      "10:01 Ada: Hello everyone.",
    ]);
  });
});

describe("speakersOf and hasSpeech", () => {
  it("names each person who was transcribed once, in order of first speaking", () => {
    const lines = [line({ who: "Grace" }), line(), line({ who: "Grace", startedAt: at(3) })];

    assert.deepStrictEqual(speakersOf(lines), ["Grace", "Ada"]);
    assert.isTrue(hasSpeech(lines));
  });

  it("counts a recording with only skipped clips as silent", () => {
    const lines = [line({ transcription: "skipped", transcript: null })];

    assert.deepStrictEqual(speakersOf(lines), []);
    assert.isFalse(hasSpeech(lines));
  });
});

describe("SummaryText", () => {
  it("trims the reply and strips wrapping quotes", () => {
    assert.strictEqual(decode('  "• Ada said hello"\n'), "• Ada said hello");
  });

  it("keeps line breaks between bullets", () => {
    assert.strictEqual(decode("• One\n• Two"), "• One\n• Two");
  });

  it("refuses angle brackets and over-long replies", () => {
    assert.throws(() => decode("• See <https://example.com>"));
    assert.throws(() => decode("•".repeat(MAX_SUMMARY_LENGTH + 1)));
    assert.throws(() => decode('""'));
  });
});
