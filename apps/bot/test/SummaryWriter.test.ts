import { OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  pipe,
  Ref,
  Schema,
  Stream,
  String,
} from "effect";
import { LanguageModel, Model } from "effect/ai";

import type { ClipLine, PauseLine, RecordingDetails } from "../src/RecordingStore.ts";
import {
  DETAILED_OUTPUT_TOKENS,
  DetailedSummaryText,
  hasSpeech,
  MAX_SUMMARY_LENGTH,
  SLACK_SECTION_LIMIT,
  speakersOf,
  STYLE_BRIEFS,
  SummaryText,
  SummaryWriter,
  summaryRequest,
  transcriptLines,
  transcriptText,
} from "../src/SummaryWriter.ts";

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
  title: null,
  agenda: null,
  summaryStyle: "brief",
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

const decode = Schema.decodeUnknownEffect(SummaryText);

const decodeDetailed = Schema.decodeUnknownEffect(DetailedSummaryText);

interface ModelCall {
  readonly system: string;
  readonly maxOutputTokens: number | null;
}

const makeWriter = Effect.fnUntraced(function* (reply: string) {
  const calls = yield* Ref.make<ReadonlyArray<ModelCall>>([]);

  const model = Model.make(
    "test",
    "model-1",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          Effect.serviceOption(OpenAiLanguageModel.Config).pipe(
            Effect.flatMap((config) =>
              Ref.update(calls, (all) => [
                ...all,
                {
                  system: Array.findFirst(
                    options.prompt.content,
                    (message) => message.role === "system",
                  ).pipe(
                    Option.map((message) => (message.role === "system" ? message.content : "")),
                    Option.getOrElse(() => ""),
                  ),
                  maxOutputTokens: Option.getOrNull(
                    Option.flatMap(config, (found) =>
                      Option.fromUndefinedOr(found.max_output_tokens),
                    ),
                  ),
                },
              ]),
            ),
            Effect.as([{ type: "text" as const, text: reply }]),
          ),
        streamText: () => Stream.empty,
      }),
    ),
  );

  const writer = yield* Effect.service(SummaryWriter).pipe(
    Effect.provide(SummaryWriter.layerProviders([[model]])),
  );

  return { writer, calls: Ref.get(calls) };
});

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

    assert.deepStrictEqual(lines, [
      "10:01 Ada: Hello everyone.",
      "10:02 Grace: Hi Ada.",
      "10:04 Grace: [couldn't be transcribed]",
    ]);
  });
});

describe("transcriptText", () => {
  it("starts with when the recording was and who started it", () => {
    const text = transcriptText(details, [line()], []);

    assert.deepStrictEqual(String.split(text, "\n"), [
      "Office recording from Fri 23 Oct 10:00 to 11:35 (UTC+2), 1h 35m, started by Ada.",
      "",
      "10:01 Ada: Hello everyone.",
    ]);
  });

  it("leaves one line in place of each pause, saying when and who paused it", () => {
    const pause = (overrides: Partial<PauseLine> = {}): PauseLine => ({
      pausedAt: at(20),
      resumedAt: at(35),
      who: "Ben",
      ...overrides,
    });

    const text = transcriptText(
      details,
      [line(), line({ who: "Ben", startedAt: at(40), transcript: "We're back." })],
      [pause(), pause({ pausedAt: at(80), resumedAt: null, who: "Grace" })],
    );

    assert.deepStrictEqual(String.split(text, "\n"), [
      "Office recording from Fri 23 Oct 10:00 to 11:35 (UTC+2), 1h 35m, started by Ada.",
      "",
      "10:01 Ada: Hello everyone.",
      "10:20–10:35 Paused by Ben",
      "10:40 Ben: We're back.",
      "11:20–11:35 Paused by Grace",
    ]);
  });
});

describe("summaryRequest", () => {
  const transcript = transcriptText(details, [line()], []);

  it("is just the transcript when the recording has no title or agenda", () => {
    assert.strictEqual(summaryRequest(details, transcript), transcript);
  });

  it("puts the title and agenda above the transcript, marking the agenda as the plan", () => {
    assert.deepStrictEqual(
      String.split(
        summaryRequest(
          { ...details, title: "Deploy retro", agenda: "What broke\nWho fixes it" },
          transcript,
        ),
        "\n",
      ),
      [
        "Title: Deploy retro",
        "Agenda, what people meant to cover, not what happened:",
        "What broke",
        "Who fixes it",
        "",
        "Transcript:",
        "Office recording from Fri 23 Oct 10:00 to 11:35 (UTC+2), 1h 35m, started by Ada.",
        "",
        "10:01 Ada: Hello everyone.",
      ],
    );
  });

  it("gives only what's there", () => {
    assert.deepStrictEqual(
      Array.take(
        String.split(summaryRequest({ ...details, agenda: "Friday" }, transcript), "\n"),
        4,
      ),
      ["Agenda, what people meant to cover, not what happened:", "Friday", "", "Transcript:"],
    );
    assert.deepStrictEqual(
      Array.take(String.split(summaryRequest({ ...details, title: "Retro" }, transcript), "\n"), 3),
      ["Title: Retro", "", "Transcript:"],
    );
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

describe("SummaryWriter", () => {
  it.effect("writes each style with its own instructions, and says which style it wrote", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeWriter("• Shipped it");

      for (const style of ["brief", "detailed", "decisions"] as const) {
        assert.deepStrictEqual(
          yield* writer.write("transcript", style),
          Option.some({ text: "• Shipped it", model: "model-1", style }),
        );
      }

      const [brief, detailed, decisions] = yield* calls;

      assert.include(brief?.system ?? "", "what was discussed and any decisions");
      assert.include(brief?.system ?? "", "under 1,200 characters");
      assert.include(detailed?.system ?? "", "grouped by topic");
      assert.include(detailed?.system ?? "", "under 2,800 characters");
      assert.include(decisions?.system ?? "", "Write only what was decided");
      assert.include(decisions?.system ?? "", "under 1,200 characters");

      for (const call of [brief, detailed, decisions])
        assert.include(call?.system ?? "", "The agenda is what people meant to cover");
    }),
  );

  it.effect("gives a Detailed summary room to answer, and the others the usual budget", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeWriter("• Shipped it");

      yield* writer.write("transcript", "brief");
      yield* writer.write("transcript", "detailed");
      yield* writer.write("transcript", "decisions");

      assert.deepStrictEqual(
        Array.map(yield* calls, ({ maxOutputTokens }) => maxOutputTokens),
        [null, DETAILED_OUTPUT_TOKENS, null],
      );
    }),
  );

  it.effect("checks each style's length: a Detailed summary may be longer than a Brief one", () =>
    Effect.gen(function* () {
      const long = pipe("•", String.repeat(MAX_SUMMARY_LENGTH + 1));
      const { writer } = yield* makeWriter(long);

      assert.deepStrictEqual(yield* writer.write("transcript", "brief"), Option.none());
      assert.deepStrictEqual(yield* writer.write("transcript", "decisions"), Option.none());
      assert.deepStrictEqual(
        Option.map(yield* writer.write("transcript", "detailed"), ({ text }) => text),
        Option.some(long),
      );
    }),
  );
});

describe("DetailedSummaryText", () => {
  it.effect("takes a summary that fits one Slack section once it's escaped", () =>
    Effect.gen(function* () {
      const fits = pipe("•", String.repeat(SLACK_SECTION_LIMIT));

      assert.strictEqual(yield* decodeDetailed(fits), fits);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeDetailed(`${fits}•`))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            decodeDetailed(`${pipe("•", String.repeat(SLACK_SECTION_LIMIT - 4))}&`),
          ),
        ),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeDetailed("• See <https://x.y>"))));
    }),
  );
});

describe("SummaryText", () => {
  it.effect("trims the reply and strips wrapping quotes", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decode('  "• Ada said hello"\n'), "• Ada said hello");
    }),
  );

  it.effect("keeps line breaks between bullets", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decode("• One\n• Two"), "• One\n• Two");
    }),
  );

  it.effect("refuses angle brackets and over-long replies", () =>
    Effect.gen(function* () {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decode("• See <https://example.com>"))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(decode(pipe("•", String.repeat(MAX_SUMMARY_LENGTH + 1)))),
        ),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decode('""'))));
    }),
  );
});

describe("STYLE_BRIEFS", () => {
  it("leaves the action items out of every style, since they're pulled out on their own", () => {
    for (const { prompt } of [STYLE_BRIEFS.brief, STYLE_BRIEFS.detailed, STYLE_BRIEFS.decisions]) {
      assert.include(prompt, "the action items, which are listed separately");
      assert.notInclude(prompt, "any action items");
      assert.notInclude(prompt, "who took what on");
    }
  });
});
