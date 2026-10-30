import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Effect, Layer, Option, Redacted, Result } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpClientRequest, HttpServer } from "effect/http";
import { HttpApiMiddleware, HttpApiTest } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { type BusyHour, OfficeStatsReader } from "recording-requests/OfficeStats";
import {
  CurrentRequester,
  RecordingApi,
  SignedIn,
  Unauthorized,
} from "recording-requests/RecordingApi";
import { StatsHandlers } from "recording-requests/StatsHandlers";

import { ActivityLog } from "../src/ActivityLog.ts";
import { columnNaming, Database } from "../src/Database.ts";
import { NO_VOICE_DETAILS, type VoiceDetails } from "../src/OfficeEvent.ts";
import type { TimedVoiceEffect } from "../src/VoiceEffect.ts";
import type { VoiceObservation } from "../src/VoiceObservation.ts";

const OFFICE = "office";

const EARLIER_SESSION = "0b8f8a52-61a4-4b8e-9a43-2f7d0f2f6a01";

const SESSION = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const TestLayer = Layer.mergeAll(OfficeStatsReader.layer, ActivityLog.layer).pipe(
  Layer.provideMerge(Database.layerNoDeps()),
  Layer.provideMerge(PgliteClient.layer(columnNaming)),
);

const at = (iso: string) => DateTime.makeUnsafe(iso);

const inVoice = (overrides: Partial<VoiceDetails> = {}): VoiceDetails => ({
  ...NO_VOICE_DETAILS,
  selfMute: false,
  selfDeaf: false,
  selfVideo: false,
  streaming: false,
  ...overrides,
});

const observation = (
  iso: string,
  userId: string,
  overrides: Partial<VoiceObservation> = {},
): VoiceObservation => ({
  source: "update",
  officeChannelId: OFFICE,
  userId,
  displayName: userId,
  avatarUrl: null,
  guildId: "g1",
  isBot: false,
  oldChannelId: OFFICE,
  newChannelId: OFFICE,
  oldDetails: inVoice(),
  newDetails: inVoice(),
  at: at(iso),
  ...overrides,
});

const joins = (iso: string, userId: string) =>
  observation(iso, userId, { oldChannelId: null, oldDetails: NO_VOICE_DETAILS });

const leaves = (iso: string, userId: string) =>
  observation(iso, userId, { newChannelId: null, newDetails: NO_VOICE_DETAILS });

const mutes = (iso: string, userId: string) =>
  observation(iso, userId, { newDetails: inVoice({ selfMute: true }) });

const record = Effect.fnUntraced(function* (
  session: string,
  ...observations: ReadonlyArray<VoiceObservation>
) {
  const log = yield* ActivityLog;

  yield* Effect.forEach(
    observations,
    (seen) => log.record(session, SecureRandom.uuidV4Unsafe(), seen),
    { discard: true },
  );
});

const effect = (
  iso: string,
  userId: string,
  overrides: Partial<TimedVoiceEffect>,
): TimedVoiceEffect => ({
  userId,
  displayName: userId,
  isBot: false,
  guildId: "g1",
  channelId: OFFICE,
  soundId: null,
  soundName: null,
  soundVolume: null,
  emojiId: null,
  emojiName: null,
  emojiAnimated: null,
  animationType: null,
  animationId: null,
  at: at(iso),
  ...overrides,
});

const plays = (iso: string, userId: string, soundName: string | null) =>
  effect(iso, userId, { soundId: soundName ?? "1234567890", soundName });

const reacts = (iso: string, userId: string, emojiName: string) =>
  effect(iso, userId, { emojiName });

const recordEffects = Effect.fnUntraced(function* (...effects: ReadonlyArray<TimedVoiceEffect>) {
  const log = yield* ActivityLog;

  yield* Effect.forEach(
    effects,
    (sent) => log.recordEffect(SESSION, SecureRandom.uuidV4Unsafe(), sent),
    { discard: true },
  );
});

const recording = Effect.fnUntraced(function* (
  startedAt: string,
  stoppedAt: string | null,
  startedBy: string,
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO office.recordings ${sql.insert({
      id: SecureRandom.uuidV4Unsafe(),
      guildId: "g1",
      channelId: OFFICE,
      startedAt: DateTime.toDateUtc(at(startedAt)),
      startedBy,
      stoppedAt: stoppedAt === null ? null : DateTime.toDateUtc(at(stoppedAt)),
    })}
  `;
});

const peopleAt = (hours: ReadonlyArray<typeof BusyHour.Type>, weekday: number, hour: number) =>
  Option.getOrUndefined(
    Option.map(
      Array.findFirst(hours, (busy) => busy.weekday === weekday && busy.hour === hour),
      (busy) => busy.people,
    ),
  );

const now = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(at(iso)));

const hours = (count: number) => count * 3600;

const aBusyFortnight = Effect.gen(function* () {
  const database = yield* Database;
  const log = yield* ActivityLog;

  yield* database.ready;
  yield* log.startSession(EARLIER_SESSION, at("2026-10-22T06:00:00Z"));
  yield* record(
    EARLIER_SESSION,
    joins("2026-10-22T07:00:00Z", "alan"),
    joins("2026-10-22T07:30:00Z", "linus"),
    leaves("2026-10-22T07:45:00Z", "linus"),
    mutes("2026-10-22T08:00:00Z", "alan"),
  );

  yield* log.startSession(SESSION, at("2026-10-23T06:00:00Z"));
  yield* record(
    SESSION,
    joins("2026-10-23T07:00:00Z", "linus"),
    leaves("2026-10-23T08:00:00Z", "linus"),
    joins("2026-10-26T07:00:00Z", "ada"),
    joins("2026-10-26T07:30:00Z", "grace"),
    leaves("2026-10-26T09:00:00Z", "ada"),
    leaves("2026-10-26T10:00:00Z", "grace"),
    joins("2026-10-27T08:00:00Z", "grace"),
    joins("2026-10-27T08:30:00Z", "ada"),
    leaves("2026-10-27T10:30:00Z", "grace"),
  );

  yield* recordEffects(
    plays("2026-10-23T07:10:00Z", "linus", "airhorn"),
    plays("2026-10-26T07:10:00Z", "ada", "airhorn"),
    plays("2026-10-26T07:20:00Z", "ada", "airhorn"),
    plays("2026-10-26T07:40:00Z", "grace", "airhorn"),
    plays("2026-10-26T07:50:00Z", "grace", "bruh"),
    plays("2026-10-27T08:10:00Z", "grace", null),
    reacts("2026-10-26T07:15:00Z", "ada", "🎉"),
    reacts("2026-10-26T07:16:00Z", "ada", "🎉"),
    reacts("2026-10-27T09:00:00Z", "grace", "👍"),
  );

  yield* recording("2026-10-23T07:05:00Z", "2026-10-23T07:35:00Z", "linus");
  yield* recording("2026-10-26T07:40:00Z", "2026-10-26T08:40:00Z", "ada");
  yield* recording("2026-10-27T11:30:00Z", null, "ada");

  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE office.members SET real_name = 'Ada Lovelace' WHERE user_id = 'ada'`;

  yield* now("2026-10-27T12:00:00Z");
});

describe("OfficeStatsReader", () => {
  it.effect("adds up this week in office time, with whoever is still in counted until now", () =>
    Effect.gen(function* () {
      yield* aBusyFortnight;

      const reader = yield* OfficeStatsReader;
      const stats = yield* reader.stats("week");

      assert.deepStrictEqual(stats.since, at("2026-10-25T22:00:00Z"));
      assert.deepStrictEqual(stats.until, at("2026-10-27T12:00:00Z"));
      assert.deepStrictEqual(stats.timeInOffice, [
        { userId: "ada", name: "Ada Lovelace", seconds: hours(5.5), days: 2 },
        { userId: "grace", name: "grace", seconds: hours(5), days: 2 },
      ]);
      assert.deepStrictEqual(stats.firstIn, [
        { userId: "ada", name: "Ada Lovelace", days: 1 },
        { userId: "grace", name: "grace", days: 1 },
      ]);
      assert.deepStrictEqual(stats.lastOut, [{ userId: "grace", name: "grace", days: 1 }]);
      assert.deepStrictEqual(stats.sounds, [
        { sound: "airhorn", plays: 3 },
        { sound: "bruh", plays: 1 },
      ]);
      assert.deepStrictEqual(stats.players, [
        { userId: "grace", name: "grace", plays: 3 },
        { userId: "ada", name: "Ada Lovelace", plays: 2 },
      ]);
      assert.deepStrictEqual(stats.reactions, [
        { emoji: "🎉", reactions: 2 },
        { emoji: "👍", reactions: 1 },
      ]);
      assert.deepStrictEqual(stats.recordings, { count: 2, seconds: hours(1.5) });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shows how many people were in each weekday and hour, in office time", () =>
    Effect.gen(function* () {
      yield* aBusyFortnight;

      const reader = yield* OfficeStatsReader;
      const { busiestHours } = yield* reader.stats("week");

      const cell = (weekday: number, hour: number) => peopleAt(busiestHours, weekday, hour);

      assert.strictEqual(busiestHours.length, 24 + 15);
      assert.strictEqual(cell(1, 8), 0);
      assert.strictEqual(cell(1, 9), 1.5);
      assert.strictEqual(cell(1, 10), 2);
      assert.strictEqual(cell(1, 11), 1);
      assert.strictEqual(cell(1, 12), 0);
      assert.strictEqual(cell(2, 10), 1.5);
      assert.strictEqual(cell(2, 11), 2);
      assert.strictEqual(cell(2, 12), 1.5);
      assert.strictEqual(cell(2, 13), 1);
      assert.strictEqual(cell(2, 14), 0);
      assert.isUndefined(cell(3, 9));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "averages each weekday and hour over the month, ending a stay where the bot stopped watching",
    () =>
      Effect.gen(function* () {
        yield* aBusyFortnight;

        const reader = yield* OfficeStatsReader;
        const stats = yield* reader.stats("month");

        assert.deepStrictEqual(stats.since, at("2026-09-30T22:00:00Z"));
        assert.deepStrictEqual(stats.timeInOffice, [
          { userId: "ada", name: "Ada Lovelace", seconds: hours(5.5), days: 2 },
          { userId: "grace", name: "grace", seconds: hours(5), days: 2 },
          { userId: "linus", name: "linus", seconds: hours(1.25), days: 2 },
          { userId: "alan", name: "alan", seconds: hours(1), days: 1 },
        ]);
        assert.deepStrictEqual(stats.firstIn, [
          { userId: "ada", name: "Ada Lovelace", days: 1 },
          { userId: "alan", name: "alan", days: 1 },
          { userId: "grace", name: "grace", days: 1 },
          { userId: "linus", name: "linus", days: 1 },
        ]);
        assert.deepStrictEqual(stats.lastOut, [
          { userId: "alan", name: "alan", days: 1 },
          { userId: "grace", name: "grace", days: 1 },
          { userId: "linus", name: "linus", days: 1 },
        ]);
        assert.strictEqual(peopleAt(stats.busiestHours, 4, 9), 0.31);
        assert.deepStrictEqual(stats.sounds[0], { sound: "airhorn", plays: 4 });
        assert.deepStrictEqual(stats.recordings, { count: 3, seconds: hours(2) });
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("starts all time at the first stay it knows of", () =>
    Effect.gen(function* () {
      yield* aBusyFortnight;

      const reader = yield* OfficeStatsReader;
      const stats = yield* reader.stats("all");

      assert.isNull(stats.since);
      assert.deepStrictEqual(
        Array.filterMap(stats.busiestHours, (busy) =>
          busy.weekday === 4 ? Result.succeed(busy.hour) : Result.failVoid,
        ),
        [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
      );
      assert.strictEqual(peopleAt(stats.busiestHours, 4, 9), 1.25);
      assert.strictEqual(stats.timeInOffice.length, 4);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("only counts the part of a stay inside the range", () =>
    Effect.gen(function* () {
      const database = yield* Database;
      const log = yield* ActivityLog;

      yield* database.ready;
      yield* log.startSession(SESSION, at("2026-10-25T18:00:00Z"));
      yield* record(
        SESSION,
        joins("2026-10-25T21:00:00Z", "grace"),
        leaves("2026-10-26T00:00:00Z", "grace"),
      );
      yield* now("2026-10-26T12:00:00Z");

      const reader = yield* OfficeStatsReader;
      const stats = yield* reader.stats("week");

      assert.deepStrictEqual(stats.timeInOffice, [
        { userId: "grace", name: "grace", seconds: hours(2), days: 1 },
      ]);
      assert.deepStrictEqual(stats.firstIn, []);
      assert.deepStrictEqual(stats.lastOut, [{ userId: "grace", name: "grace", days: 1 }]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("has nothing to count in an empty office", () =>
    Effect.gen(function* () {
      const database = yield* Database;

      yield* database.ready;
      yield* now("2026-10-26T12:00:00Z");

      const reader = yield* OfficeStatsReader;
      const stats = yield* reader.stats("all");

      assert.deepStrictEqual(stats.timeInOffice, []);
      assert.deepStrictEqual(stats.busiestHours, []);
      assert.deepStrictEqual(stats.recordings, { count: 0, seconds: 0 });
    }).pipe(Effect.provide(TestLayer)),
  );
});

const ada = { id: "ada", name: "Ada" };

const SignedInTest = Layer.succeed(
  SignedIn,
  SignedIn.of({
    session: (httpEffect, { credential }) =>
      Redacted.value(credential) === "ada-session"
        ? Effect.provideService(httpEffect, CurrentRequester, ada)
        : Effect.fail(Unauthorized.make()),
  }),
);

const withSession = (session: string) =>
  HttpApiMiddleware.layerClient(SignedIn, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, session)),
  );

const HttpLayer = Layer.mergeAll(
  StatsHandlers.pipe(Layer.provideMerge(TestLayer), Layer.provideMerge(SignedInTest)),
  HttpServer.layerServices,
);

describe("GET /api/stats", () => {
  it.effect("sends the stats for the asked range to someone signed in", () =>
    Effect.gen(function* () {
      yield* (yield* Database).ready;
      yield* now("2026-10-27T12:00:00Z");

      const client = yield* HttpApiTest.groups(RecordingApi, ["stats"]);
      const stats = yield* client.stats.office({ query: { range: "month" } });

      assert.strictEqual(stats.range, "month");
      assert.deepStrictEqual(stats.since, at("2026-09-30T22:00:00Z"));
      assert.deepStrictEqual(stats.recordings, { count: 0, seconds: 0 });
    }).pipe(Effect.provide(Layer.mergeAll(withSession("ada-session"), HttpLayer))),
  );

  it.effect("turns away anyone without a valid session", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(RecordingApi, ["stats"]);

      const error = yield* client.stats.office({ query: { range: "week" } }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(Layer.mergeAll(withSession("someone-else"), HttpLayer))),
  );
});
