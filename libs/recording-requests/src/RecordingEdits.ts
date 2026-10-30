import { Context, Effect, Layer, Match, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type Statement } from "effect/sql";

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
import {
  type Connected,
  connectedPerCall,
  connectedTo,
  guardQuery,
  guardTransaction,
} from "./Query.ts";
import {
  recordingUnavailable,
  RecordingUnavailable,
  recordingUnreadable,
} from "./RecordingRequests.ts";

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

const toSubmitted = (row: typeof SubmittedRow.Type): SubmittedEdit =>
  row.outcome === "ignored"
    ? { id: row.id, outcome: row.outcome, reason: row.reason, explanation: explainEdit(row.reason) }
    : { id: row.id, outcome: row.outcome };

const PendingRow = Schema.Struct({
  id: RowId,
  recordingId: Schema.String,
  editedBy: Schema.String,
  editedByName: Schema.String,
  change: Schema.Unknown,
  stopped: Schema.Boolean,
  finished: Schema.Boolean,
  posted: Schema.Boolean,
});

const NewEdit = Schema.Struct({
  recordingId: Schema.String,
  editedBy: Schema.String,
  editedByName: Schema.String,
  kind: Schema.String,
  change: Schema.fromJsonString(RecordingChange),
});

const decodeChange = Schema.decodeUnknownOption(RecordingChange);

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

const insertEdit = (sql: SqlClient.SqlClient, targets: ReadonlyArray<Statement.Fragment>) =>
  SqlSchema.findOneOption({
    Request: NewEdit,
    Result: SubmittedRow,
    execute: ({ recordingId, editedBy, editedByName, kind, change }) => sql`
      INSERT INTO office.recording_edits (recording_id, edited_by, edited_by_name, kind, change)
      SELECT id, ${editedBy}, ${editedByName}, ${kind}, ${change}::jsonb
      FROM office.recordings
      WHERE id = ${recordingId} AND ${sql.and(targets)}
      RETURNING id, outcome, reason
    `,
  });

const findEdit = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.Finite, editedBy: Schema.String }),
    Result: SubmittedRow,
    execute: ({ id, editedBy }) => sql`
      SELECT id, outcome, reason FROM office.recording_edits
      WHERE id = ${id} AND edited_by = ${editedBy}
    `,
  });

const findPending = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingRow,
    execute: () => sql`
      SELECT e.id, e.recording_id, e.edited_by, e.edited_by_name, e.change,
             r.stopped_at IS NOT NULL AS stopped, r.finished_at IS NOT NULL AS finished,
             r.slack_ts IS NOT NULL AS posted
      FROM office.recording_edits e
      JOIN office.recordings r ON r.id = e.recording_id
      WHERE e.handled_at IS NULL
      ORDER BY e.id
    `,
  });

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
  static readonly makeWith = (
    ready: Effect.Effect<void>,
    connected: Connected<RecordingUnavailable>,
  ) => {
    const guard = { ready, unavailable: recordingUnavailable, unreadable: recordingUnreadable };
    const onceReady = guardQuery(guard);
    const committing = guardTransaction(guard);

    const submit = Effect.fn("RecordingEdits.submit")(
      (editor: Requester, recordingId: string, change: RecordingChange) =>
        connected((sql) =>
          onceReady(
            insertEdit(
              sql,
              targetsOf(sql, change),
            )({
              recordingId,
              editedBy: editor.id,
              editedByName: editor.name,
              kind: change.kind,
              change,
            }),
          ),
        ),
      Effect.map(Option.map(toSubmitted)),
    );

    const find = Effect.fn("RecordingEdits.find")(
      (editor: Requester, id: number) =>
        connected((sql) => onceReady(findEdit(sql)({ id, editedBy: editor.id }))),
      Effect.map(Option.map(toSubmitted)),
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

    const apply = <E, R>(
      sql: SqlClient.SqlClient,
      edit: RecordingEdit,
      handler: EditHandler<E, R>,
    ) =>
      committing(
        sql,
        handler.apply(edit),
        () => resolve(sql, edit.id, "applied", null),
        Effect.logInfo("Applied a recording edit"),
      );

    const handlePending = <E, R>(handler: EditHandler<E, R>) =>
      connected(
        Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
          const pending = yield* onceReady(findPending(sql)()).pipe(
            Effect.withTracerEnabled(false),
          );

          if (pending.length === 0) return;

          yield* Effect.gen(function* () {
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
          }).pipe(Effect.withSpan("RecordingEdits.handlePending"));
        }),
      );

    return RecordingEdits.of({ submit, find, handlePending });
  };

  static readonly make = Effect.fnUntraced(function* (ready: Effect.Effect<void>) {
    const sql = yield* SqlClient.SqlClient;

    return RecordingEdits.makeWith(ready, connectedTo(sql));
  });

  static readonly layerPerCall = <E extends Error>(
    connection: Layer.Layer<SqlClient.SqlClient, E>,
  ) =>
    Layer.succeed(
      RecordingEdits,
      RecordingEdits.makeWith(Effect.void, connectedPerCall(connection, recordingUnavailable)),
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
