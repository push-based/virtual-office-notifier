import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";

import { ActivityLog } from "../../src/activity/ActivityLog.ts";
import { columnNaming, Database } from "../../src/database/Database.ts";
import { NO_VOICE_DETAILS } from "../../src/office/OfficeEvent.ts";
import {
  type ConsideredMessage,
  type DecisionRecord,
  SlackHistory,
} from "../../src/slack/SlackHistory.ts";

const SESSION = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const TestLayer = Layer.mergeAll(SlackHistory.layer, ActivityLog.layer).pipe(
  Layer.provideMerge(Database.layerNoDeps()),
  Layer.provideMerge(PgliteClient.layer(columnNaming)),
);

const hours = (hour: number) => DateTime.makeUnsafe(hour * 3_600_000);

const message = (ts: string, overrides: Partial<ConsideredMessage> = {}): ConsideredMessage => ({
  channel: "C-OFFICE",
  ts,
  threadTs: "1.0",
  userId: "U1",
  displayName: "Ada",
  memberUserId: null,
  text: "haha",
  isMention: false,
  receivedAt: hours(10),
  ...overrides,
});

const ignored = (messageId: number, decidedAt: DateTime.Utc): DecisionRecord => ({
  messageId,
  decidedAt,
  clef: Option.none(),
  minConfidence: 0.7,
  maxRepliesPerDay: 20,
  maxReactionsPerDay: 30,
  maxRepliesPerThread: 3,
  outcome: "ignored",
  reason: "outside_hours",
});

const reacted = (messageId: number, decidedAt: DateTime.Utc): DecisionRecord => ({
  ...ignored(messageId, decidedAt),
  clef: Option.some({
    model: "@cf/cloudflare/clef",
    request: { state: { message: "haha" }, questions: {} },
    action: "react",
    actionProbabilities: { reply: 0.03, react: 0.86, ignore: 0.11 },
    actionConfidence: 0.81,
    reaction: "joy",
    reactionProbabilities: { joy: 0.96, eyes: 0.04 },
    reactionConfidence: 0.89,
    latencyMs: 210,
  }),
  outcome: "reacted",
  reason: "clef",
});

const reply = (ts: string, threadTs: string, postedAt: DateTime.Utc) => ({
  channel: "C-OFFICE",
  ts,
  threadTs,
  kind: "Reply" as const,
  model: "test/model",
  postedAt,
});

const ready = Effect.gen(function* () {
  const database = yield* Database;

  yield* database.ready;
});

describe("SlackHistory", () => {
  it.effect("starts with responding switched off and the agreed defaults", () =>
    Effect.gen(function* () {
      yield* ready;

      const settings = yield* (yield* SlackHistory).settings;

      assert.isFalse(settings.enabled);
      assert.strictEqual(settings.clefModel, "@cf/cloudflare/clef");
      assert.strictEqual(settings.minConfidence, 0.7);
      assert.strictEqual(settings.maxRepliesPerDay, 20);
      assert.strictEqual(settings.maxReactionsPerDay, 30);
      assert.strictEqual(settings.maxRepliesPerThread, 3);
      assert.isTrue(Duration.equals(settings.staleAfter, Duration.minutes(2)));
      assert.strictEqual(settings.clefThreadMessages, 10);
      assert.strictEqual(settings.writerThreadMessages, 50);
      assert.isAtLeast(settings.reactionEmoji.length, 2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reads a change to the settings straight away", () =>
    Effect.gen(function* () {
      yield* ready;

      const sql = yield* SqlClient.SqlClient;

      yield* sql`UPDATE office.responder_settings SET enabled = true, min_confidence = 0.9, reaction_emoji = ARRAY['tada', 'eyes']`;

      const settings = yield* (yield* SlackHistory).settings;

      assert.isTrue(settings.enabled);
      assert.strictEqual(settings.minConfidence, 0.9);
      assert.deepStrictEqual(settings.reactionEmoji, ["tada", "eyes"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses settings that can't work", () =>
    Effect.gen(function* () {
      yield* ready;

      const sql = yield* SqlClient.SqlClient;

      for (const update of [
        sql`UPDATE office.responder_settings SET min_confidence = 1.5`,
        sql`UPDATE office.responder_settings SET max_replies_per_day = -1`,
        sql`UPDATE office.responder_settings SET stale_after_seconds = 0`,
        sql`UPDATE office.responder_settings SET reaction_emoji = ARRAY['joy']`,
        sql`UPDATE office.responder_settings SET clef_model = ''`,
        sql`INSERT INTO office.responder_settings (id, reaction_emoji) VALUES (false, ARRAY['joy', 'eyes'])`,
      ]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(update)));
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("counts the office day's replies and reactions, and the replies in a thread", () =>
    Effect.gen(function* () {
      yield* ready;

      const history = yield* SlackHistory;

      yield* history.recordPost(reply("9.0", "1.0", hours(9)));
      yield* history.recordPost(reply("11.0", "1.0", hours(11)));
      yield* history.recordPost(reply("12.0", "2.0", hours(12)));
      yield* history.recordPost({
        ...reply("13.0", "1.0", hours(13)),
        kind: "Banter",
        threadTs: null,
      });

      const first = yield* history.recordMessage(message("10.1"));
      const second = yield* history.recordMessage(message("10.2"));
      const third = yield* history.recordMessage(message("10.3"));

      yield* history.recordDecision(reacted(first, hours(9)));
      yield* history.recordDecision(reacted(second, hours(11)));
      yield* history.recordDecision(ignored(third, hours(11)));

      assert.strictEqual(yield* history.repliesSince(hours(10)), 2);
      assert.strictEqual(yield* history.reactionsSince(hours(10)), 1);
      assert.strictEqual(yield* history.repliesInThread("C-OFFICE", "1.0"), 2);
      assert.strictEqual(yield* history.repliesInThread("C-OFFICE", "3.0"), 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("links a Slack author by their Slack ID, then by real name", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;

      yield* log.startSession(SESSION, hours(1));

      for (const [userId, displayName] of [
        ["d1", "adal"],
        ["d2", "gracie"],
        ["d3", "linus_t"],
      ] as const) {
        yield* log.record(SESSION, SecureRandom.uuidV4Unsafe(), {
          source: "update",
          officeChannelId: "office",
          userId,
          displayName,
          avatarUrl: null,
          guildId: "g1",
          isBot: false,
          oldChannelId: null,
          newChannelId: "office",
          oldDetails: NO_VOICE_DETAILS,
          newDetails: NO_VOICE_DETAILS,
          at: hours(2),
        });
      }

      const sql = yield* SqlClient.SqlClient;

      yield* sql`UPDATE office.members SET slack_user_id = 'U-ADA' WHERE user_id = 'd1'`;
      yield* sql`UPDATE office.members SET real_name = 'Grace Hopper' WHERE user_id = 'd2'`;

      const history = yield* SlackHistory;

      assert.deepStrictEqual(
        yield* history.linkMember("U-ADA", "Someone Else"),
        Option.some({ memberUserId: "d1", name: "adal" }),
      );
      assert.deepStrictEqual(
        yield* history.linkMember("U-GRACE", "grace hopper"),
        Option.some({ memberUserId: "d2", name: "Grace Hopper" }),
      );
      assert.deepStrictEqual(yield* history.linkMember("U-LINUS", "Linus Torvalds"), Option.none());
      assert.deepStrictEqual(yield* history.linkMember("U-NOBODY", ""), Option.none());
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps every reaction on the bot's posts, removals included", () =>
    Effect.gen(function* () {
      yield* ready;

      const history = yield* SlackHistory;

      const reaction = {
        channel: "C-OFFICE",
        itemTs: "9.0",
        userId: "U1",
        emoji: "joy",
        added: true,
        eventTs: "9.5",
        receivedAt: hours(9),
      };

      yield* history.recordReaction(reaction);
      yield* history.recordReaction({ ...reaction, added: false, eventTs: "9.6" });

      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{
        readonly added: boolean;
      }>`SELECT added FROM office.slack_reactions ORDER BY id`;

      assert.deepStrictEqual(
        Array.map(rows, (row) => row.added),
        [true, false],
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("SlackHistory.layerDisabled", () => {
  it.effect("has no settings, so responding stays off, and quietly records nothing", () =>
    Effect.gen(function* () {
      const history = yield* SlackHistory;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(history.settings)));

      yield* history.recordPost(reply("1.0", "1.0", hours(1)));
    }).pipe(Effect.provide(SlackHistory.layerDisabled)),
  );
});
