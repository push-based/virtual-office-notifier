import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Schema, String } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { guardChange, guardQuery, QUERY_TIMEOUT } from "../src/Query.ts";
import { columnNaming } from "../src/SqlNaming.ts";
import { migrated } from "./schema.ts";

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

const notes = Effect.gen(function* () {
  const sql = yield* migrated;

  yield* sql`CREATE TABLE office.notes (text text NOT NULL)`;

  return sql;
});

const noted = (sql: SqlClient.SqlClient) =>
  sql<{ readonly text: string }>`SELECT text FROM office.notes ORDER BY text`;

describe("guardChange", () => {
  it.effect("opens its own transaction when there isn't one, and rolls it back on failure", () =>
    Effect.gen(function* () {
      const sql = yield* notes;
      const change = guardChange({ ready: Effect.void, unavailable }, sql);

      yield* change(sql`INSERT INTO office.notes VALUES ('kept')`);

      const exit = yield* change(
        sql`INSERT INTO office.notes VALUES ('dropped')`.pipe(
          Effect.andThen(Effect.fail(Refused.make())),
        ),
      ).pipe(Effect.exit);

      assert.deepStrictEqual(exit, Exit.fail(unavailable("connection refused")));
      assert.deepStrictEqual(yield* noted(sql), [{ text: "kept" }]);
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect("joins the transaction it's already in, so the whole thing commits or none of it", () =>
    Effect.gen(function* () {
      const sql = yield* notes;
      const change = guardChange({ ready: Effect.void, unavailable }, sql);

      const exit = yield* sql
        .withTransaction(
          change(sql`INSERT INTO office.notes VALUES ('inner')`).pipe(
            Effect.andThen(Effect.fail(Refused.make())),
          ),
        )
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* noted(sql), []);
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect(
    "doesn't wait for the database again or start a second clock inside a transaction",
    () =>
      Effect.gen(function* () {
        const sql = yield* notes;
        const never = yield* Deferred.make<void>();
        const change = guardChange({ ready: Deferred.await(never), unavailable }, sql);

        yield* sql.withTransaction(change(sql`INSERT INTO office.notes VALUES ('inner')`));

        assert.deepStrictEqual(yield* noted(sql), [{ text: "inner" }]);
      }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );
});
