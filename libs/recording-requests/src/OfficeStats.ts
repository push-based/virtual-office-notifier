import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import { type Connected, connectedPerCall, connectedTo, guardQuery } from "./Query.ts";

export const OFFICE_TIME_ZONE = DateTime.zoneMakeOffset(2 * 60 * 60 * 1000);

export const LEADERBOARD_SIZE = 10;

export const StatsRange = Schema.Literals(["week", "month", "all"]);

export type StatsRange = typeof StatsRange.Type;

export const StatsQuery = Schema.Struct({ range: StatsRange });

export const PersonTime = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  seconds: Schema.Finite,
  days: Schema.Int,
});

export const PersonDays = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  days: Schema.Int,
});

export const BusyHour = Schema.Struct({
  weekday: Schema.Int,
  hour: Schema.Int,
  people: Schema.Finite,
});

export const SoundPlays = Schema.Struct({ sound: Schema.String, plays: Schema.Int });

export const PlayerPlays = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  plays: Schema.Int,
});

export const EmojiReactions = Schema.Struct({ emoji: Schema.String, reactions: Schema.Int });

export const RecordingTotals = Schema.Struct({ count: Schema.Int, seconds: Schema.Finite });

export const OfficeStats = Schema.Struct({
  range: StatsRange,
  since: Schema.NullOr(Schema.DateTimeUtcFromString),
  until: Schema.DateTimeUtcFromString,
  timeInOffice: Schema.Array(PersonTime),
  firstIn: Schema.Array(PersonDays),
  lastOut: Schema.Array(PersonDays),
  busiestHours: Schema.Array(BusyHour),
  sounds: Schema.Array(SoundPlays),
  players: Schema.Array(PlayerPlays),
  reactions: Schema.Array(EmojiReactions),
  recordings: RecordingTotals,
});

export type OfficeStats = typeof OfficeStats.Type;

export interface StatsWindow {
  readonly since: DateTime.Utc | null;
  readonly until: DateTime.Utc;
}

export const statsWindow = (range: StatsRange, now: DateTime.Utc): StatsWindow => {
  if (range === "all") return { since: null, until: now };

  const inOffice = DateTime.setZone(now, OFFICE_TIME_ZONE);

  const start =
    range === "week"
      ? DateTime.startOf(inOffice, "week", { weekStartsOn: 1 })
      : DateTime.startOf(inOffice, "month");

  return { since: DateTime.toUtc(start), until: now };
};

export class StatsUnavailable extends Schema.TaggedError<
  StatsUnavailable,
  { readonly brand: unique symbol }
>()("StatsUnavailable", {
  reason: Schema.String,
}) {}

const statsUnavailable = (reason: string) => StatsUnavailable.make({ reason });

const unavailable = (reason: string) => Effect.fail(statsUnavailable(reason));

const Window = Schema.Struct({
  since: Schema.NullOr(Schema.DateTimeUtcFromDate),
  until: Schema.DateTimeUtcFromDate,
});

type Bounds = typeof Window.Encoded;

const queries = (sql: SqlClient.SqlClient) => {
  const stays = ({ since, until }: Bounds) => sql`
    bounds AS (
      SELECT coalesce(${since}::timestamptz, '-infinity'::timestamptz) AS since,
             ${until}::timestamptz AS until
    ),
    moves AS (
      SELECT user_id, coalesce(real_name, display_name) AS name, bot_session_id, event,
             observed_at, lead(observed_at) OVER visits AS next_at
      FROM office.voice_activity
      WHERE event IN ('AlreadyThere', 'Joined', 'Left') AND observed_at < (SELECT until FROM bounds)
      WINDOW visits AS (PARTITION BY user_id, bot_session_id ORDER BY observed_at, snapshot_id)
    ),
    session_ends AS (
      SELECT bot_session_id, max(observed_at) AS last_seen
      FROM office.office_activity
      WHERE observed_at < (SELECT until FROM bounds)
      GROUP BY bot_session_id
    ),
    latest_session AS (
      SELECT bot_session_id FROM session_ends ORDER BY last_seen DESC LIMIT 1
    ),
    whole_stays AS (
      SELECT m.user_id, m.name, m.observed_at AS started_at,
             CASE
               WHEN m.next_at IS NOT NULL THEN m.next_at
               WHEN m.bot_session_id = (SELECT bot_session_id FROM latest_session) THEN b.until
               ELSE e.last_seen
             END AS ended_at,
             m.next_at IS NULL
               AND m.bot_session_id = (SELECT bot_session_id FROM latest_session) AS still_in
      FROM moves m
      JOIN session_ends e USING (bot_session_id)
      CROSS JOIN bounds b
      WHERE m.event <> 'Left'
    ),
    stays AS (
      SELECT s.*, greatest(s.started_at, b.since) AS counted_from, least(s.ended_at, b.until) AS counted_to
      FROM whole_stays s
      CROSS JOIN bounds b
      WHERE s.ended_at > b.since AND s.started_at < b.until
    ),
    office_stays AS (
      SELECT user_id, (counted_from AT TIME ZONE 'UTC') + interval '2 hours' AS office_from,
             (counted_to AT TIME ZONE 'UTC') + interval '2 hours' AS office_to
      FROM stays
    )
  `;

  const officeDate = (column: string) =>
    sql.literal(`((${column} AT TIME ZONE 'UTC') + interval '2 hours')::date`);

  const timeInOffice = SqlSchema.findAll({
    Request: Window,
    Result: PersonTime,
    execute: (bounds) => sql`
      WITH ${stays(bounds)}
      SELECT user_id, name,
             sum(extract(epoch FROM counted_to - counted_from))::float8 AS seconds,
             count(DISTINCT ${officeDate("counted_from")})::int AS days
      FROM stays
      GROUP BY user_id, name
      ORDER BY seconds DESC, name
    `,
  });

  const firstIn = SqlSchema.findAll({
    Request: Window,
    Result: PersonDays,
    execute: (bounds) => sql`
      WITH ${stays(bounds)},
      arrivals AS (
        SELECT DISTINCT ON (${officeDate("started_at")}) user_id, name
        FROM stays, bounds
        WHERE started_at >= bounds.since
        ORDER BY ${officeDate("started_at")}, started_at
      )
      SELECT user_id, name, count(*)::int AS days
      FROM arrivals
      GROUP BY user_id, name
      ORDER BY days DESC, name
    `,
  });

  const lastOut = SqlSchema.findAll({
    Request: Window,
    Result: PersonDays,
    execute: (bounds) => sql`
      WITH ${stays(bounds)},
      departures AS (
        SELECT DISTINCT ON (${officeDate("ended_at")}) user_id, name, still_in
        FROM stays, bounds
        WHERE ended_at <= bounds.until
        ORDER BY ${officeDate("ended_at")}, ended_at DESC, still_in DESC
      )
      SELECT user_id, name, count(*)::int AS days
      FROM departures
      WHERE NOT still_in
      GROUP BY user_id, name
      ORDER BY days DESC, name
    `,
  });

  const busiestHours = SqlSchema.findAll({
    Request: Window,
    Result: BusyHour,
    execute: (bounds) => sql`
      WITH ${stays(bounds)},
      hours AS (
        SELECT generate_series(
                 date_trunc('hour', coalesce(
                   (nullif(bounds.since, '-infinity') AT TIME ZONE 'UTC') + interval '2 hours',
                   (SELECT min(office_from) FROM office_stays)
                 )),
                 date_trunc('hour', (bounds.until AT TIME ZONE 'UTC') + interval '2 hours'),
                 interval '1 hour'
               ) AS hour_start
        FROM bounds
      ),
      occupied AS (
        SELECT h.hour_start,
               sum(extract(epoch FROM
                 least(s.office_to, h.hour_start + interval '1 hour') - greatest(s.office_from, h.hour_start)
               )) AS seconds
        FROM office_stays s
        CROSS JOIN LATERAL generate_series(
          date_trunc('hour', s.office_from), s.office_to, interval '1 hour'
        ) AS h(hour_start)
        GROUP BY h.hour_start
      )
      SELECT extract(isodow FROM hours.hour_start)::int AS weekday,
             extract(hour FROM hours.hour_start)::int AS hour,
             round((coalesce(sum(occupied.seconds), 0) / 3600 / count(*))::numeric, 2)::float8 AS people
      FROM hours
      LEFT JOIN occupied USING (hour_start)
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
  });

  const effects = ({ since, until }: Bounds) => sql`
    bounds AS (
      SELECT coalesce(${since}::timestamptz, '-infinity'::timestamptz) AS since,
             ${until}::timestamptz AS until
    ),
    effects AS (
      SELECT a.user_id, coalesce(a.real_name, a.display_name) AS name, a.event, a.detail
      FROM office.office_activity a, bounds
      WHERE a.observed_at >= bounds.since AND a.observed_at < bounds.until
    )
  `;

  const sounds = SqlSchema.findAll({
    Request: Window,
    Result: SoundPlays,
    execute: (bounds) => sql`
      WITH ${effects(bounds)}
      SELECT detail AS sound, count(*)::int AS plays
      FROM effects
      WHERE event = 'PlayedSound' AND detail IS NOT NULL
      GROUP BY detail
      ORDER BY plays DESC, sound
      LIMIT ${LEADERBOARD_SIZE}
    `,
  });

  const players = SqlSchema.findAll({
    Request: Window,
    Result: PlayerPlays,
    execute: (bounds) => sql`
      WITH ${effects(bounds)}
      SELECT user_id, name, count(*)::int AS plays
      FROM effects
      WHERE event = 'PlayedSound'
      GROUP BY user_id, name
      ORDER BY plays DESC, name
      LIMIT ${LEADERBOARD_SIZE}
    `,
  });

  const reactions = SqlSchema.findAll({
    Request: Window,
    Result: EmojiReactions,
    execute: (bounds) => sql`
      WITH ${effects(bounds)}
      SELECT detail AS emoji, count(*)::int AS reactions
      FROM effects
      WHERE event = 'Reacted' AND detail IS NOT NULL
      GROUP BY detail
      ORDER BY reactions DESC, emoji
      LIMIT ${LEADERBOARD_SIZE}
    `,
  });

  const recordings = SqlSchema.findOneOption({
    Request: Window,
    Result: RecordingTotals,
    execute: ({ since, until }) => sql`
      SELECT count(*)::int AS count,
             coalesce(sum(extract(epoch FROM least(coalesce(stopped_at, ${until}::timestamptz), ${until}::timestamptz) - started_at)), 0)::float8 AS seconds
      FROM office.recordings
      WHERE started_at >= coalesce(${since}::timestamptz, '-infinity'::timestamptz)
        AND started_at < ${until}::timestamptz
    `,
  });

  return (window: StatsWindow) =>
    Effect.all({
      timeInOffice: timeInOffice(window),
      firstIn: firstIn(window),
      lastOut: lastOut(window),
      busiestHours: busiestHours(window),
      sounds: sounds(window),
      players: players(window),
      reactions: reactions(window),
      recordings: recordings(window).pipe(
        Effect.map(Option.getOrElse(() => ({ count: 0, seconds: 0 }))),
      ),
    });
};

export class OfficeStatsReader extends Context.Service<
  OfficeStatsReader,
  {
    stats(range: StatsRange): Effect.Effect<OfficeStats, StatsUnavailable>;
  }
>()("recording-requests/OfficeStats/OfficeStatsReader") {
  static readonly makeWith = (connected: Connected<StatsUnavailable>) => {
    const timed = guardQuery({ ready: Effect.void, unavailable: statsUnavailable });

    const stats = Effect.fn("OfficeStatsReader.stats")(function* (range: StatsRange) {
      const window = statsWindow(range, yield* DateTime.now);

      const totals = yield* connected((sql) => timed(queries(sql)(window)));

      const result: OfficeStats = { range, ...window, ...totals };

      return result;
    });

    return OfficeStatsReader.of({ stats });
  };

  static readonly layer = Layer.effect(
    OfficeStatsReader,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return OfficeStatsReader.makeWith(connectedTo(sql));
    }),
  );

  static readonly layerPerCall = <E extends Error>(
    connection: Layer.Layer<SqlClient.SqlClient, E>,
  ) =>
    Layer.succeed(
      OfficeStatsReader,
      OfficeStatsReader.makeWith(connectedPerCall(connection, statsUnavailable)),
    );

  static readonly layerDisabled = Layer.succeed(
    OfficeStatsReader,
    OfficeStatsReader.of({ stats: () => unavailable("Nothing is recorded") }),
  );
}
