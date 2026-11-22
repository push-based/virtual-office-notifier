import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { connectedTo, QUERY_TIMEOUT } from "../src/Query.ts";
import { type EditHandler, RecordingEdits } from "../src/RecordingEdits.ts";
import { columnNaming } from "../src/SqlNaming.ts";
import {
  ada,
  type Connections,
  countedConnection,
  migratedWithAda,
  stallingBeforeCommit,
  unreachable,
} from "./database.ts";

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const createTables = Effect.gen(function* () {
  const sql = yield* migratedWithAda;

  yield* sql`
    INSERT INTO office.recordings (id, guild_id, channel_id, started_at, started_by)
    VALUES (${RECORDING}, 'guild', 'office', now(), ${ada.id})
  `;

  return sql;
});

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
      const edits = yield* editsOver(unreachable);

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

describe("RecordingEdits.handlePending", () => {
  it.effect("gives up on a transaction that doesn't commit in time and rolls it back", () =>
    Effect.gen(function* () {
      const sql = yield* createTables;
      const stalled = yield* Deferred.make<void>();
      const committed = yield* Ref.make(false);

      const edits = RecordingEdits.makeWith(
        Effect.void,
        connectedTo(stallingBeforeCommit(sql, stalled)),
      );

      const renamingThenTelling: EditHandler<never, never> = {
        apply: (edit) =>
          renaming(sql)
            .apply(edit)
            .pipe(Effect.as({ afterCommit: Ref.set(committed, true) })),
      };

      const submitted = Option.getOrThrow(
        yield* edits.submit(ada, RECORDING, { kind: "title", title: "Retro" }),
      );

      const fiber = yield* edits.handlePending(renamingThenTelling).pipe(Effect.forkChild);

      yield* Deferred.await(stalled);
      yield* TestClock.adjust(Duration.sum(QUERY_TIMEOUT, Duration.millis(1)));

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      const found = yield* edits.find(ada, submitted.id);

      assert.strictEqual(failure._tag, "RecordingUnavailable");
      assert.strictEqual(failure.reason, "Timed out after 10 seconds");
      assert.isFalse(yield* Ref.get(committed));
      assert.deepStrictEqual(yield* sql`SELECT title FROM office.recordings`, [{ title: null }]);
      assert.strictEqual(Option.getOrNull(found)?.outcome, null);
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );
});
