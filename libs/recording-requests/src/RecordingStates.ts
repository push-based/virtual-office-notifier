import type { SqlClient, Statement } from "effect/sql";

import type { RecordingState } from "./Recording.ts";

export const inState = (
  sql: SqlClient.SqlClient,
  state: RecordingState,
  table?: string,
): Statement.Fragment => {
  const column = (name: string) => sql.literal(table === undefined ? name : `${table}.${name}`);

  switch (state) {
    case "running":
      return sql`${column("stopped_at")} IS NULL`;
    case "transcribing":
      return sql`${column("stopped_at")} IS NOT NULL AND ${column("finished_at")} IS NULL`;
    case "finished":
      return sql`${column("finished_at")} IS NOT NULL AND ${column("slack_channel_id")} IS NOT NULL AND ${column("slack_ts")} IS NOT NULL`;
    case "silent":
      return sql`${column("finished_at")} IS NOT NULL AND ${column("slack_ts")} IS NULL`;
  }
};
