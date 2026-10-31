import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Exit, Layer } from "effect";

import { BotPosts } from "../src/BotPosts.ts";
import { AccessRevoked } from "../src/SlackClient.ts";
import { type FakeSlackClientOptions, makeFakeSlackClient, makeFakeSlackHistory } from "./fakes.ts";

const message = { text: "Ada opened the office", blocks: [] };

const setUp = Effect.fnUntraced(function* (
  slackOptions: FakeSlackClientOptions = {},
  postsUnavailable = false,
) {
  const slack = yield* makeFakeSlackClient(slackOptions);
  const history = yield* makeFakeSlackHistory({ postsUnavailable });

  const posts = yield* Effect.service(BotPosts).pipe(
    Effect.provide(BotPosts.layer.pipe(Layer.provide([slack.layer, history.layer]))),
  );

  return { posts, slack, history };
});

describe("BotPosts", () => {
  it.effect("posts to Slack and keeps a record of the post, in its thread", () =>
    Effect.gen(function* () {
      const { posts, slack, history } = yield* setUp();

      const top = yield* posts.post("Opened", { channel: "C1", ...message }, "m1");

      const reply = yield* posts.post(
        "Reply",
        { channel: "C1", threadTs: top.ts, ...message },
        null,
      );

      assert.lengthOf(yield* slack.posts, 2);
      assert.deepStrictEqual(
        Array.map(yield* history.posts, ({ channel, ts, threadTs, kind, model }) => ({
          channel,
          ts,
          threadTs,
          kind,
          model,
        })),
        [
          { channel: "C1", ts: top.ts, threadTs: null, kind: "Opened", model: "m1" },
          { channel: "C1", ts: reply.ts, threadTs: top.ts, kind: "Reply", model: null },
        ],
      );
    }),
  );

  it.effect("still gives back the post when it can't be recorded", () =>
    Effect.gen(function* () {
      const { posts, slack } = yield* setUp({}, true);

      const posted = yield* posts.post("Banter", { channel: "C1", ...message }, "m1");

      assert.strictEqual(posted.channel, "C1");
      assert.lengthOf(yield* slack.posts, 1);
    }),
  );

  it.effect("records nothing when Slack refuses the post", () =>
    Effect.gen(function* () {
      const { posts, history } = yield* setUp({
        postFailure: AccessRevoked.make({ error: "not_in_channel" }),
      });

      const exit = yield* Effect.exit(posts.post("Reminder", { channel: "C1", ...message }, null));

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* history.posts, []);
    }),
  );
});
