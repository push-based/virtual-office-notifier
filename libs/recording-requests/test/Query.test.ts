import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Schema, String } from "effect";
import { TestClock } from "effect/testing";

import { guardQuery, QUERY_TIMEOUT } from "../src/Query.ts";

class Unavailable extends Schema.TaggedError<Unavailable, { readonly brand: unique symbol }>()(
  "Unavailable",
  { reason: Schema.String },
) {}

class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()(
  "Refused",
  {},
) {
  override get message(): string {
    return "connection refused";
  }
}

const unavailable = (reason: string) => Unavailable.make({ reason });

describe("guardQuery", () => {
  it.effect("waits until the database is ready before running the query", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const guarded = guardQuery({ ready: Deferred.await(ready), unavailable });
      const fiber = yield* guarded(Effect.succeed("rows")).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isUndefined(fiber.pollUnsafe());

      yield* Deferred.succeed(ready, undefined);

      assert.strictEqual(yield* Fiber.join(fiber), "rows");
    }),
  );

  it.effect("turns a failed query into the service's error, described by the service", () =>
    Effect.gen(function* () {
      const guarded = guardQuery({
        ready: Effect.void,
        unavailable,
        describe: (error) => `described: ${error.message}`,
      });

      const exit = yield* guarded(Effect.fail(Refused.make())).pipe(Effect.exit);

      assert.deepStrictEqual(exit, Exit.fail(unavailable("described: connection refused")));
    }),
  );

  it.effect("uses the error's message when the service doesn't describe it", () =>
    Effect.gen(function* () {
      const guarded = guardQuery({ ready: Effect.void, unavailable });

      const exit = yield* guarded(Effect.fail(Refused.make())).pipe(Effect.exit);

      assert.deepStrictEqual(exit, Exit.fail(unavailable("connection refused")));
    }),
  );

  it.effect("tells a row that doesn't decode apart from a failed query", () =>
    Effect.gen(function* () {
      const unreadable = (reason: string) => Unavailable.make({ reason: `unreadable: ${reason}` });
      const guarded = guardQuery({ ready: Effect.void, unavailable, unreadable });
      const decodeNumber = Schema.decodeUnknownEffect(Schema.Finite);

      const failed = yield* guarded(Effect.fail(Refused.make())).pipe(Effect.flip);
      const undecodable = yield* guarded(decodeNumber("1")).pipe(Effect.flip);

      assert.strictEqual(failed.reason, "connection refused");
      assert.isTrue(String.startsWith("unreadable: ")(undecodable.reason));
    }),
  );

  it.effect("gives up when the database isn't ready in time", () =>
    Effect.gen(function* () {
      const guarded = guardQuery({ ready: Effect.never, unavailable });
      const fiber = yield* guarded(Effect.succeed("rows")).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.sum(QUERY_TIMEOUT, Duration.millis(1)));

      assert.deepStrictEqual(
        yield* Fiber.await(fiber),
        Exit.fail(unavailable("Timed out after 10 seconds")),
      );
    }),
  );
});
