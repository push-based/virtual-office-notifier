import { Context, Duration, Effect, Layer, Match, Option, Schema } from "effect";
import { SqlClient, SqlError, type Statement } from "effect/sql";

import type { Requester } from "./RecordingApi.ts";
import {
  decideEdit,
  EditIgnoreReason,
  explainEdit,
  RecordingChange,
  type RecordingEdit,
  type SubmittedEdit,
} from "./RecordingEdit.ts";
import { RowId } from "./RecordingRequest.ts";
import { type Connected, RecordingUnavailable } from "./RecordingRequests.ts";

const QUERY_TIMEOUT = Duration.seconds(10);

export interface AppliedEdit<E, R> {
  readonly afterCommit: Effect.Effect<void, E, R>;
}

export interface EditHandler<E, R> {
  apply(edit: RecordingEdit): Effect.Effect<AppliedEdit<E, R>, E, R>;
}

const SubmittedRow = Schema.Union([
  Schema.Struct({ id: RowId, outcome: Schema.Null, reason: Schema.Null }),
  Schema.Struct({ id: RowId, outcome: Schema.Literal("applied"), reason: Schema.Null }),
  Schema.Struct({ id: RowId, outcome: Schema.Literal("ignored"), reason: EditIgnoreReason }),
]);

const decodeSubmitted = Schema.decodeUnknownEffect(Schema.Array(SubmittedRow));

const toSubmitted = (row: typeof SubmittedRow.Type): SubmittedEdit =>
  row.outcome === "ignored"
    ? { id: row.id, outcome: row.outcome, reason: row.reason, explanation: explainEdit(row.reason) }
    : { id: row.id, outcome: row.outcome };

const decodePending = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: RowId,
      recordingId: Schema.String,
      editedBy: Schema.String,
      editedByName: Schema.String,
      change: Schema.Unknown,
      stopped: Schema.Boolean,
      finished: Schema.Boolean,
      posted: Schema.Boolean,
    }),
  ),
);

const decodeChange = Schema.decodeUnknownOption(RecordingChange);

const encodeChange = Schema.encodeEffect(Schema.fromJsonString(RecordingChange));

const itemOfRecording = (sql: SqlClient.SqlClient, item: number) => sql`
  EXISTS (
    SELECT 1 FROM office.recording_action_items a
    WHERE a.id = ${item} AND a.recording_id = office.recordings.id AND a.replaced_at IS NULL
  )
`;

const knownMember = (sql: SqlClient.SqlClient, userId: string) =>
  sql`EXISTS (SELECT 1 FROM office.members m WHERE m.user_id = ${userId})`;

const targetsOf = (
  sql: SqlClient.SqlClient,
  change: RecordingChange,
): ReadonlyArray<Statement.Fragment> =>
  Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      title: () => [],
      agenda: () => [],
      tick: ({ item }) => [itemOfRecording(sql, item)],
      untick: ({ item }) => [itemOfRecording(sql, item)],
      reassign: ({ item, owner }) => [
        itemOfRecording(sql, item),
        ...(owner === null ? [] : [knownMember(sql, owner)]),
      ],
      summary_style: () => [],
      rewrite_summary: () => [],
    }),
  );

const unavailable = (reason: string) => Effect.fail(RecordingUnavailable.make({ reason }));

export class RecordingEdits extends Context.Service<
  RecordingEdits,
  {
    submit(
      editor: Requester,
      recordingId: string,
      change: RecordingChange,
    ): Effect.Effect<Option.Option<SubmittedEdit>, RecordingUnavailable>;
    find(
      editor: Requester,
      id: number,
    ): Effect.Effect<Option.Option<SubmittedEdit>, RecordingUnavailable>;
    handlePending<E, R>(
      handler: EditHandler<E, R>,
    ): Effect.Effect<void, RecordingUnavailable | E, R>;
  }
>()("recording-requests/RecordingEdits") {
  static readonly makeWith = (ready: Effect.Effect<void>, connected: Connected) => {
    const onceReady = <A, E extends Error, R>(query: Effect.Effect<A, E, R>) =>
      ready.pipe(
        Effect.andThen(query),
        Effect.mapError((error) => RecordingUnavailable.make({ reason: error.message })),
        Effect.timeoutOrElse({
          duration: QUERY_TIMEOUT,
          orElse: () => unavailable("Timed out after 10 seconds"),
        }),
      );

    const submit = Effect.fn("RecordingEdits.submit")(
      (editor: Requester, recordingId: string, change: RecordingChange) =>
        connected(
          Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
            const encoded = yield* encodeChange(change).pipe(Effect.orDie);

            const rows = yield* onceReady(
              sql`
                INSERT INTO office.recording_edits (recording_id, edited_by, edited_by_name, kind, change)
                SELECT id, ${editor.id}, ${editor.name}, ${change.kind}, ${encoded}::jsonb
                FROM office.recordings
                WHERE id = ${recordingId} AND ${sql.and(targetsOf(sql, change))}
                RETURNING id, outcome, reason
              `.pipe(Effect.flatMap(decodeSubmitted)),
            );

            return Option.map(Option.fromUndefinedOr(rows[0]), toSubmitted);
          }),
        ),
    );

    const find = Effect.fn("RecordingEdits.find")((editor: Requester, id: number) =>
      connected((sql) =>
        onceReady(
          sql`
            SELECT id, outcome, reason FROM office.recording_edits
            WHERE id = ${id} AND edited_by = ${editor.id}
          `.pipe(Effect.flatMap(decodeSubmitted)),
        ),
      ).pipe(Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), toSubmitted))),
    );

    const resolve = (
      sql: SqlClient.SqlClient,
      id: number,
      outcome: "applied" | "ignored",
      reason: EditIgnoreReason | null,
    ) =>
      sql`
        UPDATE office.recording_edits
        SET handled_at = now(), outcome = ${outcome}, reason = ${reason}
        WHERE id = ${id} AND handled_at IS NULL
      `;

    const ignore = (sql: SqlClient.SqlClient, id: number, reason: EditIgnoreReason) =>
      onceReady(resolve(sql, id, "ignored", reason)).pipe(
        Effect.andThen(
          Effect.logInfo("Ignored a recording edit").pipe(Effect.annotateLogs({ reason })),
        ),
      );

    const apply = Effect.fnUntraced(function* <E, R>(
      sql: SqlClient.SqlClient,
      edit: RecordingEdit,
      handler: EditHandler<E, R>,
    ) {
      yield* ready;

      const applied = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const made = yield* handler.apply(edit);

            yield* resolve(sql, edit.id, "applied", null);

            return made;
          }),
        )
        .pipe(Effect.catchIf(SqlError.isSqlError, (error) => unavailable(error.message)));

      yield* Effect.logInfo("Applied a recording edit");
      yield* applied.afterCommit;
    });

    const handlePending = Effect.fn("RecordingEdits.handlePending")(
      <E, R>(handler: EditHandler<E, R>) =>
        connected(
          Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
            const pending = yield* onceReady(
              sql`
                SELECT e.id, e.recording_id, e.edited_by, e.edited_by_name, e.change,
                       r.stopped_at IS NOT NULL AS stopped, r.finished_at IS NOT NULL AS finished,
                       r.slack_ts IS NOT NULL AS posted
                FROM office.recording_edits e
                JOIN office.recordings r ON r.id = e.recording_id
                WHERE e.handled_at IS NULL
                ORDER BY e.id
              `.pipe(Effect.flatMap(decodePending)),
            );

            for (const row of pending) {
              const change = decodeChange(row.change);

              if (Option.isNone(change)) {
                yield* ignore(sql, row.id, "unreadable").pipe(
                  Effect.annotateLogs({ edit: row.id }),
                );

                continue;
              }

              const edit: RecordingEdit = {
                id: row.id,
                recordingId: row.recordingId,
                editedBy: row.editedBy,
                editedByName: row.editedByName,
                change: change.value,
              };

              yield* Match.valueTags(decideEdit(row, edit.change), {
                Apply: () => apply(sql, edit, handler),
                Ignore: ({ reason }) => ignore(sql, edit.id, reason),
              }).pipe(
                Effect.annotateLogs({
                  edit: edit.id,
                  recordingId: edit.recordingId,
                  kind: edit.change.kind,
                }),
              );
            }
          }),
        ),
    );

    return RecordingEdits.of({ submit, find, handlePending });
  };

  static readonly make = Effect.fnUntraced(function* (ready: Effect.Effect<void>) {
    const sql = yield* SqlClient.SqlClient;

    return RecordingEdits.makeWith(ready, (use) => use(sql));
  });

  static readonly layerPerCall = <E extends Error>(
    connection: Layer.Layer<SqlClient.SqlClient, E>,
  ) =>
    Layer.succeed(
      RecordingEdits,
      RecordingEdits.makeWith(Effect.void, (use) =>
        Effect.scopedWith((scope) =>
          Layer.buildWithScope(Layer.fresh(connection), scope).pipe(
            Effect.mapError((error) => RecordingUnavailable.make({ reason: error.message })),
            Effect.flatMap((context) => use(Context.get(context, SqlClient.SqlClient))),
          ),
        ),
      ),
    );

  static readonly layer = Layer.effect(RecordingEdits, RecordingEdits.make(Effect.void));

  static readonly layerDisabled = Layer.succeed(
    RecordingEdits,
    RecordingEdits.of({
      submit: () => unavailable("Nothing is recorded"),
      find: () => unavailable("Nothing is recorded"),
      handlePending: () => unavailable("Nothing is recorded"),
    }),
  );
}
