import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { migrations } from "../src/migrations.ts";

const runMigrations = Migrator.make({});

export const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE SCHEMA IF NOT EXISTS office`;
  yield* runMigrations({ loader: migrations, table: "office.migrations" });

  return sql;
});
