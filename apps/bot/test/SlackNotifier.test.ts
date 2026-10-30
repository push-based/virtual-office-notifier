import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Fiber, Layer, Option, Random, Schema } from "effect";
import { TestClock } from "effect/testing";

import { HeadlineWriter } from "../src/HeadlineWriter.ts";
import { OfficeEvent } from "../src/OfficeEvent.ts";
import { HistoryUnavailable } from "../src/OfficeHistory.ts";
import { SlackHistory } from "../src/SlackHistory.ts";
import { SlackNotifier } from "../src/SlackNotifier.ts";
import { formatMessage } from "../src/SlackMessage.ts";
import {
  firstVariant,
  makeFakeSlack,
  opened,
  ok,
  type Reply,
  requestText,
  respond,
  SLACK_ENV,
  slackOk,
  withEnv,
} from "./fakes.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodePostText = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

const makeSlack = Effect.fnUntraced(function* (
  replies: ReadonlyArray<Reply>,
  headlines?: Layer.Layer<HeadlineWriter>,
  history?: Layer.Layer<SlackHistory>,
) {
  const fake = yield* makeFakeSlack(replies, headlines, history);

  const notifier = yield* Effect.service(SlackNotifier).pipe(
    Effect.provide(fake.layer),
    withEnv(SLACK_ENV),
  );

  return { notifier, requests: fake.requests, recordedPosts: fake.recordedPosts };
});

describe("SlackNotifier", () => {
  it.effect("posts the formatted message to the office channel", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([ok]);

      yield* slack.notifier.notify(opened).pipe(firstVariant);

      const requests = yield* slack.requests;
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.url, "https://slack.com/api/chat.postMessage");
      assert.deepStrictEqual(yield* requests[0]!.pipe(requestText, decodeJson), {
        channel: SLACK_ENV.SLACK_CHANNEL_ID,
        ...Option.getOrThrow(formatMessage(opened, 0)),
      });
    }),
  );

  it.effect("posts nothing for banter no AI model could write", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([ok]);

      const banter = OfficeEvent.Banter({
        guildId: "g1",
        channelId: "c1",
        at: opened.at,
        period: "Today",
        activityOldestFirst: [],
        olderEntriesLeftOut: 0,
        present: [],
      });

      assert.isFalse(yield* slack.notifier.notify(banter));
      assert.deepStrictEqual(yield* slack.requests, []);
    }),
  );

  it.effect("posts a generated headline when the office opens", () =>
    Effect.gen(function* () {
      const generated = Layer.succeed(
        HeadlineWriter,
        HeadlineWriter.of({
          write: () =>
            Effect.succeedSome({
              template: "🛋️ {name} saved you a seat!",
              button: "🪑 Grab a seat",
              model: "test/model",
            }),
        }),
      );

      const slack = yield* makeSlack([ok], generated);

      yield* slack.notifier.notify(opened);

      const [request] = yield* slack.requests;
      const { text } = yield* request!.pipe(requestText, decodePostText);
      assert.strictEqual(text, "🛋️ *Ada* saved you a seat!");
    }),
  );

  it.effect("records each post with what it was and the model that wrote it", () =>
    Effect.gen(function* () {
      const generated = Layer.succeed(
        HeadlineWriter,
        HeadlineWriter.of({
          write: () =>
            Effect.succeedSome({
              template: "🛋️ {name} saved you a seat!",
              button: "🪑 Grab a seat",
              model: "test/model",
            }),
        }),
      );

      const slack = yield* makeSlack(
        [slackOk({ channel: "C-OFFICE", ts: "1700000000.000200" })],
        generated,
      );

      yield* slack.notifier.notify(opened);

      const [post] = yield* slack.recordedPosts;
      assert.strictEqual(post?.channel, "C-OFFICE");
      assert.strictEqual(post?.ts, "1700000000.000200");
      assert.strictEqual(post?.threadTs, null);
      assert.strictEqual(post?.kind, "Opened");
      assert.strictEqual(post?.model, "test/model");
    }),
  );

  it.effect("still announces when the post can't be recorded", () =>
    Effect.gen(function* () {
      const disabled = yield* Effect.service(SlackHistory).pipe(
        Effect.provide(SlackHistory.layerDisabled),
      );

      const broken = Layer.succeed(
        SlackHistory,
        SlackHistory.of({
          ...disabled,
          recordPost: () => Effect.fail(HistoryUnavailable.make({ reason: "down" })),
        }),
      );

      const slack = yield* makeSlack([ok], undefined, broken);

      assert.isTrue(yield* slack.notifier.notify(opened));
    }),
  );

  it.effect("posts the same wording on every retry", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(503, ""), ok]);

      const fiber = yield* slack.notifier
        .notify(opened)
        .pipe(Random.withSeed("retry"), Effect.forkChild);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      const [first, second] = Array.map(yield* slack.requests, requestText);
      assert.strictEqual(first, second);
    }),
  );
});
