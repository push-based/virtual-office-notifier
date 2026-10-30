import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { type EditHandler, RecordingEdits } from "../src/RecordingEdits.ts";
import { columnNaming } from "../src/SqlNaming.ts";

class ConnectionRefused extends Schema.TaggedError<
  ConnectionRefused,
  { readonly brand: unique symbol }
>()("ConnectionRefused", { message: Schema.String }) {}

interface Connections {
  opened: number;
  closed: number;
}

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const ada = { id: "u1", name: "Ada" };

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE SCHEMA office`;
  yield* sql`
    CREATE TABLE office.recordings (
      id uuid PRIMARY KEY, stopped_at timestamptz, finished_at timestamptz, slack_ts text, title text
    )
  `;
  yield* sql`
    CREATE TABLE office.recording_edits (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recording_id uuid NOT NULL,
      edited_at timestamptz NOT NULL DEFAULT now(),
      edited_by text NOT NULL,
      edited_by_name text NOT NULL,
      kind text NOT NULL,
      change jsonb NOT NULL,
      handled_at timestamptz,
      outcome text,
      reason text
    )
  `;
  yield* sql`INSERT INTO office.recordings (id) VALUES (${RECORDING})`;

  return sql;
});

const countedConnection = (sql: SqlClient.SqlClient, connections: Connections) =>
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

const editsOver = <E extends Error>(connection: Layer.Layer<SqlClient.SqlClient, E>) =>
  Effect.provide(Effect.service(RecordingEdits), RecordingEdits.layerPerCall(connection));

const renaming = (sql: SqlClient.SqlClient): EditHandler<never, never> => ({
  apply: (edit) =>
    sql`UPDATE office.recordings SET title = ${edit.change.kind === "title" ? edit.change.title : null}`.pipe(
      Effect.orDie,
      Effect.as({ afterCommit: Effect.void }),
    ),
});

describe("RecordingEdits.layerPerCall", () => {
  it.effect("opens a connection for each call and closes it afterwards", () =>
    Effect.gen(function* () {
      const sql = yield* createTables;
      const connections: Connections = { opened: 0, closed: 0 };
      const edits = yield* editsOver(countedConnection(sql, connections));

      assert.deepStrictEqual(connections, { opened: 0, closed: 0 });

      const submitted = Option.getOrThrow(
        yield* edits.submit(ada, RECORDING, { kind: "title", title: "Retro" }),
      );

      yield* edits.handlePending(renaming(sql));

      const found = yield* edits.find(ada, submitted.id);

      assert.strictEqual(submitted.outcome, null);
      assert.strictEqual(Option.getOrNull(found)?.outcome, "applied");
      assert.deepStrictEqual(yield* sql`SELECT title FROM office.recordings`, [{ title: "Retro" }]);
      assert.deepStrictEqual(connections, { opened: 3, closed: 3 });
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect("answers every method as unavailable when it can't connect", () =>
    Effect.gen(function* () {
      const edits = yield* editsOver(
        Layer.effect(
          SqlClient.SqlClient,
          Effect.fail(ConnectionRefused.make({ message: "Connection refused" })),
        ),
      );

      const failures = yield* Effect.all([
        edits.submit(ada, RECORDING, { kind: "title", title: "Retro" }).pipe(Effect.flip),
        edits.find(ada, 1).pipe(Effect.flip),
        edits.handlePending({ apply: () => Effect.die("unreachable") }).pipe(Effect.flip),
      ]);

      for (const failure of failures) {
        assert.strictEqual(failure._tag, "RecordingUnavailable");
        assert.strictEqual(failure.reason, "Connection refused");
      }
    }),
  );
});
