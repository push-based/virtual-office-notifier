import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Effect } from "effect";

import { type RecordingState, stateOf } from "../src/Recording.ts";
import { inState } from "../src/RecordingStates.ts";
import { columnNaming } from "../src/SqlNaming.ts";
import { migrated } from "./schema.ts";

const RUNNING = "00000000-0000-4000-8000-000000000001";

const TRANSCRIBING = "00000000-0000-4000-8000-000000000002";

const FINISHED = "00000000-0000-4000-8000-000000000003";

const SILENT = "00000000-0000-4000-8000-000000000004";

const at = (minutes: number) => DateTime.toDate(DateTime.makeUnsafe(minutes * 60_000));

const STATES: ReadonlyArray<readonly [RecordingState, string]> = [
  ["running", RUNNING],
  ["transcribing", TRANSCRIBING],
  ["finished", FINISHED],
  ["silent", SILENT],
];

const recordings = Effect.gen(function* () {
  const sql = yield* migrated;

  yield* sql`
    INSERT INTO office.members (user_id, display_name, first_seen_at, last_seen_at)
    VALUES ('u1', 'Ada', now(), now())
  `;

  const rows = [
    { id: RUNNING, guildId: "g", channelId: "c", startedAt: at(4), startedBy: "u1" },
    {
      id: TRANSCRIBING,
      guildId: "g",
      channelId: "c",
      startedAt: at(3),
      startedBy: "u1",
      stoppedAt: at(5),
    },
    {
      id: FINISHED,
      guildId: "g",
      channelId: "c",
      startedAt: at(2),
      startedBy: "u1",
      stoppedAt: at(5),
      finishedAt: at(6),
      slackChannelId: "C1",
      slackTs: "1.2",
    },
    {
      id: SILENT,
      guildId: "g",
      channelId: "c",
      startedAt: at(1),
      startedBy: "u1",
      stoppedAt: at(5),
      finishedAt: at(6),
    },
  ];

  for (const row of rows) yield* sql`INSERT INTO office.recordings ${sql.insert(row)}`;

  return sql;
});

describe("inState", () => {
  it.effect("selects each recording by the state CONTEXT.md gives it, the same as stateOf", () =>
    Effect.gen(function* () {
      const sql = yield* recordings;

      for (const [state, id] of STATES) {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM office.recordings WHERE ${inState(sql, state)}
        `;

        assert.deepStrictEqual(
          Array.map(rows, (row) => row.id),
          [id],
          state,
        );
      }

      const progress = yield* sql<{
        readonly id: string;
        readonly stopped: boolean;
        readonly finished: boolean;
        readonly posted: boolean;
      }>`
        SELECT id, stopped_at IS NOT NULL AS stopped, finished_at IS NOT NULL AS finished,
               slack_ts IS NOT NULL AS posted
        FROM office.recordings ORDER BY started_at DESC
      `;

      assert.deepStrictEqual(
        Array.map(progress, (row) => [stateOf(row), row.id] as const),
        STATES,
      );
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect("works on a joined table under its alias", () =>
    Effect.gen(function* () {
      const sql = yield* recordings;

      const rows = yield* sql<{ readonly id: string }>`
        SELECT r.id FROM office.recordings r WHERE ${inState(sql, "running", "r")}
      `;

      assert.deepStrictEqual(rows, [{ id: RUNNING }]);
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );
});
