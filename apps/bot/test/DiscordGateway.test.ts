import { assert, describe, it } from "@effect/vitest";
import { Array, type Cause, Effect, Queue, Stream } from "effect";

import { DiscordGateway } from "../src/DiscordGateway.ts";
import { NO_VOICE_DETAILS, type VoiceStateUpdate } from "../src/OfficeEvent.ts";
import { withEnv } from "./fakes.ts";

const OFFICE = "office";

const env = {
  DISCORD_BOT_TOKEN: "discord-token",
  DISCORD_OFFICE_CHANNEL_ID: OFFICE,
};

const join = (overrides: Partial<VoiceStateUpdate> = {}): VoiceStateUpdate => ({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  guildId: "guild",
  oldChannelId: null,
  newChannelId: OFFICE,
  isBot: false,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  ...overrides,
});

const leave = (overrides: Partial<VoiceStateUpdate> = {}) =>
  join({ oldChannelId: OFFICE, newChannelId: null, ...overrides });

const withGateway = <A, E>(
  updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>,
  present: ReadonlyArray<VoiceStateUpdate>,
  use: (gateway: DiscordGateway["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(DiscordGateway, use).pipe(
    Effect.provide(
      DiscordGateway.layerTest({
        updates,
        present,
        occupants: new Set(Array.map(present, (update) => update.userId)),
      }),
    ),
    withEnv(env),
  );

describe("DiscordGateway", () => {
  it.effect("tracks occupancy once and hands every consumer the same office events", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offerAll(queue, [
        join(),
        join({ userId: "u2" }),
        leave(),
        leave({ userId: "u2" }),
      ]);
      yield* Queue.end(queue);

      const [first, second] = yield* withGateway(queue, [], (gateway) =>
        Effect.all(
          [Stream.runCollect(gateway.officeEvents), Stream.runCollect(gateway.officeEvents)],
          {
            concurrency: "unbounded",
          },
        ),
      );

      assert.deepStrictEqual(
        Array.map(first, (event) => event._tag),
        ["Opened", "Emptied"],
      );
      assert.strictEqual(first.length, second.length);
      Array.forEach(first, (event, index) => assert.strictEqual(second[index], event));
    }),
  );

  it.effect("moves the bot from the same occupancy the office events come from", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offerAll(queue, [join(), leave(), leave({ userId: "u2" }), join()]);
      yield* Queue.end(queue);

      const [events, presence] = yield* withGateway(queue, [join()], (gateway) =>
        Effect.all(
          [Stream.runCollect(gateway.officeEvents), Stream.runCollect(gateway.botPresence)],
          {
            concurrency: "unbounded",
          },
        ),
      );

      assert.deepStrictEqual(
        Array.map(events, (event) => event._tag),
        ["Emptied", "Opened"],
      );
      assert.deepStrictEqual(presence, ["InOffice", "Away", "InOffice"]);
    }),
  );

  it.effect("keeps updates that arrive after the gateway starts but before anyone listens", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();

      const { events, observations, presence } = yield* withGateway(queue, [], (gateway) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, join());

          while ((yield* gateway.occupants).length === 0) {
            yield* Effect.yieldNow;
          }

          yield* Queue.end(queue);

          return yield* Effect.all(
            {
              events: Stream.runCollect(gateway.officeEvents),
              observations: Stream.runCollect(gateway.voiceObservations),
              presence: Stream.runCollect(gateway.botPresence),
            },
            { concurrency: "unbounded" },
          );
        }),
      );

      assert.deepStrictEqual(
        Array.map(events, (event) => event._tag),
        ["Opened"],
      );
      assert.deepStrictEqual(
        Array.map(observations, (observation) => [observation.source, observation.userId]),
        [["update", "u1"]],
      );
      assert.deepStrictEqual(presence, ["Away", "InOffice"]);
    }),
  );
});
