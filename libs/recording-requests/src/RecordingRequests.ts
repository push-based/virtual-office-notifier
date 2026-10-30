import { Context, Duration, Effect, Layer, Match, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";

import type { Requester } from "./RecordingApi.ts";
import {
  type ActiveRecording,
  decideRequest,
  endsAt,
  explain,
  IgnoreReason,
  Occupant,
  type RecordingRequest,
  type RecordingStatus,
  RequestAction,
  type RequestOutcome,
  RowId,
  type SubmittedRequest,
} from "./RecordingRequest.ts";

const QUERY_TIMEOUT = Duration.seconds(10);

export class RecordingUnavailable extends Schema.TaggedError<RecordingUnavailable>()(
  "RecordingUnavailable",
  {
    reason: Schema.String,
  },
) {}

export interface Situation {
  readonly occupants: ReadonlySet<string>;
  readonly active: Option.Option<ActiveRecording>;
}

export interface Change<E, R> {
  readonly recordingId: string;
  readonly afterCommit: Effect.Effect<void, E, R>;
}

export interface RequestHandler<E, R> {
  readonly situation: Effect.Effect<Situation, E, R>;
  start(request: RecordingRequest): Effect.Effect<Change<E, R>, E, R>;
  stop(request: RecordingRequest, recording: ActiveRecording): Effect.Effect<Change<E, R>, E, R>;
}

export interface StatusUpdate {
  readonly recordingId: string | null;
  readonly botInOffice: boolean;
  readonly occupants: ReadonlyArray<Occupant>;
}

const SubmittedRow = Schema.Union([
  Schema.Struct({ id: RowId, outcome: Schema.Null, reason: Schema.Null }),
  Schema.Struct({
    id: RowId,
    outcome: Schema.Literals(["started", "stopped"]),
    reason: Schema.Null,
  }),
  Schema.Struct({ id: RowId, outcome: Schema.Literal("ignored"), reason: IgnoreReason }),
]);

const decodeSubmitted = Schema.decodeUnknownEffect(Schema.Array(SubmittedRow));

const toSubmitted = (row: typeof SubmittedRow.Type): SubmittedRequest =>
  row.outcome === "ignored"
    ? { id: row.id, outcome: row.outcome, reason: row.reason, explanation: explain(row.reason) }
    : { id: row.id, outcome: row.outcome };

const decodePending = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: RowId,
      requestedAt: Schema.DateTimeUtcFromDate,
      requestedBy: Schema.String,
      requestedByName: Schema.String,
      action: RequestAction,
      checkedAt: Schema.DateTimeUtcFromDate,
    }),
  ),
);

const decodeStatus = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      botInOffice: Schema.Boolean,
      occupants: Schema.Array(Occupant),
      updatedAt: Schema.DateTimeUtcFromDate,
      recordingId: Schema.NullOr(Schema.String),
      startedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
      startedBy: Schema.NullOr(Schema.String),
      startedByName: Schema.NullOr(Schema.String),
    }),
  ),
);

const unavailable = (reason: string) => Effect.fail(new RecordingUnavailable({ reason }));

export class RecordingRequests extends Context.Service<
  RecordingRequests,
  {
    submit(
      requester: Requester,
      action: RequestAction,
    ): Effect.Effect<SubmittedRequest, RecordingUnavailable>;
    find(
      requester: Requester,
      id: number,
    ): Effect.Effect<Option.Option<SubmittedRequest>, RecordingUnavailable>;
    readonly status: Effect.Effect<RecordingStatus, RecordingUnavailable>;
    handlePending<E, R>(
      handler: RequestHandler<E, R>,
    ): Effect.Effect<void, RecordingUnavailable | E, R>;
    publishStatus(status: StatusUpdate): Effect.Effect<void, RecordingUnavailable>;
  }
>()("recording-requests/RecordingRequests") {
  static readonly make = (ready: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const onceReady = <A, E extends Error, R>(query: Effect.Effect<A, E, R>) =>
        ready.pipe(
          Effect.andThen(query),
          Effect.mapError((error) => new RecordingUnavailable({ reason: error.message })),
          Effect.timeoutOrElse({
            duration: QUERY_TIMEOUT,
            orElse: () => unavailable("Timed out after 10 seconds"),
          }),
        );

      const submit = Effect.fn("RecordingRequests.submit")(function* (
        requester: Requester,
        action: RequestAction,
      ) {
        const rows = yield* onceReady(
          sql`
            INSERT INTO office.recording_requests ${sql.insert({ requestedBy: requester.id, requestedByName: requester.name, action })}
            RETURNING id, outcome, reason
          `.pipe(Effect.flatMap(decodeSubmitted)),
        );

        const [row] = rows;

        return row === undefined
          ? yield* unavailable("The request wasn't stored")
          : toSubmitted(row);
      });

      const find = Effect.fn("RecordingRequests.find")((requester: Requester, id: number) =>
        onceReady(
          sql`
            SELECT id, outcome, reason FROM office.recording_requests
            WHERE id = ${id} AND requested_by = ${requester.id}
          `.pipe(Effect.flatMap(decodeSubmitted)),
        ).pipe(Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), toSubmitted))),
      );

      const status = Effect.gen(function* () {
        const rows = yield* onceReady(
          sql`
            SELECT s.bot_in_office, s.occupants, s.updated_at, r.id AS recording_id, r.started_at, r.started_by,
                   coalesce(m.real_name, m.display_name) AS started_by_name
            FROM office.recording_status s
            LEFT JOIN office.recordings r ON r.id = s.recording_id AND r.stopped_at IS NULL
            LEFT JOIN office.members m ON m.user_id = r.started_by
          `.pipe(Effect.flatMap(decodeStatus)),
        );

        const [row] = rows;

        if (row === undefined) return yield* unavailable("The recording status row is missing");

        const recording =
          row.recordingId === null || row.startedAt === null || row.startedBy === null
            ? null
            : {
                id: row.recordingId,
                startedAt: row.startedAt,
                startedByName: row.startedByName ?? row.startedBy,
                endsAt: endsAt({
                  id: row.recordingId,
                  startedAt: row.startedAt,
                  startedBy: row.startedBy,
                }),
              };

        const current: RecordingStatus = {
          botInOffice: row.botInOffice,
          occupants: row.occupants,
          recording,
          updatedAt: row.updatedAt,
        };

        return current;
      }).pipe(Effect.withSpan("RecordingRequests.status"));

      const resolve = (
        request: RecordingRequest,
        outcome: RequestOutcome,
        reason: IgnoreReason | null,
        recordingId: string | null,
      ) =>
        sql`
          UPDATE office.recording_requests
          SET handled_at = now(), outcome = ${outcome}, reason = ${reason}, recording_id = ${recordingId}
          WHERE id = ${request.id} AND handled_at IS NULL
        `;

      const act = <E, R>(
        request: RecordingRequest,
        outcome: Exclude<RequestOutcome, "ignored">,
        change: Effect.Effect<Change<E, R>, E, R>,
      ) =>
        Effect.gen(function* () {
          yield* ready;

          const committed = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const made = yield* change;

                yield* resolve(request, outcome, null, made.recordingId);

                return made;
              }),
            )
            .pipe(Effect.catchIf(SqlError.isSqlError, (error) => unavailable(error.message)));

          yield* committed.afterCommit;
        });

      const handlePending = Effect.fn("RecordingRequests.handlePending")(function* <E, R>(
        handler: RequestHandler<E, R>,
      ) {
        const pending = yield* onceReady(
          sql`
            SELECT id, requested_at, requested_by, requested_by_name, action, now() AS checked_at
            FROM office.recording_requests
            WHERE handled_at IS NULL
            ORDER BY id
          `.pipe(Effect.flatMap(decodePending)),
        );

        for (const request of pending) {
          const { occupants, active } = yield* handler.situation;

          yield* Match.valueTags(decideRequest(request, occupants, active, request.checkedAt), {
            Start: () => act(request, "started", handler.start(request)),
            Stop: ({ recording }) => act(request, "stopped", handler.stop(request, recording)),
            Ignore: ({ reason }) =>
              onceReady(resolve(request, "ignored", reason, null)).pipe(
                Effect.andThen(
                  Effect.logInfo("Ignored a recording request").pipe(
                    Effect.annotateLogs({ reason }),
                  ),
                ),
              ),
          }).pipe(Effect.annotateLogs({ request: request.id, action: request.action }));
        }
      });

      const publishStatus = Effect.fn("RecordingRequests.publishStatus")(
        (update: StatusUpdate) =>
          onceReady(
            sql`
              UPDATE office.recording_status
              SET recording_id = ${update.recordingId}, bot_in_office = ${update.botInOffice},
                  occupants = ${JSON.stringify(update.occupants)}::jsonb, updated_at = now()
            `,
          ),
        Effect.asVoid,
      );

      return RecordingRequests.of({ submit, find, status, handlePending, publishStatus });
    });

  static readonly layer = Layer.effect(RecordingRequests, RecordingRequests.make(Effect.void));

  static readonly layerDisabled = Layer.succeed(
    RecordingRequests,
    RecordingRequests.of({
      submit: () => unavailable("Nothing is recorded"),
      find: () => unavailable("Nothing is recorded"),
      status: unavailable("Nothing is recorded"),
      handlePending: () => unavailable("Nothing is recorded"),
      publishStatus: () => Effect.void,
    }),
  );
}
