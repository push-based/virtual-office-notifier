import { Array, Context, DateTime, Effect, Layer, Option, pipe, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import { guardQuery } from "recording-requests/Query";

import { Database, describeError } from "./Database.ts";
import type { ActivityEntry, BanterPeriod } from "./OfficeEvent.ts";

export const MAX_ACTIVITY_ENTRIES = 400;

export class HistoryUnavailable extends Schema.TaggedError<
  HistoryUnavailable,
  { readonly brand: unique symbol }
>()("HistoryUnavailable", {
  reason: Schema.String,
}) {}

const ActivityRow = Schema.Struct({
  observedAt: Schema.DateTimeUtcFromDate,
  who: Schema.String,
  event: Schema.String,
  total: Schema.Int,
});

const Between = Schema.Struct({
  from: Schema.DateTimeUtcFromDate,
  until: Schema.DateTimeUtcFromDate,
});

export interface RecentActivity {
  readonly entriesOldestFirst: ReadonlyArray<ActivityEntry>;
  readonly olderEntriesLeftOut: number;
}

const notRecording = () => Effect.fail(HistoryUnavailable.make({ reason: "Nothing is recorded" }));

export class OfficeHistory extends Context.Service<
  OfficeHistory,
  {
    latestActivityBetween(
      from: DateTime.Utc,
      until: DateTime.Utc,
    ): Effect.Effect<RecentActivity, HistoryUnavailable>;
    readonly presentSinceBotStarted: Effect.Effect<ReadonlyArray<string>, HistoryUnavailable>;
    banterPostsSince(from: DateTime.Utc): Effect.Effect<number, HistoryUnavailable>;
    recordBanterPost(
      at: DateTime.Utc,
      period: BanterPeriod,
    ): Effect.Effect<void, HistoryUnavailable>;
  }
>()("bot/OfficeHistory") {
  static readonly layer = Layer.effect(
    OfficeHistory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;

      const onceReady = guardQuery({
        ready: database.ready,
        unavailable: (reason) => HistoryUnavailable.make({ reason }),
        describe: describeError,
      });

      const activityBetween = SqlSchema.findAll({
        Request: Between,
        Result: ActivityRow,
        execute: ({ from, until }) => sql`
          SELECT
            observed_at,
            coalesce(real_name, display_name) AS who,
            concat_ws(' ', event, detail) AS event,
            count(*) OVER ()::int AS total
          FROM office.office_activity
          WHERE observed_at >= ${from} AND observed_at < ${until}
          ORDER BY observed_at DESC, snapshot_id DESC NULLS LAST, effect_id DESC NULLS LAST
          LIMIT ${MAX_ACTIVITY_ENTRIES}
        `,
      });

      const presentNow = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({ who: Schema.String }),
        execute: () => sql`
          SELECT who FROM (
            SELECT DISTINCT ON (user_id) coalesce(real_name, display_name) AS who, event
            FROM office.voice_activity
            WHERE bot_session_id = (SELECT id FROM office.bot_sessions ORDER BY started_at DESC LIMIT 1)
              AND event IN ('AlreadyThere', 'Joined', 'Left')
            ORDER BY user_id, observed_at DESC, snapshot_id DESC
          ) AS latest_arrival_or_departure
          WHERE event <> 'Left'
          ORDER BY who
        `,
      });

      const banterPostCount = SqlSchema.findOneOption({
        Request: Schema.Struct({ from: Schema.DateTimeUtcFromDate }),
        Result: Schema.Struct({ posts: Schema.Int }),
        execute: ({ from }) => sql`
          SELECT count(*)::int AS posts FROM office.banter_posts WHERE posted_at >= ${from}
        `,
      });

      const latestActivityBetween = Effect.fn("OfficeHistory.latestActivityBetween")(function* (
        from: DateTime.Utc,
        until: DateTime.Utc,
      ) {
        const newestFirst = yield* onceReady(activityBetween({ from, until }));

        return {
          entriesOldestFirst: pipe(
            newestFirst,
            Array.map(({ observedAt, who, event }) => ({ at: observedAt, who, event })),
            Array.reverse,
          ),
          olderEntriesLeftOut: (newestFirst[0]?.total ?? 0) - newestFirst.length,
        };
      });

      const presentSinceBotStarted = onceReady(presentNow()).pipe(
        Effect.map((rows) => Array.map(rows, (row) => row.who)),
        Effect.withSpan("OfficeHistory.presentSinceBotStarted"),
      );

      const banterPostsSince = Effect.fn("OfficeHistory.banterPostsSince")(
        (from: DateTime.Utc) => onceReady(banterPostCount({ from })),
        Effect.map(Option.match({ onNone: () => 0, onSome: ({ posts }) => posts })),
      );

      const recordBanterPost = Effect.fn("OfficeHistory.recordBanterPost")(
        (at: DateTime.Utc, period: BanterPeriod) =>
          onceReady(
            sql`INSERT INTO office.banter_posts ${sql.insert({ postedAt: DateTime.toDate(at), period })}`,
          ),
        Effect.asVoid,
      );

      return OfficeHistory.of({
        latestActivityBetween,
        presentSinceBotStarted,
        banterPostsSince,
        recordBanterPost,
      });
    }),
  );

  static readonly layerDisabled = Layer.succeed(
    OfficeHistory,
    OfficeHistory.of({
      latestActivityBetween: notRecording,
      presentSinceBotStarted: notRecording(),
      banterPostsSince: notRecording,
      recordBanterPost: notRecording,
    }),
  );
}
