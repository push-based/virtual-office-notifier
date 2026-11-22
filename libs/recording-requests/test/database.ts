import { Deferred, Effect, Layer, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { migrations } from "../src/migrations.ts";

const runMigrations = Migrator.make({});

export const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE SCHEMA IF NOT EXISTS office`;
  yield* runMigrations({ loader: migrations, table: "office.migrations" });

  return sql;
});

export const ada = { id: "u1", name: "Ada" };

export const migratedWithAda = Effect.gen(function* () {
  const sql = yield* migrated;

  yield* sql`
    INSERT INTO office.members (user_id, display_name, first_seen_at, last_seen_at)
    VALUES (${ada.id}, ${ada.name}, now(), now())
  `;

  return sql;
});

class ConnectionRefused extends Schema.TaggedError<
  ConnectionRefused,
  { readonly brand: unique symbol }
>()("ConnectionRefused", { message: Schema.String }) {}

export const unreachable = Layer.effect(
  SqlClient.SqlClient,
  Effect.fail(ConnectionRefused.make({ message: "Connection refused" })),
);

export interface Connections {
  opened: number;
  closed: number;
}

export const countedConnection = (sql: SqlClient.SqlClient, connections: Connections) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.acquireRelease(
      Effect.sync(() => {
        connections.opened += 1;

        return sql;
      }),
      () =>
        Effect.sync(() => {
          connections.closed += 1;
        }),
    ),
  );

export const stallingBeforeCommit = (
  sql: SqlClient.SqlClient,
  stalled: Deferred.Deferred<void>,
): SqlClient.SqlClient =>
  Object.assign(sql.bind(undefined), sql, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(
        effect.pipe(
          Effect.andThen(Deferred.succeed(stalled, undefined)),
          Effect.andThen(Effect.never),
        ),
      ),
  });
