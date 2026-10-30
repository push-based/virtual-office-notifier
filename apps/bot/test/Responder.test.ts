import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { OfficeHistory } from "../src/OfficeHistory.ts";
import {
  ClefFailed,
  type ClefState,
  type Decided,
  judge,
  ReplyDecider,
} from "../src/ReplyDecider.ts";
import { type ReplyContext, ReplyWriter, type WrittenReply } from "../src/ReplyWriter.ts";
import { respondToSlack } from "../src/Responder.ts";
import { AccessRevoked } from "../src/SlackClient.ts";
import { decodeEnvelope, type Envelope } from "../src/SlackEvent.ts";
import type { ClefVerdict, LinkedMember, ResponderSettings } from "../src/SlackHistory.ts";
import { SlackSocket } from "../src/SlackSocket.ts";
import {
  BOT_USER_ID,
  captureReports,
  DEFAULT_SETTINGS,
  type FakeSlackClientOptions,
  makeFakeSlackClient,
  makeFakeSlackHistory,
  SLACK_ENV,
  withEnv,
} from "./fakes.ts";

const OFFICE = SLACK_ENV.SLACK_CHANNEL_ID;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const TUESDAY_10AM = DateTime.makeUnsafe("2026-10-20T08:00:00Z");

const TUESDAY_7PM = DateTime.makeUnsafe("2026-10-20T17:00:00Z");

const BANTER_TS = "100.0";

const banterThread = [
  { ts: BANTER_TS, userId: BOT_USER_ID, text: "🐦 Sam was first in every day this week." },
];

type EventFields = Record<string, string | Record<string, string>>;

const envelope = (event: EventFields): Envelope =>
  Option.getOrThrow(
    decodeEnvelope(
      JSON.stringify({
        envelope_id: "e",
        type: "events_api",
        retry_attempt: 0,
        payload: { event },
      }),
    ),
  );

const threadReply = (ts: string, text: string, overrides: EventFields = {}) =>
  envelope({
    type: "message",
    channel: OFFICE,
    user: "U1",
    text,
    ts,
    thread_ts: BANTER_TS,
    parent_user_id: BOT_USER_ID,
    ...overrides,
  });

const mention = (ts: string, text: string, overrides: EventFields = {}) =>
  envelope({
    type: "app_mention",
    channel: OFFICE,
    user: "U1",
    text: `<@${BOT_USER_ID}> ${text}`,
    ts,
    ...overrides,
  });

const reaction = (type: "reaction_added" | "reaction_removed") =>
  envelope({
    type,
    user: "U1",
    reaction: "joy",
    item_user: BOT_USER_ID,
    item: { type: "message", channel: OFFICE, ts: BANTER_TS },
    event_ts: "300.0",
  });

const verdict = (action: ClefVerdict["action"], confidence = 0.9): ClefVerdict => ({
  model: "@cf/cloudflare/clef",
  request: { state: {}, questions: {} },
  action,
  actionProbabilities: { reply: 0.1, react: 0.1, ignore: 0.8 },
  actionConfidence: confidence,
  reaction: "raised_hands",
  reactionProbabilities: { joy: 0.1, eyes: 0.1, raised_hands: 0.8 },
  reactionConfidence: 0.9,
  latencyMs: 200,
});

const clefSays =
  (action: ClefVerdict["action"], confidence = 0.9) =>
  (settings: ResponderSettings): Effect.Effect<Decided, ClefFailed> =>
    Effect.succeed({
      verdict: verdict(action, confidence),
      judgement: judge(verdict(action, confidence), settings.minConfidence),
    });

const written: WrittenReply = { text: "🕰️ Sam was in for 3 hours today.", model: "test/model" };

interface Setup {
  readonly decide?:
    | ((settings: ResponderSettings) => Effect.Effect<Decided, ClefFailed>)
    | undefined;
  readonly write?: Effect.Effect<Option.Option<WrittenReply>> | undefined;
  readonly settings?: ResponderSettings | undefined;
  readonly members?: ReadonlyMap<string, LinkedMember> | undefined;
  readonly slack?: FakeSlackClientOptions | undefined;
  readonly at?: DateTime.Utc | undefined;
}

const start = Effect.fnUntraced(function* (setup: Setup = {}) {
  yield* TestClock.setTime(DateTime.toEpochMillis(setup.at ?? TUESDAY_10AM));

  const incoming = yield* Queue.unbounded<Envelope>();

  const slack = yield* makeFakeSlackClient({
    threads: new Map([[BANTER_TS, banterThread]]),
    ...setup.slack,
  });

  const history = yield* makeFakeSlackHistory({ settings: setup.settings, members: setup.members });
  const clefStates = yield* Ref.make<ReadonlyArray<ClefState>>([]);
  const replyContexts = yield* Ref.make<ReadonlyArray<ReplyContext>>([]);
  const { reports, layer: reporting } = captureReports();

  const decide = setup.decide ?? clefSays("ignore");

  const layer = Layer.mergeAll(
    slack.layer,
    history.layer,
    Layer.succeed(SlackSocket, SlackSocket.of({ envelopes: Stream.fromQueue(incoming) })),
    Layer.succeed(
      ReplyDecider,
      ReplyDecider.of({
        decide: (state, settings) =>
          Ref.update(clefStates, (all) => [...all, state]).pipe(Effect.andThen(decide(settings))),
      }),
    ),
    Layer.succeed(
      ReplyWriter,
      ReplyWriter.of({
        write: (context) =>
          Ref.update(replyContexts, (all) => [...all, context]).pipe(
            Effect.andThen(setup.write ?? Effect.succeedSome(written)),
          ),
      }),
    ),
    Layer.succeed(
      OfficeHistory,
      OfficeHistory.of({
        latestActivityBetween: () =>
          Effect.succeed({
            entriesOldestFirst: [{ at: TUESDAY_10AM, who: "Sam", event: "Joined" }],
            olderEntriesLeftOut: 0,
          }),
        presentSinceBotStarted: Effect.succeed(["Sam"]),
        banterPostsSince: () => Effect.succeed(0),
        recordBanterPost: () => Effect.void,
      }),
    ),
    reporting,
  );

  yield* respondToSlack.pipe(Effect.provide(layer), withEnv(SLACK_ENV), Effect.forkChild);

  const send = (...envelopes: ReadonlyArray<Envelope>) =>
    Queue.offerAll(incoming, envelopes).pipe(Effect.andThen(TestClock.adjust("1 millis")));

  return {
    send,
    slack,
    history,
    reports,
    clefStates: Ref.get(clefStates),
    replyContexts: Ref.get(replyContexts),
    outcomes: history.decisions.pipe(
      Effect.map((all) => Array.map(all, ({ outcome, reason }) => `${outcome}:${reason}`)),
    ),
  };
});

describe("respondToSlack", () => {
  it.effect("answers a mention in a new thread under it, crediting the model", () =>
    Effect.gen(function* () {
      const bot = yield* start();

      yield* bot.send(mention("200.0", "who's in?"));

      const [post] = yield* bot.slack.posts;
      assert.strictEqual(post?.channel, OFFICE);
      assert.strictEqual(post?.threadTs, "200.0");
      assert.strictEqual(post?.text, "🕰️ Sam was in for 3 hours today.");
      const blocks = yield* encodeJson(post?.blocks);
      assert.include(blocks, "test/model");
      assert.include(blocks, "AI is a hallucination machine");

      assert.deepStrictEqual(yield* bot.outcomes, ["replied:mention"]);
      assert.deepStrictEqual(
        Array.map(yield* bot.history.posts, ({ kind, threadTs, model }) => ({
          kind,
          threadTs,
          model,
        })),
        [{ kind: "Reply", threadTs: "200.0", model: "test/model" }],
      );
      assert.deepStrictEqual(yield* bot.clefStates, []);
    }),
  );

  it.effect("escapes what the model wrote before posting it", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        write: Effect.succeedSome({ text: "Tom & Jerry", model: "test/model" }),
      });

      yield* bot.send(mention("200.0", "hi"));

      assert.strictEqual((yield* bot.slack.posts)[0]?.text, "Tom &amp; Jerry");
    }),
  );

  it.effect(
    "shows the writer the office and the thread, with linked people under their office names",
    () =>
      Effect.gen(function* () {
        const bot = yield* start({
          decide: clefSays("reply"),
          members: new Map([["U1", { memberUserId: "d1", name: "Ada Lovelace" }]]),
          slack: {
            threads: new Map([
              [
                BANTER_TS,
                [
                  ...banterThread,
                  { ts: "150.0", userId: "U2", text: "Sam lives there now" },
                  { ts: "200.0", userId: "U1", text: "how long was Sam in?" },
                ],
              ],
            ]),
            profiles: new Map([["U2", { displayName: "Grace", realName: "Grace Hopper" }]]),
          },
        });

        yield* bot.send(threadReply("200.0", "how long was Sam in?"));

        const [context] = yield* bot.replyContexts;
        assert.deepStrictEqual(context?.thread, [
          { who: "You", text: "🐦 Sam was first in every day this week." },
          { who: "Grace", text: "Sam lives there now" },
        ]);
        assert.deepStrictEqual(context?.message, {
          who: "Ada Lovelace",
          text: "how long was Sam in?",
        });
        assert.deepStrictEqual(context?.office.present, ["Sam"]);

        const [state] = yield* bot.clefStates;
        assert.deepStrictEqual(state?.botPost, {
          who: "the bot",
          text: "🐦 Sam was first in every day this week.",
        });
        assert.deepStrictEqual(state?.earlier, [{ who: "Grace", text: "Sam lives there now" }]);

        const [message] = yield* bot.history.messages;
        assert.strictEqual(message?.memberUserId, "d1");
        assert.strictEqual(message?.displayName, "U1");
      }),
  );

  it.effect("keeps to the configured windows of the thread", () =>
    Effect.gen(function* () {
      const earlier = Array.makeBy(6, (index) => ({
        ts: `${110 + index}.0`,
        userId: "U2",
        text: `message ${index}`,
      }));

      const bot = yield* start({
        decide: clefSays("reply"),
        settings: { ...DEFAULT_SETTINGS, clefThreadMessages: 2, writerThreadMessages: 4 },
        slack: {
          threads: new Map([
            [BANTER_TS, [...banterThread, ...earlier, { ts: "200.0", userId: "U1", text: "?" }]],
          ]),
        },
      });

      yield* bot.send(threadReply("200.0", "?"));

      const [state] = yield* bot.clefStates;
      assert.isDefined(state);
      assert.deepStrictEqual(
        Array.map(state.earlier, ({ text }) => text),
        ["message 4", "message 5"],
      );

      const [context] = yield* bot.replyContexts;
      assert.isDefined(context);
      assert.deepStrictEqual(
        Array.map(context.thread, ({ text }) => text),
        [
          "🐦 Sam was first in every day this week.",
          "message 2",
          "message 3",
          "message 4",
          "message 5",
        ],
      );
      assert.strictEqual(context.earlierLeftOut, 2);
    }),
  );

  it.effect("reacts with Clef's emoji when it says to", () =>
    Effect.gen(function* () {
      const bot = yield* start({ decide: clefSays("react") });

      yield* bot.send(threadReply("200.0", "haha"));

      assert.deepStrictEqual(yield* bot.slack.reactions, [[OFFICE, "200.0", "raised_hands"]]);
      assert.deepStrictEqual(yield* bot.slack.posts, []);
      assert.deepStrictEqual(yield* bot.outcomes, ["reacted:clef"]);

      const [decision] = yield* bot.history.decisions;
      assert.isTrue(Option.isSome(decision!.clef));
      assert.strictEqual(decision?.minConfidence, DEFAULT_SETTINGS.minConfidence);
    }),
  );

  it.effect("replies in the thread when Clef says to", () =>
    Effect.gen(function* () {
      const bot = yield* start({ decide: clefSays("reply") });

      yield* bot.send(threadReply("200.0", "what do you think, bot?"));

      assert.strictEqual((yield* bot.slack.posts)[0]?.threadTs, BANTER_TS);
      assert.deepStrictEqual(yield* bot.outcomes, ["replied:clef"]);
    }),
  );

  it.effect("leaves people talking to each other alone", () =>
    Effect.gen(function* () {
      const bot = yield* start({ decide: clefSays("ignore") });

      yield* bot.send(threadReply("200.0", "@Grace lunch?"));

      assert.deepStrictEqual(yield* bot.slack.posts, []);
      assert.deepStrictEqual(yield* bot.slack.reactions, []);
      assert.deepStrictEqual(yield* bot.outcomes, ["ignored:clef"]);
    }),
  );

  it.effect("does nothing when Clef isn't confident enough", () =>
    Effect.gen(function* () {
      const bot = yield* start({ decide: clefSays("reply", 0.5) });

      yield* bot.send(threadReply("200.0", "hm"));

      assert.deepStrictEqual(yield* bot.slack.posts, []);
      assert.deepStrictEqual(yield* bot.outcomes, ["ignored:low_confidence"]);
    }),
  );

  it.effect("stays quiet outside office hours, even for mentions", () =>
    Effect.gen(function* () {
      const bot = yield* start({ at: TUESDAY_7PM, decide: clefSays("reply") });

      yield* bot.send(mention("200.0", "hello?"), threadReply("201.0", "anyone?"));

      assert.deepStrictEqual(yield* bot.slack.posts, []);
      assert.deepStrictEqual(yield* bot.clefStates, []);
      assert.deepStrictEqual(yield* bot.outcomes, [
        "ignored:outside_hours",
        "ignored:outside_hours",
      ]);
    }),
  );

  it.effect("stops replying at the daily cap, but can still react", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        decide: clefSays("reply"),
        settings: { ...DEFAULT_SETTINGS, maxRepliesPerDay: 1 },
      });

      yield* bot.send(mention("200.0", "first"));
      yield* bot.send(mention("210.0", "second"));
      yield* bot.send(threadReply("220.0", "and you?"));

      assert.lengthOf(yield* bot.slack.posts, 1);
      assert.deepStrictEqual(yield* bot.slack.reactions, []);
      assert.deepStrictEqual(yield* bot.outcomes, [
        "replied:mention",
        "ignored:daily_cap",
        "ignored:daily_cap",
      ]);
      assert.lengthOf(yield* bot.clefStates, 1);
    }),
  );

  it.effect("stops replying in a thread at the thread cap", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        decide: clefSays("reply"),
        settings: { ...DEFAULT_SETTINGS, maxRepliesPerThread: 1 },
      });

      yield* bot.send(threadReply("200.0", "first"));
      yield* bot.send(threadReply("210.0", "second"));

      assert.lengthOf(yield* bot.slack.posts, 1);
      assert.deepStrictEqual(yield* bot.outcomes, ["replied:clef", "ignored:thread_cap"]);
    }),
  );

  it.effect("doesn't ask Clef when it couldn't reply or react anyway", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        decide: clefSays("react"),
        settings: { ...DEFAULT_SETTINGS, maxRepliesPerDay: 0, maxReactionsPerDay: 0 },
      });

      yield* bot.send(threadReply("200.0", "haha"));

      assert.deepStrictEqual(yield* bot.clefStates, []);
      assert.deepStrictEqual(yield* bot.outcomes, ["ignored:daily_cap"]);
    }),
  );

  it.effect("stops reacting at the daily reaction cap", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        decide: clefSays("react"),
        settings: { ...DEFAULT_SETTINGS, maxReactionsPerDay: 1 },
      });

      yield* bot.send(threadReply("200.0", "haha"));
      yield* bot.send(threadReply("210.0", "lol"));

      assert.lengthOf(yield* bot.slack.reactions, 1);
      assert.deepStrictEqual(yield* bot.outcomes, ["reacted:clef", "ignored:daily_cap"]);
    }),
  );

  it.effect("does nothing and records nothing while switched off", () =>
    Effect.gen(function* () {
      const bot = yield* start({ settings: { ...DEFAULT_SETTINGS, enabled: false } });

      yield* bot.send(
        mention("200.0", "hi"),
        threadReply("210.0", "hey"),
        reaction("reaction_added"),
      );

      assert.deepStrictEqual(yield* bot.slack.posts, []);
      assert.deepStrictEqual(yield* bot.history.messages, []);
      assert.deepStrictEqual(yield* bot.history.decisions, []);
      assert.deepStrictEqual(yield* bot.history.reactions, []);
    }),
  );

  it.effect("does nothing when the settings can't be read", () =>
    Effect.gen(function* () {
      const bot = yield* start();

      yield* bot.history.setSettings(Option.none());
      yield* bot.send(mention("200.0", "hi"));

      assert.deepStrictEqual(yield* bot.slack.posts, []);
      assert.deepStrictEqual(yield* bot.history.messages, []);
    }),
  );

  it.effect("picks up a change to the settings on the next message", () =>
    Effect.gen(function* () {
      const bot = yield* start({ settings: { ...DEFAULT_SETTINGS, enabled: false } });

      yield* bot.send(mention("200.0", "hi"));
      yield* bot.history.setSettings(Option.some(DEFAULT_SETTINGS));
      yield* bot.send(mention("210.0", "hi again"));

      assert.deepStrictEqual(yield* bot.outcomes, ["replied:mention"]);
    }),
  );

  it.effect("keeps every reaction on its posts, raw, while switched on", () =>
    Effect.gen(function* () {
      const bot = yield* start();

      yield* bot.send(reaction("reaction_added"), reaction("reaction_removed"));

      assert.deepStrictEqual(
        Array.map(yield* bot.history.reactions, ({ emoji, added, itemTs }) => ({
          emoji,
          added,
          itemTs,
        })),
        [
          { emoji: "joy", added: true, itemTs: BANTER_TS },
          { emoji: "joy", added: false, itemTs: BANTER_TS },
        ],
      );
    }),
  );

  it.effect("only answers the latest message in a thread that's waiting its turn", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();

      const bot = yield* start({
        decide: clefSays("react"),
        write: Deferred.await(release).pipe(Effect.as(Option.some(written))),
      });

      yield* bot.send(mention("200.0", "slow one"));
      yield* bot.send(threadReply("210.0", "first"), threadReply("211.0", "second"));
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 millis");

      assert.deepStrictEqual(yield* bot.outcomes, [
        "ignored:superseded",
        "replied:mention",
        "reacted:clef",
      ]);
      assert.deepStrictEqual(yield* bot.slack.reactions, [[OFFICE, "211.0", "raised_hands"]]);
    }),
  );

  it.effect("doesn't let chatter push out a mention that's waiting", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();

      const bot = yield* start({
        decide: clefSays("react"),
        write: Deferred.await(release).pipe(Effect.as(Option.some(written))),
      });

      yield* bot.send(mention("200.0", "slow one", { channel: OFFICE }));
      yield* bot.send(
        mention("210.0", "a question", { thread_ts: BANTER_TS }),
        threadReply("211.0", "lol"),
      );
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 millis");

      assert.deepStrictEqual(yield* bot.outcomes, [
        "replied:mention",
        "replied:mention",
        "reacted:clef",
      ]);
    }),
  );

  it.effect("skips a message that waited too long for its turn", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();

      const bot = yield* start({
        decide: clefSays("react"),
        write: Deferred.await(release).pipe(Effect.as(Option.some(written))),
      });

      yield* bot.send(mention("200.0", "slow one"));
      yield* bot.send(threadReply("210.0", "haha"));
      yield* TestClock.adjust("3 minutes");
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 millis");

      assert.deepStrictEqual(yield* bot.outcomes, ["replied:mention", "ignored:stale"]);
      assert.deepStrictEqual(yield* bot.slack.reactions, []);
    }),
  );

  it.effect("serves threads in the order they first spoke", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();

      const bot = yield* start({
        decide: clefSays("react"),
        write: Deferred.await(release).pipe(Effect.as(Option.some(written))),
        slack: {
          threads: new Map([
            [BANTER_TS, banterThread],
            ["500.0", [{ ts: "500.0", userId: BOT_USER_ID, text: "⏰" }]],
          ]),
        },
      });

      yield* bot.send(mention("200.0", "slow one"));
      yield* bot.send(
        threadReply("510.0", "other thread", { thread_ts: "500.0" }),
        threadReply("210.0", "banter thread"),
        threadReply("511.0", "other thread again", { thread_ts: "500.0" }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 millis");

      assert.deepStrictEqual(
        Array.map(yield* bot.slack.reactions, ([, ts]) => ts),
        ["511.0", "210.0"],
      );
    }),
  );

  it.effect("stays quiet and carries on when Clef fails, reporting a warning", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        decide: () => Effect.fail(ClefFailed.make({ reason: "Timeout" })),
      });

      yield* bot.send(threadReply("200.0", "haha"));
      yield* bot.send(mention("210.0", "still there?"));

      assert.deepStrictEqual(yield* bot.outcomes, ["ignored:clef_failed", "replied:mention"]);
      assert.deepStrictEqual(
        Array.map(bot.reports, ({ name, severity }) => ({ name, severity })),
        [{ name: "ClefFailed", severity: "Warn" }],
      );
    }),
  );

  it.effect("doesn't report Clef missing when Cloudflare isn't configured", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        decide: () => Effect.fail(ClefFailed.make({ reason: "NotConfigured" })),
      });

      yield* bot.send(threadReply("200.0", "haha"));

      assert.deepStrictEqual(yield* bot.outcomes, ["ignored:clef_failed"]);
      assert.deepStrictEqual(bot.reports, []);
    }),
  );

  it.effect("stays quiet when no model can write the reply", () =>
    Effect.gen(function* () {
      const bot = yield* start({ write: Effect.succeedNone });

      yield* bot.send(mention("200.0", "hi"));

      assert.deepStrictEqual(yield* bot.slack.posts, []);
      assert.deepStrictEqual(yield* bot.outcomes, ["ignored:no_model"]);
    }),
  );

  it.effect("carries on with the next message when Slack rejects a reply", () =>
    Effect.gen(function* () {
      const bot = yield* start({
        decide: clefSays("react"),
        slack: { postFailure: AccessRevoked.make({ error: "not_in_channel" }) },
      });

      yield* bot.send(mention("200.0", "hi"));
      yield* bot.send(threadReply("210.0", "haha"));

      assert.deepStrictEqual(yield* bot.slack.reactions, [[OFFICE, "210.0", "raised_hands"]]);
      assert.deepStrictEqual(yield* bot.outcomes, ["reacted:clef"]);
    }),
  );
});
