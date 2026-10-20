import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Random } from "effect";
import { TestClock } from "effect/testing";

import { HeadlineWriter } from "../src/HeadlineWriter.ts";
import { OfficeEvent } from "../src/OfficeEvent.ts";
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
  withEnv,
} from "./fakes.ts";

const makeSlack = Effect.fnUntraced(function* (
  replies: ReadonlyArray<Reply>,
  headlines?: Layer.Layer<HeadlineWriter>,
) {
  const fake = yield* makeFakeSlack(replies, headlines);

  const notifier = yield* Effect.service(SlackNotifier).pipe(
    Effect.provide(fake.layer),
    withEnv(SLACK_ENV),
  );

  return { notifier, requests: fake.requests };
});

describe("SlackNotifier", () => {
  it.effect("posts the formatted message to the office channel", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([ok]);

      yield* slack.notifier.notify(opened).pipe(firstVariant);

      const requests = yield* slack.requests;
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.url, "https://slack.com/api/chat.postMessage");
      assert.deepStrictEqual(JSON.parse(requestText(requests[0]!)), {
        channel: SLACK_ENV.SLACK_CHANNEL_ID,
        ...Option.getOrThrow(formatMessage(opened, 0)),
      });
    }));

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
    }));

  it.effect("posts a generated headline when the office opens", () =>
    Effect.gen(function* () {
      const generated = Layer.succeed(
        HeadlineWriter,
        HeadlineWriter.of({
          write: () => Effect.succeedSome({ template: "🛋️ {name} saved you a seat!", button: "🪑 Grab a seat", model: "test/model" }),
        }),
      );

      const slack = yield* makeSlack([ok], generated);

      yield* slack.notifier.notify(opened);

      const [request] = yield* slack.requests;
      assert.strictEqual(JSON.parse(requestText(request!)).text, "🛋️ *Ada* saved you a seat!");
    }));

  it.effect("posts the same wording on every retry", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(503, ""), ok]);

      const fiber = yield* slack.notifier.notify(opened).pipe(Random.withSeed("retry"), Effect.forkChild);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      const [first, second] = (yield* slack.requests).map(requestText);
      assert.strictEqual(first, second);
    }));
});
