import { Array, Context, DateTime, Duration, Effect, Layer, Option, pipe, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  type ListedRecording,
  type OfficeMember,
  type RecordingDetail,
  type RecordingPage,
  stateOf,
  StopReason,
} from "./Recording.ts";
import { PersonInOffice } from "./RecordingRequest.ts";
import { type Connected, RecordingUnavailable } from "./RecordingRequests.ts";

export const PAGE_SIZE = 20;

const QUERY_TIMEOUT = Duration.seconds(10);

const RecordingRow = Schema.Struct({
  id: Schema.String,
  startedAt: Schema.DateTimeUtcFromDate,
  stoppedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  slackTs: Schema.NullOr(Schema.String),
  startedBy: Schema.String,
  startedByName: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
});

type RecordingRow = typeof RecordingRow.Type;

const decodeRecordings = Schema.decodeUnknownEffect(Schema.Array(RecordingRow));

const decodeDetails = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...RecordingRow.fields,
      agenda: Schema.NullOr(Schema.String),
      stopReason: Schema.NullOr(StopReason),
      stoppedBy: Schema.NullOr(Schema.String),
      stoppedByName: Schema.NullOr(Schema.String),
      summary: Schema.NullOr(Schema.String),
      summaryModel: Schema.NullOr(Schema.String),
      slackPermalink: Schema.NullOr(Schema.String),
    }),
  ),
);

const decodeSpeakers = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ recordingId: Schema.String, userId: Schema.String, name: Schema.String }),
  ),
);

const decodeClips = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      name: Schema.String,
      startedAt: Schema.DateTimeUtcFromDate,
      transcript: Schema.String,
    }),
  ),
);

const decodeOccupants = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ occupants: Schema.Array(PersonInOffice) })),
);

type Avatars = ReadonlyMap<string, string>;

const memberOf = (avatars: Avatars, userId: string, name: string | null): OfficeMember => ({
  userId,
  name: name ?? userId,
  avatarUrl: avatars.get(userId) ?? null,
});

const listed = (
  row: RecordingRow,
  speakers: ReadonlyArray<OfficeMember>,
  avatars: Avatars,
): ListedRecording => ({
  id: row.id,
  state: stateOf({
    stopped: row.stoppedAt !== null,
    finished: row.finishedAt !== null,
    posted: row.slackTs !== null,
  }),
  startedAt: row.startedAt,
  stoppedAt: row.stoppedAt,
  startedBy: memberOf(avatars, row.startedBy, row.startedByName),
  speakers,
  title: row.title,
});

const unavailable = (reason: string) => Effect.fail(RecordingUnavailable.make({ reason }));

export class RecordingHistory extends Context.Service<
  RecordingHistory,
  {
    page(before: Option.Option<DateTime.Utc>): Effect.Effect<RecordingPage, RecordingUnavailable>;
    find(id: string): Effect.Effect<Option.Option<RecordingDetail>, RecordingUnavailable>;
  }
>()("recording-requests/RecordingHistory") {
  static readonly makeWith = (connected: Connected) => {
    const timed = <A, E extends Error, R>(query: Effect.Effect<A, E, R>) =>
      query.pipe(
        Effect.mapError((error) => RecordingUnavailable.make({ reason: error.message })),
        Effect.timeoutOrElse({
          duration: QUERY_TIMEOUT,
          orElse: () => unavailable("Timed out after 10 seconds"),
        }),
      );

    const avatarsFrom = (sql: SqlClient.SqlClient) =>
      sql`SELECT occupants FROM office.recording_status`.pipe(
        Effect.flatMap(decodeOccupants),
        Effect.map(
          (rows): Avatars =>
            new Map(
              Array.flatMap(rows, ({ occupants }) =>
                Array.flatMap(occupants, ({ userId, avatarUrl }) =>
                  avatarUrl === null ? [] : [[userId, avatarUrl] as const],
                ),
              ),
            ),
        ),
      );

    const speakersOf = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>, avatars: Avatars) =>
      Array.isReadonlyArrayNonEmpty(ids)
        ? sql`
            SELECT c.recording_id, c.user_id, coalesce(m.real_name, m.display_name) AS name
            FROM office.recording_clips c
            JOIN office.members m USING (user_id)
            WHERE c.recording_id IN ${sql.in(ids)} AND c.transcription IN ('pending', 'done')
            GROUP BY c.recording_id, c.user_id, m.real_name, m.display_name
            ORDER BY min(c.started_at)
          `.pipe(
            Effect.flatMap(decodeSpeakers),
            Effect.map((rows) => Array.groupBy(rows, (row) => row.recordingId)),
            Effect.map(
              (byRecording) =>
                (id: string): ReadonlyArray<OfficeMember> =>
                  Array.map(byRecording[id] ?? [], (row) =>
                    memberOf(avatars, row.userId, row.name),
                  ),
            ),
          )
        : Effect.succeed((_id: string): ReadonlyArray<OfficeMember> => []);

    const page = Effect.fn("RecordingHistory.page")((before: Option.Option<DateTime.Utc>) =>
      connected((sql) =>
        timed(
          Effect.gen(function* () {
            const rows = yield* sql`
              SELECT r.id, r.started_at, r.stopped_at, r.finished_at, r.slack_ts, r.started_by,
                     coalesce(m.real_name, m.display_name) AS started_by_name, r.title
              FROM office.recordings r
              LEFT JOIN office.members m ON m.user_id = r.started_by
              WHERE ${sql.and(
                Option.match(before, {
                  onNone: () => [],
                  onSome: (at) => [sql`r.started_at < ${DateTime.toDate(at)}`],
                }),
              )}
              ORDER BY r.started_at DESC
              LIMIT ${PAGE_SIZE + 1}
            `.pipe(Effect.flatMap(decodeRecordings));

            const shown = Array.take(rows, PAGE_SIZE);
            const avatars = yield* avatarsFrom(sql);

            const speakers = yield* speakersOf(
              sql,
              Array.map(shown, (row) => row.id),
              avatars,
            );

            const recordings = Array.map(shown, (row) => listed(row, speakers(row.id), avatars));

            const older =
              rows.length > PAGE_SIZE
                ? pipe(
                    Array.last(shown),
                    Option.map((row) => row.startedAt),
                    Option.getOrNull,
                  )
                : null;

            const found: RecordingPage = { recordings, older };

            return found;
          }),
        ),
      ),
    );

    const find = Effect.fn("RecordingHistory.find")((id: string) =>
      connected((sql) =>
        timed(
          Effect.gen(function* () {
            const rows = yield* sql`
              SELECT r.id, r.started_at, r.stopped_at, r.finished_at, r.slack_ts, r.started_by,
                     coalesce(m.real_name, m.display_name) AS started_by_name, r.title, r.agenda,
                     r.stop_reason, r.stopped_by, coalesce(s.real_name, s.display_name) AS stopped_by_name,
                     r.summary, r.summary_model, r.slack_permalink
              FROM office.recordings r
              LEFT JOIN office.members m ON m.user_id = r.started_by
              LEFT JOIN office.members s ON s.user_id = r.stopped_by
              WHERE r.id = ${id}
            `.pipe(Effect.flatMap(decodeDetails));

            const [row] = rows;

            if (row === undefined) return Option.none<RecordingDetail>();

            const avatars = yield* avatarsFrom(sql);
            const speakers = yield* speakersOf(sql, [row.id], avatars);

            const clips = yield* sql`
              SELECT c.user_id, coalesce(m.real_name, m.display_name) AS name, c.started_at, c.transcript
              FROM office.recording_clips c
              JOIN office.members m USING (user_id)
              WHERE c.recording_id = ${id} AND c.transcription = 'done'
                AND c.transcript IS NOT NULL AND btrim(c.transcript) <> ''
              ORDER BY c.started_at, c.id
            `.pipe(Effect.flatMap(decodeClips));

            const detail: RecordingDetail = {
              ...listed(row, speakers(row.id), avatars),
              agenda: row.agenda,
              stopReason: row.stopReason,
              stoppedBy:
                row.stoppedBy === null ? null : memberOf(avatars, row.stoppedBy, row.stoppedByName),
              summary: row.summary,
              summaryModel: row.summaryModel,
              slackPermalink: row.slackPermalink,
              clips: Array.map(clips, (clip) => ({
                speaker: memberOf(avatars, clip.userId, clip.name),
                startedAt: clip.startedAt,
                text: clip.transcript,
              })),
            };

            return Option.some(detail);
          }),
        ),
      ),
    );

    return RecordingHistory.of({ page, find });
  };

  static readonly layer = Layer.effect(
    RecordingHistory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return RecordingHistory.makeWith((use) => use(sql));
    }),
  );

  static readonly layerPerCall = <E extends Error>(
    connection: Layer.Layer<SqlClient.SqlClient, E>,
  ) =>
    Layer.succeed(
      RecordingHistory,
      RecordingHistory.makeWith((use) =>
        Effect.scopedWith((scope) =>
          Layer.buildWithScope(Layer.fresh(connection), scope).pipe(
            Effect.mapError((error) => RecordingUnavailable.make({ reason: error.message })),
            Effect.flatMap((context) => use(Context.get(context, SqlClient.SqlClient))),
          ),
        ),
      ),
    );

  static readonly layerDisabled = Layer.succeed(
    RecordingHistory,
    RecordingHistory.of({
      page: () => unavailable("Nothing is recorded"),
      find: () => unavailable("Nothing is recorded"),
    }),
  );
}
