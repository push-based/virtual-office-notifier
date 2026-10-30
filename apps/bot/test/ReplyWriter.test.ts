import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Random, Ref, Schema, Stream } from "effect";
import { AiError, LanguageModel, Model, type Response } from "effect/ai";

import { type ReplyContext, ReplyText, ReplyWriter } from "../src/ReplyWriter.ts";
import { captureReports } from "./fakes.ts";

type Reply = Effect.Effect<Array<Response.PartEncoded>, AiError.AiError>;

const says = (text: string): Reply => Effect.succeed([{ type: "text", text }]);

const modelDown: Reply = Effect.fail(
  AiError.make({ module: "Test", method: "generateText", reason: new AiError.RateLimitError({}) }),
);

const fakeModel = (
  name: string,
  reply: Reply,
  calls: Ref.Ref<ReadonlyArray<string>>,
  prompts: Ref.Ref<ReadonlyArray<string>>,
) =>
  Model.make(
    "test",
    name,
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          Ref.update(calls, (sent) => [...sent, name]).pipe(
            Effect.andThen(
              Ref.update(prompts, (sent) => [...sent, JSON.stringify(options.prompt)]),
            ),
            Effect.andThen(reply),
          ),
        streamText: () => Stream.empty,
      }),
    ),
  );

const context: ReplyContext = {
  office: {
    at: DateTime.makeUnsafe("2026-10-20T10:00:00Z"),
    period: "ThisWeek",
    activityOldestFirst: [
      { at: DateTime.makeUnsafe("2026-10-20T07:00:00Z"), who: "Sam", event: "Joined" },
    ],
    olderEntriesLeftOut: 0,
    present: ["Sam"],
  },
  thread: [
    { who: "You", text: "🐦 Sam was first in every day this week." },
    { who: "Grace Hopper", text: "Sam lives there now" },
  ],
  earlierLeftOut: 3,
  message: { who: "Ada", text: "how long was Sam in today?" },
};

const goingEitherWay = [
  Random.withSeed("first"),
  Random.withSeed("second"),
  Random.withSeed("third"),
  Random.withSeed("fourth"),
];

const makeWriter = Effect.fnUntraced(function* (
  openRouter: ReadonlyArray<readonly [string, Reply]>,
  cloudflare: ReadonlyArray<readonly [string, Reply]>,
) {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  const prompts = yield* Ref.make<ReadonlyArray<string>>([]);

  const models = (named: ReadonlyArray<readonly [string, Reply]>) =>
    named.map(([name, reply]) => fakeModel(name, reply, calls, prompts));

  const [firstOpenRouter, ...restOpenRouter] = models(openRouter);
  const [firstCloudflare, ...restCloudflare] = models(cloudflare);

  const writer = yield* Effect.service(ReplyWriter).pipe(
    Effect.provide(
      ReplyWriter.layerProviders([
        [firstOpenRouter!, ...restOpenRouter],
        [firstCloudflare!, ...restCloudflare],
      ]),
    ),
  );

  return { writer, calls: Ref.get(calls), prompts: Ref.get(prompts) };
});

describe("ReplyText", () => {
  const decode = Schema.decodeOption(ReplyText);

  it("takes the message, without surrounding whitespace or quotes", () => {
    assert.deepStrictEqual(
      decode('  "🕰️ Sam was in for 3 hours today."\n'),
      Option.some("🕰️ Sam was in for 3 hours today."),
    );
  });

  it("rejects Slack link and mention syntax", () => {
    assert.isTrue(Option.isNone(decode("Ask <!channel> about it")));
    assert.isTrue(Option.isNone(decode("Ask <@U1> about it")));
  });

  it("rejects an empty or overlong message", () => {
    assert.isTrue(Option.isNone(decode("  ")));
    assert.isTrue(Option.isNone(decode("ha".repeat(301))));
    assert.isTrue(Option.isSome(decode("ha".repeat(300))));
  });
});

describe("ReplyWriter", () => {
  it.effect("asks OpenRouter's models first, whatever the dice say", () =>
    Effect.gen(function* () {
      for (const dice of goingEitherWay) {
        const { writer, calls } = yield* makeWriter(
          [["openrouter-1", says("🕰️ Sam was in for 3 hours today.")]],
          [["cloudflare-1", says("🕰️ Three hours, give or take.")]],
        );

        assert.deepStrictEqual(
          yield* writer.write(context).pipe(dice),
          Option.some({ text: "🕰️ Sam was in for 3 hours today.", model: "openrouter-1" }),
        );
        assert.deepStrictEqual(yield* calls, ["openrouter-1"]);
      }
    }),
  );

  it.effect("falls back to Cloudflare when OpenRouter's models can't write it", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeWriter(
        [
          ["openrouter-1", modelDown],
          ["openrouter-2", says("<!channel> look")],
        ],
        [["cloudflare-1", says("🕰️ Three hours, give or take.")]],
      );

      assert.deepStrictEqual(
        Option.map(yield* writer.write(context), ({ model }) => model),
        Option.some("cloudflare-1"),
      );
      assert.lengthOf(yield* calls, 3);
    }),
  );

  it.effect("shows the model the office log, the thread and who it's answering", () =>
    Effect.gen(function* () {
      const { writer, prompts } = yield* makeWriter(
        [["openrouter-1", says("🕰️ A while.")]],
        [["cloudflare-1", modelDown]],
      );

      yield* writer.write(context);

      const [prompt] = yield* prompts;
      assert.include(prompt, "In the office right now: Sam.");
      assert.include(prompt, "Sam Joined");
      assert.include(prompt, "You: 🐦 Sam was first in every day this week.");
      assert.include(prompt, "3 earlier messages");
      assert.include(prompt, "Grace Hopper: Sam lives there now");
      assert.include(prompt, "Ada: how long was Sam in today?");
      assert.include(prompt, "never assume");
    }),
  );

  it.effect("writes nothing and reports a warning when every model fails", () =>
    Effect.gen(function* () {
      const { reports, layer } = captureReports();

      const { writer } = yield* makeWriter(
        [["openrouter-1", modelDown]],
        [["cloudflare-1", modelDown]],
      );

      assert.isTrue(Option.isNone(yield* writer.write(context).pipe(Effect.provide(layer))));
      assert.deepStrictEqual(
        reports.map(({ name, severity }) => ({ name, severity })),
        [{ name: "NoAiReply", severity: "Warn" }],
      );
    }),
  );
});
