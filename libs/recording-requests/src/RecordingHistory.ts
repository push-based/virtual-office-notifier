import { Array, Context, DateTime, Effect, Layer, Option, pipe, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  type ActionItem,
  type ListedRecording,
  type OfficeMember,
  type RecordingDetail,
  type RecordingPage,
  stateOf,
  StopReason,
  SummaryStyle,
} from "./Recording.ts";
import { PersonInOffice, RowId } from "./RecordingRequest.ts";
import { type Connected, connectedPerCall, connectedTo, guardQuery } from "./Query.ts";
import { recordingUnavailable, RecordingUnavailable } from "./RecordingRequests.ts";

export const PAGE_SIZE = 20;

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
      summaryStyle: SummaryStyle,
      summaryWrittenStyle: Schema.NullOr(SummaryStyle),
      rewriting: Schema.Boolean,
      slackPermalink: Schema.NullOr(Schema.String),
    }),
  ),
);

const decodeActionItems = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: RowId,
      text: Schema.String,
      owner: Schema.NullOr(Schema.String),
      ownerName: Schema.NullOr(Schema.String),
      done: Schema.Boolean,
    }),
  ),
);

const decodePulled = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ pulled: Schema.Boolean })),
);

const decodeMembers = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ userId: Schema.String, name: Schema.String })),
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
  static readonly makeWith = (connected: Connected<RecordingUnavailable>) => {
    const timed = guardQuery({ ready: Effect.void, unavailable: recordingUnavailable });

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

    const actionItemsOf = Effect.fnUntraced(
      function* (sql: SqlClient.SqlClient, id: string, avatars: Avatars) {
        const [pulled] = yield* sql`
          SELECT action_items_model IS NOT NULL AS pulled FROM office.recordings WHERE id = ${id}
        `.pipe(Effect.flatMap(decodePulled));

        if (pulled?.pulled !== true) return null;

        const items = yield* sql`
          SELECT a.id, a.text, a.owner, coalesce(m.real_name, m.display_name) AS owner_name, a.done
          FROM office.recording_action_items a
          LEFT JOIN office.members m ON m.user_id = a.owner
          WHERE a.recording_id = ${id} AND a.replaced_at IS NULL
          ORDER BY a.position, a.id
        `.pipe(Effect.flatMap(decodeActionItems));

        return Array.map(items, (item): ActionItem => ({
          id: item.id,
          text: item.text,
          owner: item.owner === null ? null : memberOf(avatars, item.owner, item.ownerName),
          done: item.done,
        }));
      },
      Effect.catch((error) =>
        Effect.logWarning("Couldn't read the recording's action items").pipe(
          Effect.annotateLogs({ reason: error.message }),
          Effect.as(null),
        ),
      ),
    );

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
                     r.summary, r.summary_model, r.summary_style, r.summary_written_style,
                     r.summary_rewrite_edit_id IS NOT NULL AS rewriting, r.slack_permalink
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

            const members = yield* sql`
              SELECT user_id, coalesce(real_name, display_name) AS name FROM office.members
              ORDER BY lower(coalesce(real_name, display_name)), user_id
            `.pipe(Effect.flatMap(decodeMembers));

            const actionItems = yield* actionItemsOf(sql, id, avatars);

            const detail: RecordingDetail = {
              ...listed(row, speakers(row.id), avatars),
              agenda: row.agenda,
              stopReason: row.stopReason,
              stoppedBy:
                row.stoppedBy === null ? null : memberOf(avatars, row.stoppedBy, row.stoppedByName),
              summary: row.summary,
              summaryModel: row.summaryModel,
              summaryStyle: row.summaryStyle,
              summaryWrittenStyle: row.summaryWrittenStyle,
              rewriting: row.rewriting,
              slackPermalink: row.slackPermalink,
              clips: Array.map(clips, (clip) => ({
                speaker: memberOf(avatars, clip.userId, clip.name),
                startedAt: clip.startedAt,
                text: clip.transcript,
              })),
              actionItems,
              members: Array.map(members, (member) =>
                memberOf(avatars, member.userId, member.name),
              ),
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

      return RecordingHistory.makeWith(connectedTo(sql));
    }),
  );

  static readonly layerPerCall = <E extends Error>(
    connection: Layer.Layer<SqlClient.SqlClient, E>,
  ) =>
    Layer.succeed(
      RecordingHistory,
      RecordingHistory.makeWith(connectedPerCall(connection, recordingUnavailable)),
    );

  static readonly layerDisabled = Layer.succeed(
    RecordingHistory,
    RecordingHistory.of({
      page: () => unavailable("Nothing is recorded"),
      find: () => unavailable("Nothing is recorded"),
    }),
  );
}
