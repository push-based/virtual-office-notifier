import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import {
  type ConsentStatus,
  Decisive,
  ErasureOutcome,
  standingOf,
  type SubmittedErasure,
  type SubmittedWithdrawal,
  WithdrawalOutcome,
} from "./Consent.ts";
import {
  type Committable,
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

export interface ConsentChange {
  readonly id: number;
  readonly userId: string;
}

export type Withdrawal = ConsentChange;

export type Erasure = ConsentChange;

export interface WithdrawalHandler<E, R> {
  withdraw(withdrawal: Withdrawal): Effect.Effect<Committable<E, R>, E, R>;
}

export interface ErasureHandler<E, R> {
  prepare(erasure: Erasure): Effect.Effect<void, E, R>;
  erase(erasure: Erasure): Effect.Effect<Committable<E, R>, E, R>;
}

type RequestKind = "withdraw" | "erase";

const SubmittedRow = Schema.Struct({ id: RowId, outcome: Schema.NullOr(WithdrawalOutcome) });

const ErasureRow = Schema.Struct({ id: RowId, outcome: Schema.NullOr(ErasureOutcome) });

const UserId = Schema.Struct({ userId: Schema.String });

const PendingRow = Schema.Struct({ id: RowId, userId: Schema.String });

const PendingId = Schema.Struct({ id: RowId });

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

const pendingOf = (sql: SqlClient.SqlClient, kind: RequestKind) =>
  SqlSchema.findOneOption({
    Request: UserId,
    Result: PendingId,
    execute: ({ userId }) => sql`
      SELECT id FROM office.consent_requests
      WHERE user_id = ${userId} AND kind = ${kind} AND handled_at IS NULL
      ORDER BY id
      LIMIT 1
    `,
  });

const insertRequest = (sql: SqlClient.SqlClient, kind: RequestKind) =>
  SqlSchema.findOne({
    Request: UserId,
    Result: PendingId,
    execute: ({ userId }) => sql`
      INSERT INTO office.consent_requests (user_id, kind)
      VALUES (${userId}, ${kind})
      RETURNING id
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

const findErasure = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.Finite, userId: Schema.String }),
    Result: ErasureRow,
    execute: ({ id, userId }) => sql`
      SELECT id, outcome FROM office.consent_requests
      WHERE id = ${id} AND kind = 'erase' AND (user_id = ${userId} OR outcome = 'erased')
    `,
  });

const findPending = (sql: SqlClient.SqlClient, kind: RequestKind) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingRow,
    execute: () => sql`
      SELECT id, user_id FROM office.consent_requests
      WHERE handled_at IS NULL AND kind = ${kind}
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
    erase(userId: string): Effect.Effect<SubmittedErasure, RecordingUnavailable>;
    findErasure(
      userId: string,
      id: number,
    ): Effect.Effect<Option.Option<SubmittedErasure>, RecordingUnavailable>;
    handleWithdrawals<E, R>(
      handler: WithdrawalHandler<E, R>,
    ): Effect.Effect<void, RecordingUnavailable | E, R>;
    handleErasures<E, R>(
      handler: ErasureHandler<E, R>,
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
          const withdrawal = yield* onceReady(pendingOf(sql, "withdraw")({ userId }));
          const erasure = yield* onceReady(pendingOf(sql, "erase")({ userId }));
          const { standing, since } = standingOf(latest);

          const current: ConsentStatus = {
            standing,
            since: Option.getOrNull(since),
            pendingWithdrawal: Option.getOrNull(Option.map(withdrawal, ({ id }) => id)),
            pendingErasure: Option.getOrNull(Option.map(erasure, ({ id }) => id)),
          };

          return current;
        }),
      ),
    );

    const submit = (sql: SqlClient.SqlClient, kind: RequestKind, userId: string) =>
      onceReady(
        pendingOf(
          sql,
          kind,
        )({ userId }).pipe(
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () => insertRequest(sql, kind)({ userId }),
            }),
          ),
          Effect.map(({ id }) => ({ id, outcome: null })),
        ),
      );

    const withdraw = Effect.fn("ConsentRequests.withdraw")((userId: string) =>
      connected((sql) => submit(sql, "withdraw", userId)),
    );

    const find = Effect.fn("ConsentRequests.find")((userId: string, id: number) =>
      connected((sql) => onceReady(findWithdrawal(sql)({ id, userId }))),
    );

    const erase = Effect.fn("ConsentRequests.erase")((userId: string) =>
      connected((sql) => submit(sql, "erase", userId)),
    );

    const findErasureOf = Effect.fn("ConsentRequests.findErasure")((userId: string, id: number) =>
      connected((sql) => onceReady(findErasure(sql)({ id, userId }))),
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

    const recordErasure = (sql: SqlClient.SqlClient, erasure: Erasure) =>
      Effect.all([
        sql`DELETE FROM office.consent_events WHERE user_id = ${erasure.userId}`,
        sql`
          DELETE FROM office.consent_requests
          WHERE user_id = ${erasure.userId} AND id <> ${erasure.id}
        `,
        sql`
          UPDATE office.consent_requests
          SET handled_at = now(), outcome = 'erased', user_id = NULL
          WHERE id = ${erasure.id} AND handled_at IS NULL
        `,
      ]);

    const eraseOne = <E, R>(
      sql: SqlClient.SqlClient,
      erasure: Erasure,
      handler: ErasureHandler<E, R>,
    ) =>
      handler
        .prepare(erasure)
        .pipe(
          Effect.andThen(
            committing(
              sql,
              handler.erase(erasure),
              () => recordErasure(sql, erasure),
              Effect.logInfo("Erased everything held about someone"),
            ),
          ),
          Effect.annotateLogs({ erasure: erasure.id }),
        );

    const handleEach =
      (kind: RequestKind) =>
      <E, R>(
        handleOne: (sql: SqlClient.SqlClient, change: ConsentChange) => Effect.Effect<void, E, R>,
      ) =>
        connected(
          Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
            const pending = yield* onceReady(findPending(sql, kind)()).pipe(
              Effect.withTracerEnabled(false),
            );

            if (pending.length === 0) return;

            yield* Effect.forEach(pending, (change) => handleOne(sql, change), {
              discard: true,
            }).pipe(Effect.withSpan(`ConsentRequests.handle.${kind}`));
          }),
        );

    const handleWithdrawals = <E, R>(handler: WithdrawalHandler<E, R>) =>
      handleEach("withdraw")((sql, withdrawal) => handleOne(sql, withdrawal, handler));

    const handleErasures = <E, R>(handler: ErasureHandler<E, R>) =>
      handleEach("erase")((sql, erasure) => eraseOne(sql, erasure, handler));

    return ConsentRequests.of({
      status,
      withdraw,
      find,
      erase,
      findErasure: findErasureOf,
      handleWithdrawals,
      handleErasures,
    });
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
      erase: () => unavailable("Nothing is recorded"),
      findErasure: () => unavailable("Nothing is recorded"),
      handleWithdrawals: () => Effect.void,
      handleErasures: () => Effect.void,
    }),
  );
}
