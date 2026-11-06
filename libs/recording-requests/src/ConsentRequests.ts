import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import {
  type ConsentStatus,
  Decisive,
  standingOf,
  type SubmittedWithdrawal,
  WithdrawalOutcome,
} from "./Consent.ts";
import {
  type Connected,
  connectedPerCall,
  connectedTo,
  guardQuery,
  guardTransaction,
} from "./Query.ts";
import { RowId } from "./RecordingRequest.ts";
import {
  recordingUnavailable,
  type RecordingUnavailable,
  recordingUnreadable,
} from "./RecordingRequests.ts";
import { CONSENT_NOTICE_VERSION } from "./Wire.ts";

export interface Withdrawal {
  readonly id: number;
  readonly userId: string;
}

export interface WithdrawnConsent<E, R> {
  readonly afterCommit: Effect.Effect<void, E, R>;
}

export interface WithdrawalHandler<E, R> {
  withdraw(withdrawal: Withdrawal): Effect.Effect<WithdrawnConsent<E, R>, E, R>;
}

const SubmittedRow = Schema.Struct({ id: RowId, outcome: Schema.NullOr(WithdrawalOutcome) });

const UserId = Schema.Struct({ userId: Schema.String });

const PendingRow = Schema.Struct({ id: RowId, userId: Schema.String });

const latestDecisive = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: UserId,
    Result: Decisive,
    execute: ({ userId }) => sql`
      SELECT kind, notice_version, happened_at FROM office.consent_events
      WHERE user_id = ${userId} AND kind IN ('agreed', 'withdrawn')
      ORDER BY id DESC
      LIMIT 1
    `,
  });

const pendingOf = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: UserId,
    Result: SubmittedRow,
    execute: ({ userId }) => sql`
      SELECT id, outcome FROM office.consent_requests
      WHERE user_id = ${userId} AND kind = 'withdraw' AND handled_at IS NULL
      ORDER BY id
      LIMIT 1
    `,
  });

const insertWithdrawal = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOne({
    Request: UserId,
    Result: SubmittedRow,
    execute: ({ userId }) => sql`
      INSERT INTO office.consent_requests (user_id, kind)
      VALUES (${userId}, 'withdraw')
      RETURNING id, outcome
    `,
  });

const findWithdrawal = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.Finite, userId: Schema.String }),
    Result: SubmittedRow,
    execute: ({ id, userId }) => sql`
      SELECT id, outcome FROM office.consent_requests
      WHERE id = ${id} AND user_id = ${userId} AND kind = 'withdraw'
    `,
  });

const findPending = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingRow,
    execute: () => sql`
      SELECT id, user_id FROM office.consent_requests
      WHERE handled_at IS NULL
      ORDER BY id
    `,
  });

const unavailable = (reason: string) => Effect.fail(recordingUnavailable(reason));

export class ConsentRequests extends Context.Service<
  ConsentRequests,
  {
    status(userId: string): Effect.Effect<ConsentStatus, RecordingUnavailable>;
    withdraw(userId: string): Effect.Effect<SubmittedWithdrawal, RecordingUnavailable>;
    find(
      userId: string,
      id: number,
    ): Effect.Effect<Option.Option<SubmittedWithdrawal>, RecordingUnavailable>;
    handlePending<E, R>(
      handler: WithdrawalHandler<E, R>,
    ): Effect.Effect<void, RecordingUnavailable | E, R>;
  }
>()("recording-requests/ConsentRequests") {
  static readonly makeWith = (
    ready: Effect.Effect<void>,
    connected: Connected<RecordingUnavailable>,
  ) => {
    const guard = { ready, unavailable: recordingUnavailable, unreadable: recordingUnreadable };
    const onceReady = guardQuery(guard);
    const committing = guardTransaction(guard);

    const status = Effect.fn("ConsentRequests.status")((userId: string) =>
      connected(
        Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
          const latest = yield* onceReady(latestDecisive(sql)({ userId }));
          const pending = yield* onceReady(pendingOf(sql)({ userId }));
          const { standing, since } = standingOf(latest);

          const current: ConsentStatus = {
            standing,
            since: Option.getOrNull(since),
            pendingWithdrawal: Option.getOrNull(Option.map(pending, ({ id }) => id)),
          };

          return current;
        }),
      ),
    );

    const withdraw = Effect.fn("ConsentRequests.withdraw")((userId: string) =>
      connected((sql) =>
        onceReady(
          pendingOf(sql)({ userId }).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => insertWithdrawal(sql)({ userId }),
              }),
            ),
          ),
        ),
      ),
    );

    const find = Effect.fn("ConsentRequests.find")((userId: string, id: number) =>
      connected((sql) => onceReady(findWithdrawal(sql)({ id, userId }))),
    );

    const resolve = (sql: SqlClient.SqlClient, id: number, outcome: WithdrawalOutcome) =>
      sql`
        UPDATE office.consent_requests
        SET handled_at = now(), outcome = ${outcome}
        WHERE id = ${id} AND handled_at IS NULL
      `;

    const recordWithdrawal = (sql: SqlClient.SqlClient, withdrawal: Withdrawal) =>
      sql`
        INSERT INTO office.consent_events (user_id, happened_at, kind, notice_version)
        VALUES (${withdrawal.userId}, now(), 'withdrawn', ${CONSENT_NOTICE_VERSION})
      `.pipe(Effect.andThen(resolve(sql, withdrawal.id, "withdrawn")));

    const handleOne = <E, R>(
      sql: SqlClient.SqlClient,
      withdrawal: Withdrawal,
      handler: WithdrawalHandler<E, R>,
    ) =>
      Effect.gen(function* () {
        const latest = yield* onceReady(latestDecisive(sql)({ userId: withdrawal.userId }));

        if (standingOf(latest).standing !== "agreed")
          return yield* onceReady(resolve(sql, withdrawal.id, "ignored")).pipe(
            Effect.andThen(Effect.logInfo("Ignored a consent withdrawal with nothing to withdraw")),
          );

        yield* committing(
          sql,
          handler.withdraw(withdrawal),
          () => recordWithdrawal(sql, withdrawal),
          Effect.logInfo("Withdrew someone's consent"),
        );
      }).pipe(Effect.annotateLogs({ withdrawal: withdrawal.id }));

    const handlePending = <E, R>(handler: WithdrawalHandler<E, R>) =>
      connected(
        Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
          const pending = yield* onceReady(findPending(sql)()).pipe(
            Effect.withTracerEnabled(false),
          );

          if (pending.length === 0) return;

          yield* Effect.forEach(pending, (withdrawal) => handleOne(sql, withdrawal, handler), {
            discard: true,
          }).pipe(Effect.withSpan("ConsentRequests.handlePending"));
        }),
      );

    return ConsentRequests.of({ status, withdraw, find, handlePending });
  };

  static readonly make = Effect.fnUntraced(function* (ready: Effect.Effect<void>) {
    const sql = yield* SqlClient.SqlClient;

    return ConsentRequests.makeWith(ready, connectedTo(sql));
  });

  static readonly layerPerCall = <E extends Error>(
    connection: Layer.Layer<SqlClient.SqlClient, E>,
  ) =>
    Layer.succeed(
      ConsentRequests,
      ConsentRequests.makeWith(Effect.void, connectedPerCall(connection, recordingUnavailable)),
    );

  static readonly layer = Layer.effect(ConsentRequests, ConsentRequests.make(Effect.void));

  static readonly layerDisabled = Layer.succeed(
    ConsentRequests,
    ConsentRequests.of({
      status: () => unavailable("Nothing is recorded"),
      withdraw: () => unavailable("Nothing is recorded"),
      find: () => unavailable("Nothing is recorded"),
      handlePending: () => Effect.void,
    }),
  );
}
