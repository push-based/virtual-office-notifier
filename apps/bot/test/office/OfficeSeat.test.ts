import { assert, describe, it } from "@effect/vitest";
import { Effect, Queue, Ref, Stream } from "effect";

import {
  OfficeSeat,
  PAUSED_NICKNAME,
  RECORDING_NICKNAME,
  type SeatAdapter,
} from "../../src/office/OfficeSeat.ts";

const setUp = Effect.gen(function* () {
  const moves = yield* Ref.make<ReadonlyArray<string>>([]);
  const nicknames = yield* Ref.make<ReadonlyArray<string | null>>([]);
  const reconnects = yield* Queue.unbounded<void>();

  const adapter: SeatAdapter = {
    join: (listening) =>
      Ref.update(moves, (all) => [...all, listening ? "listen" : "join deafened"]),
    leave: Ref.update(moves, (all) => [...all, "leave"]),
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
  it.effect("joins the office deafened when it's wanted there and leaves when it's not", () =>
    Effect.gen(function* () {
      const { seat, moves } = yield* setUp;

      yield* seat.want("InOffice");
      yield* seat.want("Away");

      assert.deepStrictEqual(yield* moves, ["join deafened", "leave"]);
    }),
  );

  it.effect("listens on the same seat while recording, and is renamed", () =>
    Effect.gen(function* () {
      const { seat, moves, nicknames } = yield* setUp;

      yield* seat.want("InOffice");
      yield* seat.record("Capturing");

      assert.deepStrictEqual(yield* moves, ["join deafened", "listen"]);
      assert.deepStrictEqual(yield* nicknames, [RECORDING_NICKNAME]);
    }),
  );

  it.effect("keeps listening while capturing, then deafens or leaves when it pauses or stops", () =>
    Effect.gen(function* () {
      const { seat, moves, nicknames } = yield* setUp;

      yield* seat.want("InOffice");
      yield* seat.record("Capturing");
      yield* seat.want("Away");
      yield* seat.record("Paused");
      yield* seat.record("Off");

      assert.deepStrictEqual(yield* moves, ["join deafened", "listen", "listen", "leave", "leave"]);
      assert.deepStrictEqual(yield* nicknames, [RECORDING_NICKNAME, PAUSED_NICKNAME, null]);
    }),
  );

  it.effect("goes back where it should be when Discord reconnects, listening if it was", () =>
    Effect.gen(function* () {
      const { seat, moves, reconnect } = yield* setUp;

      yield* seat.want("InOffice");
      yield* reconnect;

      assert.deepStrictEqual(yield* moves, ["join deafened", "join deafened"]);

      yield* seat.record("Capturing");
      yield* reconnect;

      assert.deepStrictEqual(yield* moves, ["join deafened", "join deafened", "listen", "listen"]);
    }),
  );
});
