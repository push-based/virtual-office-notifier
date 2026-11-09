import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Fiber, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import { Eraser } from "../../src/erasure/Eraser.ts";
import { ErasureStore, type Subject } from "../../src/erasure/ErasureStore.ts";
import { scrubberFor } from "../../src/erasure/Scrub.ts";
import { ArchiveError, ClipArchive } from "../../src/recording/ClipArchive.ts";
import type { FetchedMessage } from "../../src/slack/SlackClient.ts";
import { BOT_USER_ID, makeFakeSlackClient } from "../fakes.ts";

const subject: Subject = {
  userId: "u1",
  slackUserIds: ["S1"],
  scrubber: scrubberFor(["Ada"], ["S1"]),
  objectPaths: ["recordings/r1/u1/a.ogg", "recordings/r1/u1/b.ogg"],
};

const post = (ts: string, text: string, userId = BOT_USER_ID): FetchedMessage => ({
  ts,
  userId,
  text,
  blocks: Option.some([{ type: "section", text: { type: "mrkdwn", text } }]),
  fileIds: [],
});

const setUp = Effect.fnUntraced(function* (failingPaths: ReadonlySet<string> = new Set()) {
  const slack = yield* makeFakeSlackClient({
    channelPosts: [
      post("1.0", "*Ada* opened the office"),
      post("2.0", "Quiet day"),
      post("3.0", "Ada is great", "U2"),
    ],
    threadPosts: new Map([["5.1", [post("5.2", "Morning, <@S1>!")]]]),
  });

  const removed = yield* Ref.make<ReadonlyArray<string>>([]);

  const store = Layer.succeed(
    ErasureStore,
    ErasureStore.of({
      subject: () => Effect.succeed(subject),
      botPostings: Effect.succeed({
        channels: ["C1"],
        threads: [{ channel: "C1", ts: "5.1" }],
      }),
      erase: () => Effect.succeed({ objectPaths: subject.objectPaths, republishing: 0 }),
      sweep: () => Effect.void,
    }),
  );

  const archive = Layer.succeed(
    ClipArchive,
    ClipArchive.of({
      bucket: Option.some("clips"),
      upload: () => Effect.void,
      download: () => Effect.succeed(new Uint8Array()),
      remove: (path) =>
        failingPaths.has(path)
          ? Effect.fail(ArchiveError.make({ reason: "Bucket down" }))
          : Ref.update(removed, (all) => [...all, path]),
    }),
  );

  const eraser = yield* Effect.service(Eraser).pipe(
    Effect.provide(Eraser.layerNoDeps.pipe(Layer.provide([store, slack.layer, archive]))),
  );

  return { eraser, slack, removed };
});

describe("Eraser", () => {
  it.effect("takes their name out of the bot's posts and threads, and deletes their audio", () =>
    Effect.gen(function* () {
      const { eraser, slack, removed } = yield* setUp();

      yield* eraser.prepare("u1");

      const rewrites = yield* slack.rewrites;

      assert.deepStrictEqual(
        Array.map(rewrites, ({ ts, text }) => [ts, text]),
        [
          ["1.0", "*a former member* opened the office"],
          ["5.2", "Morning, a former member!"],
        ],
      );
      assert.deepStrictEqual(Option.getOrNull(rewrites[0]!.blocks), [
        { type: "section", text: { type: "mrkdwn", text: "*a former member* opened the office" } },
      ]);
      assert.deepStrictEqual(yield* Ref.get(removed), subject.objectPaths);
    }),
  );

  it.effect("fails the preparation when audio can't be deleted, so it's tried again", () =>
    Effect.gen(function* () {
      const { eraser } = yield* setUp(new Set(["recordings/r1/u1/b.ogg"]));

      const error = yield* eraser.prepare("u1").pipe(Effect.flip);

      assert.strictEqual(error._tag, "ArchiveError");
    }),
  );

  it.effect("only logs audio it couldn't delete after the erasure committed", () =>
    Effect.gen(function* () {
      const { eraser, removed } = yield* setUp(new Set(["recordings/r1/u1/b.ogg"]));

      const removing = yield* Effect.forkChild(eraser.removeAudio(subject.objectPaths));

      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(removing);

      assert.deepStrictEqual(yield* Ref.get(removed), ["recordings/r1/u1/a.ogg"]);
    }),
  );
});
