import { OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  DateTime,
  Effect,
  Option,
  pipe,
  Ref,
  Schema,
  SchemaTransformation,
  String,
} from "effect";
import { AiError } from "effect/ai";

import type { Member } from "../../src/recording/ActionItems.ts";
import type { ClipLine, RecordingDetails } from "../../src/recording/RecordingStore.ts";
import { RecordingWriter, type RecordingToWrite } from "../../src/recording/RecordingWriter.ts";
import { DETAILED_OUTPUT_TOKENS, MAX_SUMMARY_LENGTH } from "../../src/recording/SummaryWriter.ts";
import { captureReports, scriptedModel } from "../fakes.ts";

const start = DateTime.makeUnsafe("2026-10-23T08:00:00Z");

const at = (minutes: number) => DateTime.add(start, { minutes });

const details: RecordingDetails = {
  id: "rec",
  guildId: "g1",
  channelId: "c1",
  startedAt: start,
  stoppedAt: at(30),
  startedByName: "Ada",
  stopReason: "requested",
  title: "Deploy review",
  agenda: null,
  summaryStyle: "brief",
};

const line: ClipLine = {
  userId: "u1",
  who: "Ada",
  startedAt: at(1),
  durationMs: 2000,
  transcription: "done",
  transcript: "Ben, can you write up the checklist?",
};

const recording = (summaryStyle: RecordingDetails["summaryStyle"] = "brief"): RecordingToWrite => ({
  details: { ...details, summaryStyle },
  lines: [line],
  pauses: [],
});

const attendees: ReadonlyArray<Member> = [
  { userId: "u1", name: "Ada" },
  { userId: "u2", name: "Ben Okafor" },
];

interface Call {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number | null;
}

const TextParts = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ text: Schema.String })).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (parts) =>
          Array.join(
            Array.map(parts, ({ text }) => text),
            "",
          ),
        encode: (text) => [{ text }],
      }),
    ),
  ),
]);

const decodeText = Schema.decodeUnknownOption(TextParts);

const makeWriter = Effect.fnUntraced(function* (replies: ReadonlyArray<string> | "down") {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
  const answered = yield* Ref.make(0);

  const model = scriptedModel("model-1", (options) =>
    Effect.gen(function* () {
      const config = yield* Effect.serviceOption(OpenAiLanguageModel.Config);

      const roles = (role: string) =>
        pipe(
          Array.filter(options.prompt.content, (message) => message.role === role),
          Array.map((message) => Option.getOrElse(decodeText(message.content), () => "")),
          Array.join("\n"),
        );

      yield* Ref.update(calls, (all) => [
        ...all,
        {
          system: roles("system"),
          user: roles("user"),
          maxOutputTokens: Option.getOrNull(
            Option.flatMap(config, (found) => Option.fromUndefinedOr(found.max_output_tokens)),
          ),
        },
      ]);

      if (replies === "down")
        return yield* AiError.make({
          module: "Test",
          method: "generateText",
          reason: AiError.RateLimitError.make({}),
        });

      const index = yield* Ref.getAndUpdate(answered, (n) => n + 1);

      return [{ type: "text" as const, text: replies[index % replies.length] ?? "" }];
    }),
  );

  const writer = yield* Effect.service(RecordingWriter).pipe(
    Effect.provide(RecordingWriter.layerProviders([[model]])),
  );

  return { writer, calls: Ref.get(calls) };
});

describe("RecordingWriter.summarize", () => {
  it.effect("writes in the recording's style, from its title and transcript", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeWriter(["• Shipped it"]);

      for (const style of ["brief", "detailed", "decisions"] as const)
        assert.deepStrictEqual(
          yield* writer.summarize(recording(style)),
          Option.some({ text: "• Shipped it", model: "model-1", style }),
        );

      const [brief, detailed, decisions] = yield* calls;

      assert.include(brief?.system ?? "", "what was discussed and any decisions");
      assert.include(detailed?.system ?? "", "grouped by topic");
      assert.include(decisions?.system ?? "", "Write only what was decided");
      assert.include(brief?.user ?? "", "Title: Deploy review");
      assert.include(brief?.user ?? "", "10:01 Ada: Ben, can you write up the checklist?");
    }),
  );

  it.effect("gives a Detailed summary room to answer, and the others the usual budget", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeWriter(["• Shipped it"]);

      yield* writer.summarize(recording("brief"));
      yield* writer.summarize(recording("detailed"));
      yield* writer.summarize(recording("decisions"));

      assert.deepStrictEqual(
        Array.map(yield* calls, ({ maxOutputTokens }) => maxOutputTokens),
        [null, DETAILED_OUTPUT_TOKENS, null],
      );
    }),
  );

  it.effect("checks each style's length: a Detailed summary may be longer than a Brief one", () =>
    Effect.gen(function* () {
      const long = pipe("•", String.repeat(MAX_SUMMARY_LENGTH + 1));
      const { writer } = yield* makeWriter([long]);

      assert.isTrue(Option.isNone(yield* writer.summarize(recording("brief"))));
      assert.isTrue(Option.isNone(yield* writer.summarize(recording("decisions"))));
      assert.deepStrictEqual(
        Option.map(yield* writer.summarize(recording("detailed")), ({ text }) => text),
        Option.some(long),
      );
    }),
  );
});

describe("RecordingWriter.pullActionItems", () => {
  it.effect("pulls out the action items and gives each its owner from the attendees", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeWriter([
        '[{"text": "write up the checklist", "owner": "Ben"}, {"text": "book a room", "owner": null}]',
      ]);

      assert.deepStrictEqual(
        yield* writer.pullActionItems(recording(), attendees),
        Option.some({
          model: "model-1",
          items: [
            { text: "write up the checklist", owner: "u2" },
            { text: "book a room", owner: null },
          ],
        }),
      );

      const [call] = yield* calls;

      assert.include(call?.system ?? "", "You pull the action items out");
      assert.include(call?.user ?? "", "People in the office:\nAda\nBen Okafor");
      assert.include(call?.user ?? "", "Title: Deploy review");
    }),
  );

  it.effect("leaves an item unassigned when its owner wasn't there", () =>
    Effect.gen(function* () {
      const { writer } = yield* makeWriter(['[{"text": "call the vendor", "owner": "Carla"}]']);

      assert.deepStrictEqual(
        Option.map(yield* writer.pullActionItems(recording(), attendees), ({ items }) => items),
        Option.some([{ text: "call the vendor", owner: null }]),
      );
    }),
  );

  it.effect("says no action items could be pulled out when no model answers, and reports it", () =>
    Effect.gen(function* () {
      const { reports, layer } = captureReports();
      const { writer } = yield* makeWriter("down");

      const pulled = yield* writer
        .pullActionItems(recording(), attendees)
        .pipe(Effect.provide(layer));

      assert.isTrue(Option.isNone(pulled));
      assert.deepStrictEqual(
        Array.map(reports, ({ name, severity }) => ({ name, severity })),
        [{ name: "NoAiActionItems", severity: "Warn" }],
      );
    }),
  );

  it.effect("answers with nothing when no AI provider is configured", () =>
    Effect.gen(function* () {
      const writer = yield* Effect.service(RecordingWriter).pipe(
        Effect.provide(RecordingWriter.layerNone),
      );

      assert.isTrue(Option.isNone(yield* writer.summarize(recording())));
      assert.isTrue(Option.isNone(yield* writer.pullActionItems(recording(), attendees)));
    }),
  );
});
