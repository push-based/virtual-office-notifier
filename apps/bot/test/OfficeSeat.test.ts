import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { BotMoveError } from "../src/DiscordGateway.ts";
import {
  LEAVE_TIMEOUT,
  OfficeSeat,
  PAUSED_NICKNAME,
  RECORDING_NICKNAME,
  type SeatAdapter,
} from "../src/OfficeSeat.ts";

const OFFICE = "office";

interface Options {
  readonly confirmsLeaving?: boolean;
  readonly connected?: boolean;
}

const setUp = Effect.fnUntraced(function* (options: Options = {}) {
  const moves = yield* Ref.make<ReadonlyArray<string | null>>([]);
  const nicknames = yield* Ref.make<ReadonlyArray<string | null>>([]);
  const channel = yield* Ref.make<string | null>(null);
  const reconnects = yield* Queue.unbounded<void>();

  const adapter: SeatAdapter = {
    officeChannelId: OFFICE,
    move: (channelId) =>
      options.connected === false
        ? Effect.fail(BotMoveError.make({ reason: "Discord isn't connected" }))
        : Ref.update(moves, (all) => [...all, channelId]).pipe(
            Effect.andThen(
              channelId === null && options.confirmsLeaving === false
                ? Effect.void
                : Ref.set(channel, channelId),
            ),
          ),
    inVoice: Effect.map(Ref.get(channel), (current) => current !== null),
    rename: (nickname) => Ref.update(nicknames, (all) => [...all, nickname]),
    reconnected: Stream.fromQueue(reconnects),
  };

  const seat = yield* OfficeSeat.make(adapter);

  return {
    seat,
    moves: Ref.get(moves),
    nicknames: Ref.get(nicknames),
    reconnect: Queue.offer(reconnects, undefined).pipe(Effect.andThen(Effect.yieldNow)),
  };
});

describe("OfficeSeat", () => {
  it.effect("joins the office when it's wanted there and leaves when it's not", () =>
    Effect.gen(function* () {
      const { seat, moves } = yield* setUp();

      yield* seat.want("InOffice");
      yield* seat.want("Away");

      assert.deepStrictEqual(yield* moves, [OFFICE, null]);
    }),
  );

  it.effect("steps out and is renamed while recording, so the audio connection can join", () =>
    Effect.gen(function* () {
      const { seat, moves, nicknames } = yield* setUp();

      yield* seat.want("InOffice");
      yield* seat.record("Capturing");

      assert.deepStrictEqual(yield* moves, [OFFICE, null]);
      assert.deepStrictEqual(yield* nicknames, [RECORDING_NICKNAME]);
    }),
  );

  it.effect(
    "stays put while capturing, then goes where it's wanted when recording pauses or stops",
    () =>
      Effect.gen(function* () {
        const { seat, moves, nicknames } = yield* setUp();

        yield* seat.want("InOffice");
        yield* seat.record("Capturing");
        yield* seat.want("InOffice");
        yield* seat.record("Paused");
        yield* seat.record("Off");

        assert.deepStrictEqual(yield* moves, [OFFICE, null, OFFICE, OFFICE]);
        assert.deepStrictEqual(yield* nicknames, [RECORDING_NICKNAME, PAUSED_NICKNAME, null]);
      }),
  );

  it.effect("goes back where it should be when Discord reconnects, unless it's capturing", () =>
    Effect.gen(function* () {
      const { seat, moves, reconnect } = yield* setUp();

      yield* seat.want("InOffice");
      yield* reconnect;

      assert.deepStrictEqual(yield* moves, [OFFICE, OFFICE]);

      yield* seat.record("Capturing");
      yield* reconnect;

      assert.deepStrictEqual(yield* moves, [OFFICE, OFFICE, null]);
    }),
  );

  it.effect("starts recording anyway when Discord doesn't confirm the bot left", () =>
    Effect.gen(function* () {
      const { seat, nicknames } = yield* setUp({ confirmsLeaving: false });

      yield* seat.want("InOffice");

      const recording = yield* Effect.forkChild(seat.record("Capturing"));

      yield* TestClock.adjust(LEAVE_TIMEOUT);
      yield* Fiber.join(recording);

      assert.deepStrictEqual(yield* nicknames, [RECORDING_NICKNAME]);
    }),
  );

  it.effect("carries on when Discord isn't connected", () =>
    Effect.gen(function* () {
      const { seat, moves } = yield* setUp({ connected: false });

      yield* seat.want("InOffice");
      yield* seat.record("Capturing");

      assert.deepStrictEqual(yield* moves, []);
    }),
  );
});
