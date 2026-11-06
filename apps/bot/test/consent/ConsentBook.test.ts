import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

import { ConsentBook, recordAfter } from "../../src/consent/ConsentBook.ts";
import { ConsentLog, NEVER_ASKED } from "../../src/consent/ConsentLog.ts";
import { columnNaming, Database } from "../../src/database/Database.ts";
import { pollUntil } from "../fakes.ts";

const at = DateTime.makeUnsafe(0);

const seed = (rows: ReadonlyArray<readonly [string, string, number]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const database = yield* Database;

    yield* database.ready;

    for (const [userId, kind, version] of rows)
      yield* sql`
        INSERT INTO office.consent_events (user_id, happened_at, kind, notice_version, wording, delivery)
        VALUES (
          ${userId}, now(), ${kind}, ${version},
          ${kind === "asked" ? "first" : null}, ${kind === "asked" ? "direct_message" : null}
        )
      `;
  });

const storage = Database.layerNoDeps().pipe(Layer.provideMerge(PgliteClient.layer(columnNaming)));

describe("ConsentLog", () => {
  it.effect("reads who agreed to the current notice and how often each was asked", () =>
    Effect.gen(function* () {
      yield* seed([
        ["ada", "asked", 1],
        ["ada", "agreed", 1],
        ["grace", "asked", 1],
        ["grace", "agreed", 1],
        ["grace", "withdrawn", 1],
        ["alan", "asked", 1],
        ["alan", "asked", 1],
        ["alan", "timed_out", 1],
        ["old", "agreed", 0],
      ]);

      const log = yield* ConsentLog;
      const history = yield* log.history;

      assert.deepStrictEqual(history.get("ada"), { agreed: true, asked: 1 });
      assert.deepStrictEqual(history.get("grace"), { agreed: false, asked: 1 });
      assert.deepStrictEqual(history.get("alan"), { agreed: false, asked: 2 });
      assert.deepStrictEqual(history.get("old"), { agreed: false, asked: 0 });
    }).pipe(Effect.provide(ConsentLog.layer.pipe(Layer.provideMerge(storage)))),
  );

  it.effect("refuses an asked event without its wording and delivery", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;
      yield* database.ready;

      const inserted = yield* sql`
        INSERT INTO office.consent_events (user_id, happened_at, kind, notice_version)
        VALUES ('ada', now(), 'asked', 1)
      `.pipe(Effect.option);

      assert.isTrue(Option.isNone(inserted));
    }).pipe(Effect.provide(storage)),
  );
});

describe("ConsentBook", () => {
  it.effect("adds what it noted to what the database knew, and writes it", () =>
    Effect.gen(function* () {
      yield* seed([["ada", "asked", 1]]);

      const book = yield* ConsentBook;
      const sql = yield* SqlClient.SqlClient;

      yield* book.note({
        userId: "ada",
        at,
        kind: "asked",
        asked: { wording: "again", delivery: "voice_chat" },
      });
      yield* book.note({ userId: "ada", at, kind: "agreed" });

      assert.deepStrictEqual(yield* book.lookup("ada"), { agreed: true, asked: 2 });
      assert.deepStrictEqual(yield* book.lookup("nobody"), NEVER_ASKED);

      const rows = yield* pollUntil(
        sql<{ kind: string; wording: string | null; delivery: string | null }>`
          SELECT kind, wording, delivery FROM office.consent_events ORDER BY id
        `,
        (found) => found.length === 3,
      );

      assert.deepStrictEqual(rows.slice(1), [
        { kind: "asked", wording: "again", delivery: "voice_chat" },
        { kind: "agreed", wording: null, delivery: null },
      ]);
    }).pipe(
      Effect.provide(
        ConsentBook.layer.pipe(Layer.provideMerge(ConsentLog.layer), Layer.provideMerge(storage)),
      ),
    ),
  );

  it("lets what was noted since startup win over the history", () => {
    assert.deepStrictEqual(
      recordAfter(
        { agreed: true, asked: 3 },
        { forgotten: false, agreed: Option.some(false), asked: 1 },
      ),
      { agreed: false, asked: 4 },
    );
    assert.deepStrictEqual(
      recordAfter(
        { agreed: true, asked: 1 },
        { forgotten: false, agreed: Option.none(), asked: 0 },
      ),
      {
        agreed: true,
        asked: 1,
      },
    );
  });
});
