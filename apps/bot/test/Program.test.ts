import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  type Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  type LogLevel,
  Option,
  Queue,
  Record,
  References,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import type { BotPresence } from "../src/BotPresence.ts";
import { OfficeHistory } from "../src/OfficeHistory.ts";
import { MainLayer, program } from "../src/Program.ts";
import { NO_VOICE_DETAILS, type VoiceStateUpdate } from "../src/OfficeEvent.ts";
import type { VoiceEffect } from "../src/VoiceEffect.ts";
import {
  firstVariant,
  hang,
  makeFakeRecorder,
  makeFakeSlack,
  ok,
  type Reply,
  SLACK_ENV,
  slackError,
  withEnv,
  gatewayWithSeat,
} from "./fakes.ts";

const OFFICE = "office";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const GUILD = "guild";

const env = {
  DISCORD_BOT_TOKEN: "discord-token",
  DISCORD_OFFICE_CHANNEL_ID: OFFICE,
  ...SLACK_ENV,
};

const update = (overrides: Partial<VoiceStateUpdate> = {}): VoiceStateUpdate => ({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png",
  guildId: GUILD,
  oldChannelId: null,
  newChannelId: OFFICE,
  isBot: false,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  ...overrides,
});

const SELF = "self";

const effect = (overrides: Partial<VoiceEffect> = {}): VoiceEffect => ({
  userId: "u1",
  displayName: "Ada",
  isBot: false,
  guildId: GUILD,
  channelId: OFFICE,
  soundId: "1",
  soundName: "quack",
  soundVolume: 1,
  emojiId: null,
  emojiName: "🦆",
  emojiAnimated: false,
  animationType: null,
  animationId: null,
  ...overrides,
});

interface LogEntry {
  readonly level: LogLevel.LogLevel;
  readonly message: string;
  readonly annotations: Readonly<Record<string, string>>;
}

// Runs the program over the given voice state updates until the queue ends,
// starting with `present` already in the office, and returns what was posted
// to Slack, what was recorded, where the bot moved and what was logged.
const runProgram = Effect.fnUntraced(function* (
  updates: ReadonlyArray<VoiceStateUpdate>,
  replies: ReadonlyArray<Reply> = [ok],
  present: ReadonlyArray<VoiceStateUpdate> = [],
  effects: ReadonlyArray<VoiceEffect> = [],
  responder: Layer.Layer<never> = Layer.empty,
) {
  const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
  const moves = yield* Queue.unbounded<BotPresence>();

  yield* Queue.offerAll(queue, updates);
  yield* Queue.end(queue);

  const slack = yield* makeFakeSlack(replies);
  const recorder = yield* makeFakeRecorder();
  const logs: Array<LogEntry> = [];

  const captureLogs = Logger.make<unknown, void>((options) => {
    logs.push({
      level: options.logLevel,
      message: String(Array.isArray(options.message) ? options.message[0] : options.message),
      annotations: Record.map(options.fiber.getRef(References.CurrentLogAnnotations), (value) =>
        String(value),
      ),
    });
  });

  yield* program.pipe(
    Effect.provide(
      Layer.mergeAll(
        gatewayWithSeat({
          updates: queue,
          occupants: new Set(Array.map(present, (update) => update.userId)),
          guildId: GUILD,
          present,
          effects,
          moves,
          selfId: SELF,
        }),
        slack.layer,
        recorder.layer,
        OfficeHistory.layerDisabled,
        responder,
        Logger.layer([captureLogs]),
      ),
    ),
    withEnv(env),
    firstVariant,
  );

  return {
    posted: yield* slack.postedTexts,
    bodies: yield* slack.postedBodies,
    recorded: yield* recorder.recorded,
    recordedEffects: yield* recorder.recordedEffects,
    moves: yield* Queue.clear(moves),
    logs,
  };
});

const OPENED = "🎙️ *Ada* opened the virtual office — everyone's welcome to join!";

const EMPTIED = "🪑 The virtual office is empty right now — jump in and get it going!";

const leave = (overrides: Partial<VoiceStateUpdate> = {}) =>
  update({ oldChannelId: OFFICE, newChannelId: null, ...overrides });

describe("program", () => {
  it.effect("1. announces the first join from outside voice with name and join link", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: null })]);

      assert.deepStrictEqual(posted, [OPENED]);
    }),
  );

  it.effect("posts a card with a join button and a recap when the office empties", () =>
    Effect.gen(function* () {
      const { bodies } = yield* runProgram([
        update(),
        update({ userId: "u2" }),
        leave({ userId: "u2" }),
        leave(),
      ]);

      const cards = yield* encodeJson(bodies);
      assert.include(cards, `"url":"https://discord.com/channels/${GUILD}/${OFFICE}"`);
      assert.include(cards, `"image_url":"https://cdn.discordapp.com/avatars/u1/a.png"`);
      assert.include(cards, "*Stopped by*\\n2 people");
    }),
  );

  it.effect("2. announces the office opening on a move in from another voice channel", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: "lobby" })]);

      assert.deepStrictEqual(posted, [OPENED]);
    }),
  );

  it.effect("3. ignores mute, deafen and video changes inside the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram(
        [update({ oldChannelId: OFFICE, newChannelId: OFFICE })],
        [ok],
        [update()],
      );

      assert.deepStrictEqual(posted, []);
    }),
  );

  it.effect("4. ignores bots joining and leaving the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ isBot: true }), leave({ isBot: true })]);

      assert.deepStrictEqual(posted, []);
    }),
  );

  it.effect("5. ignores other voice channels", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([
        update({ newChannelId: "lobby" }),
        update({ oldChannelId: "lobby", newChannelId: null }),
      ]);

      assert.deepStrictEqual(posted, []);
    }),
  );

  it.effect("6. shows a display name with <, > and & literally without pinging", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ displayName: "<!channel> & <@U1>" })]);

      assert.include(posted[0], "*&lt;!channel&gt; &amp; &lt;@U1&gt;*");
      assert.notInclude(posted[0], "<!channel>");
    }),
  );

  it.effect("7. only announces the office opening and emptying, not everyone in between", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([
        update({ userId: "u1", displayName: "Ada" }),
        update({ userId: "u2", displayName: "Grace" }),
        leave({ userId: "u1", displayName: "Ada" }),
        update({ userId: "u3", displayName: "Linus" }),
        leave({ userId: "u2", displayName: "Grace" }),
        leave({ userId: "u3", displayName: "Linus", newChannelId: "lobby" }),
      ]);

      assert.deepStrictEqual(posted, [OPENED, EMPTIED]);
    }),
  );

  it.effect("8. logs revoked Slack access as an error and keeps handling events", () =>
    Effect.gen(function* () {
      const { posted, logs } = yield* runProgram(
        [update(), leave()],
        [slackError("invalid_auth"), ok],
      );

      assert.strictEqual(posted.length, 2);

      const failure = Option.getOrThrow(Array.findFirst(logs, (entry) => entry.level === "Error"));
      assert.strictEqual(failure.message, "Slack rejected the post");
      assert.deepInclude(failure.annotations, {
        reason: "AccessRevoked",
        event: "Opened",
        userId: "<redacted>",
      });

      const success = Option.getOrThrow(
        Array.findFirst(logs, (entry) => entry.message === "Announced office event"),
      );

      assert.deepInclude(success.annotations, {
        event: "Emptied",
        outcome: "posted",
        userId: "<redacted>",
      });
    }),
  );

  it.effect("reopens the office after it emptied", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update(), leave(), update()]);

      assert.deepStrictEqual(posted, [OPENED, EMPTIED, OPENED]);
    }),
  );

  it.effect("doesn't announce opening when people were already in the office at startup", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram(
        [
          update({ userId: "u2", displayName: "Grace" }),
          leave({ userId: "u2" }),
          leave({ userId: "u1" }),
        ],
        [ok],
        [update()],
      );

      assert.deepStrictEqual(posted, [EMPTIED]);
    }),
  );
});

describe("recording", () => {
  it.effect("records who was already there, then every update touching the office", () =>
    Effect.gen(function* () {
      const { recorded } = yield* runProgram(
        [
          update({ userId: "u2", displayName: "Grace" }),
          update({ userId: "u2", oldChannelId: OFFICE, newChannelId: OFFICE }),
          update({ userId: "u3", newChannelId: "lobby" }),
          update({ userId: "bot", isBot: true }),
          leave({ userId: "u2", newChannelId: "lobby" }),
        ],
        [ok],
        [update()],
      );

      assert.deepStrictEqual(
        Array.map(recorded, ({ source, userId, oldChannelId, newChannelId }) => ({
          source,
          userId,
          oldChannelId,
          newChannelId,
        })),
        [
          { source: "startup", userId: "u1", oldChannelId: null, newChannelId: OFFICE },
          { source: "update", userId: "u2", oldChannelId: null, newChannelId: OFFICE },
          { source: "update", userId: "u2", oldChannelId: OFFICE, newChannelId: OFFICE },
          { source: "update", userId: "u2", oldChannelId: OFFICE, newChannelId: "lobby" },
        ],
      );
    }),
  );

  it.effect(
    "records soundboard sounds and emoji in the office, leaving out bots and other channels",
    () =>
      Effect.gen(function* () {
        const { recordedEffects } = yield* runProgram(
          [],
          [ok],
          [],
          [
            effect(),
            effect({
              userId: "u2",
              soundId: null,
              soundName: null,
              soundVolume: null,
              emojiName: "🎉",
            }),
            effect({ channelId: "lobby" }),
            effect({ userId: "bot", isBot: true }),
          ],
        );

        assert.deepStrictEqual(
          Array.map(recordedEffects, ({ userId, soundName, emojiName }) => ({
            userId,
            soundName,
            emojiName,
          })),
          [
            { userId: "u1", soundName: "quack", emojiName: "🦆" },
            { userId: "u2", soundName: null, emojiName: "🎉" },
          ],
        );
      }),
  );

  it.effect("keeps recording while a Slack post is being retried", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      const slack = yield* makeFakeSlack([hang]);
      const recorder = yield* makeFakeRecorder();

      const fiber = yield* program.pipe(
        Effect.provide(
          Layer.mergeAll(
            gatewayWithSeat({ updates: queue }),
            slack.layer,
            recorder.layer,
            OfficeHistory.layerDisabled,
          ),
        ),
        withEnv(env),
        firstVariant,
        Effect.forkChild,
      );

      // The first post never answers, so the office events stall behind it.
      yield* Queue.offerAll(queue, [update(), leave(), update()]);

      yield* recorder.awaitRecorded(3);

      yield* Fiber.interrupt(fiber);
    }),
  );
});

describe("bot presence", () => {
  it.effect(
    "never announces or records the bot itself, even when Discord leaves out that it's a bot",
    () =>
      Effect.gen(function* () {
        const { posted, recorded, recordedEffects, moves } = yield* runProgram(
          [
            update({ userId: SELF, displayName: "Notifier" }),
            leave({ userId: SELF, displayName: "Notifier" }),
          ],
          [ok],
          [],
          [effect({ userId: SELF, displayName: "Notifier" })],
        );

        assert.deepStrictEqual(posted, []);
        assert.deepStrictEqual(recorded, []);
        assert.deepStrictEqual(recordedEffects, []);
        assert.deepStrictEqual(moves, ["Away"]);
      }),
  );

  it.effect("stays out of an empty office, joins when it opens and leaves when it empties", () =>
    Effect.gen(function* () {
      const { moves } = yield* runProgram([
        update(),
        update({ userId: "u2" }),
        leave(),
        update({ userId: "bot", isBot: true }),
        leave({ userId: "u2" }),
        update(),
      ]);

      assert.deepStrictEqual(moves, ["Away", "InOffice", "Away", "InOffice"]);
    }),
  );

  it.effect("joins straight away when people are already in the office at startup", () =>
    Effect.gen(function* () {
      const { moves } = yield* runProgram([leave()], [ok], [update()]);

      assert.deepStrictEqual(moves, ["InOffice", "Away"]);
    }),
  );
});

describe("daily reminder", () => {
  it.effect("posts the reminder to Slack while watching the office", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      const slack = yield* makeFakeSlack([ok]);
      const recorder = yield* makeFakeRecorder();

      const fiber = yield* program.pipe(
        Effect.provide(
          Layer.mergeAll(
            gatewayWithSeat({ updates: queue }),
            slack.layer,
            recorder.layer,
            OfficeHistory.layerDisabled,
          ),
        ),
        withEnv(env),
        firstVariant,
        Effect.forkChild,
      );

      // The scheduled streams start their timers in forked fibers, so they get
      // a chance to start before the clock moves.
      yield* Effect.repeat(Effect.yieldNow, { times: 10 });

      // The test clock starts on a Thursday, so the first reminder is at 09:15Z.
      yield* TestClock.adjust("10 hours");
      yield* Queue.end(queue);
      yield* Fiber.join(fiber);

      // Reminders rotate by date, and that Thursday picks the fourth phrasing.
      assert.deepStrictEqual(yield* slack.postedTexts, [
        "🪴 The office plant is lonely. It's been talking to itself again. Come keep it company!",
      ]);
    }),
  );
});

describe("program and the Slack responder", () => {
  it.effect("runs the responder alongside, and ends when the Discord events do", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const responder = Layer.effectDiscard(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.forkScoped),
      );

      const { posted } = yield* runProgram([update()], [ok], [], [], responder);

      assert.strictEqual(posted.length, 1);
      assert.isTrue(yield* Deferred.isDone(started));
    }),
  );
});

describe("MainLayer", () => {
  const { SLACK_BOT_TOKEN: _slack, ...withoutSlack } = env;
  const { DISCORD_OFFICE_CHANNEL_ID: _office, ...withoutOffice } = env;

  it.effect.each([
    { missing: "SLACK_BOT_TOKEN", env: withoutSlack },
    { missing: "DISCORD_OFFICE_CHANNEL_ID", env: withoutOffice },
  ])("9. fails at startup naming a missing $missing", ({ missing, env }) =>
    Effect.gen(function* () {
      const error = yield* Layer.build(MainLayer).pipe(Effect.scoped, withEnv(env), Effect.flip);

      assert.include(String(error), missing);
    }),
  );
});
