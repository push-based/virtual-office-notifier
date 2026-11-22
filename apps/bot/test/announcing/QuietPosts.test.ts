import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { isQuiet, tidyEveryMorning, tidyQuietPosts } from "../../src/announcing/QuietPosts.ts";
import type { Engagement, SlackErrorReason } from "../../src/slack/SlackClient.ts";
import { InvalidPayload, Unavailable } from "../../src/slack/SlackClient.ts";
import { type PostKind, SlackHistory } from "../../src/slack/SlackHistory.ts";
import { makeFakeSlackClient, makeFakeSlackHistory } from "../fakes.ts";

const CHANNEL = "C-OFFICE";

// Office time is UTC+2, so 2026-10-01 is a Thursday and 2026-10-02 a Friday.
const officeTime = (iso: string) => DateTime.makeUnsafe(`${iso}+02:00`);

const FRIDAY_MORNING = officeTime("2026-10-02T08:45:00");

interface Setup {
  readonly engagement?: ReadonlyMap<string, Engagement>;
  readonly engagementFailures?: ReadonlyMap<string, SlackErrorReason>;
}

const makeOffice = Effect.fnUntraced(function* (setup: Setup = {}) {
  const slack = yield* makeFakeSlackClient(setup);
  const history = yield* makeFakeSlackHistory();

  const post = (
    ts: string,
    at: string,
    kind: PostKind = "Banter",
    threadTs: string | null = null,
  ) =>
    Effect.gen(function* () {
      const store = yield* SlackHistory;

      yield* store.recordPost({
        channel: CHANNEL,
        ts,
        threadTs,
        kind,
        model: "test/model",
        text: `Post ${ts}`,
        postedAt: officeTime(at),
      });
    }).pipe(Effect.provide(history.layer));

  return {
    layer: Layer.merge(slack.layer, history.layer),
    post,
    deletions: slack.deletions,
    recordedDeletions: history.deleted,
    posts: history.posts,
  };
});

describe("isQuiet", () => {
  it.each([
    { reactions: 0, replies: 0, quiet: true },
    { reactions: 1, replies: 0, quiet: false },
    { reactions: 0, replies: 1, quiet: false },
    { reactions: 2, replies: 3, quiet: false },
  ])("is $quiet with $reactions reactions and $replies replies", ({ quiet, ...engagement }) => {
    assert.strictEqual(isQuiet(engagement), quiet);
  });
});

describe("tidyQuietPosts", () => {
  it.effect(
    "deletes yesterday's announcements, reminder and banter that nobody reacted to or replied under",
    () =>
      Effect.gen(function* () {
        const office = yield* makeOffice();

        yield* office.post("1.0", "2026-10-01T09:30:00", "Opened");
        yield* office.post("2.0", "2026-10-01T10:00:00");
        yield* office.post("3.0", "2026-10-01T11:15:00", "Reminder");
        yield* office.post("4.0", "2026-10-01T17:30:00", "Emptied");

        const outcomes = yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

        assert.deepStrictEqual(outcomes, ["deleted", "deleted", "deleted", "deleted"]);
        assert.deepStrictEqual(yield* office.deletions, [
          [CHANNEL, "1.0"],
          [CHANNEL, "2.0"],
          [CHANNEL, "3.0"],
          [CHANNEL, "4.0"],
        ]);
        assert.deepStrictEqual(yield* office.recordedDeletions, [
          { channel: CHANNEL, ts: "1.0" },
          { channel: CHANNEL, ts: "2.0" },
          { channel: CHANNEL, ts: "3.0" },
          { channel: CHANNEL, ts: "4.0" },
        ]);
      }),
  );

  it.effect("catches up on quiet posts from before yesterday that no morning deleted", () =>
    Effect.gen(function* () {
      const office = yield* makeOffice();

      yield* office.post("1.0", "2026-09-14T10:00:00");
      yield* office.post("2.0", "2026-09-30T23:59:00", "Emptied");

      const outcomes = yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

      assert.deepStrictEqual(outcomes, ["deleted", "deleted"]);
      assert.deepStrictEqual(yield* office.deletions, [
        [CHANNEL, "1.0"],
        [CHANNEL, "2.0"],
      ]);
    }),
  );

  it.effect("keeps a post with a reaction, or a reply in its thread", () =>
    Effect.gen(function* () {
      const office = yield* makeOffice({
        engagement: new Map([
          ["1.0", { reactions: 1, replies: 0 }],
          ["2.0", { reactions: 0, replies: 1 }],
        ]),
      });

      yield* office.post("1.0", "2026-10-01T10:00:00", "Opened");
      yield* office.post("2.0", "2026-10-01T12:00:00");
      yield* office.post("3.0", "2026-10-01T14:00:00");

      const outcomes = yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

      assert.deepStrictEqual(outcomes, ["kept", "kept", "deleted"]);
      assert.deepStrictEqual(yield* office.deletions, [[CHANNEL, "3.0"]]);
    }),
  );

  it.effect("looks again the next morning at a post it kept", () =>
    Effect.gen(function* () {
      const office = yield* makeOffice({
        engagement: new Map([["1.0", { reactions: 1, replies: 0 }]]),
      });

      yield* office.post("1.0", "2026-10-01T10:00:00", "Emptied");

      yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

      const nextMorning = yield* tidyQuietPosts(officeTime("2026-10-03T08:45:00")).pipe(
        Effect.provide(office.layer),
      );

      assert.deepStrictEqual(nextMorning, ["kept"]);
    }),
  );

  it.effect("leaves today's posts, recordings and replies in threads alone", () =>
    Effect.gen(function* () {
      const office = yield* makeOffice();

      yield* office.post("1.0", "2026-10-02T00:00:00");
      yield* office.post("2.0", "2026-10-02T08:30:00", "Opened");
      yield* office.post("3.0", "2026-10-01T12:05:00", "Reply", "9.0");
      yield* office.post("4.0", "2026-10-01T12:10:00", "Recording");

      const outcomes = yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

      assert.deepStrictEqual(outcomes, []);
      assert.deepStrictEqual(yield* office.deletions, []);
    }),
  );

  it.effect("keeps the deleted post's text in the history", () =>
    Effect.gen(function* () {
      const office = yield* makeOffice();

      yield* office.post("1.0", "2026-10-01T10:00:00");

      yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

      const [kept] = yield* office.posts;
      assert.strictEqual(kept?.text, "Post 1.0");
    }),
  );

  it.effect("doesn't check a post it already deleted again", () =>
    Effect.gen(function* () {
      const office = yield* makeOffice();

      yield* office.post("1.0", "2026-10-01T10:00:00");

      yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));
      const again = yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

      assert.deepStrictEqual(again, []);
      assert.strictEqual((yield* office.deletions).length, 1);
    }),
  );

  it.effect("leaves a post in Slack when Slack fails on it, and carries on with the rest", () =>
    Effect.gen(function* () {
      const office = yield* makeOffice({
        engagementFailures: new Map<string, SlackErrorReason>([
          ["1.0", Unavailable.make({ status: 503 })],
          ["2.0", InvalidPayload.make({ error: "thread_not_found" })],
        ]),
      });

      yield* office.post("1.0", "2026-10-01T10:00:00");
      yield* office.post("2.0", "2026-10-01T12:00:00");
      yield* office.post("3.0", "2026-10-01T14:00:00");

      const outcomes = yield* tidyQuietPosts(FRIDAY_MORNING).pipe(Effect.provide(office.layer));

      assert.deepStrictEqual(outcomes, ["failed", "failed", "deleted"]);
      assert.deepStrictEqual(yield* office.deletions, [[CHANNEL, "3.0"]]);
    }),
  );

  it.effect("deletes nothing without the database", () =>
    Effect.gen(function* () {
      const slack = yield* makeFakeSlackClient();

      const outcomes = yield* tidyQuietPosts(FRIDAY_MORNING).pipe(
        Effect.provide(Layer.merge(slack.layer, SlackHistory.layerDisabled)),
      );

      assert.deepStrictEqual(outcomes, []);
      assert.deepStrictEqual(yield* slack.deletions, []);
    }),
  );
});

describe("tidyEveryMorning", () => {
  it.effect(
    "tidies at 08:45 office time, weekends included, so Friday's posts go on Saturday",
    () =>
      Effect.gen(function* () {
        const office = yield* makeOffice();

        yield* TestClock.setTime(DateTime.toEpochMillis(officeTime("2026-10-02T18:00:00")));
        yield* office.post("1.0", "2026-10-02T10:00:00");

        const fiber = yield* tidyEveryMorning.pipe(Effect.provide(office.layer), Effect.forkChild);

        yield* Effect.repeat(Effect.yieldNow, { times: 10 });
        yield* TestClock.adjust("884 minutes");
        assert.deepStrictEqual(yield* office.deletions, []);

        yield* TestClock.adjust("1 minute");
        yield* Effect.repeat(Effect.yieldNow, { times: 10 });
        assert.deepStrictEqual(yield* office.deletions, [[CHANNEL, "1.0"]]);

        yield* Fiber.interrupt(fiber);
      }),
  );
});
