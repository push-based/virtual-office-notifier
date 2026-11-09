import { Array, Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import { Admin } from "./Admins.ts";
import {
  type ConsentStanding,
  type ConsentStatus,
  Decisive,
  type ErasureCase,
  ErasureDecision,
  ErasureOutcome,
  type ErasureRefusal,
  type PendingErasure,
  Refusal,
  RefusalGround,
  standingOf,
  type SubmittedErasure,
  type SubmittedWithdrawal,
  WithdrawalOutcome,
} from "./Consent.ts";
import { inventoryOf } from "./ErasureInventory.ts";
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
import { CONSENT_NOTICE_VERSION, ERASURE_REVIEW_DAYS, ERASURE_WAIT_MS } from "./Wire.ts";

export const ERASURE_TIMEOUT = Duration.minutes(10);

export interface ConsentChange {
  readonly id: number;
  readonly userId: string;
}

export type Withdrawal = ConsentChange;

export type Erasure = ConsentChange;

export type Settled = "refused" | "cancelled";

export interface WithdrawalHandler<E, R> {
  withdraw(
    withdrawal: Withdrawal,
    recorded: ConsentStanding,
  ): Effect.Effect<Option.Option<Committable<E, R>>, E, R>;
}

export interface ErasureHandler<E, R> {
  announce(erasure: ErasureCase): Effect.Effect<void, E, R>;
  settle(erasure: ErasureCase, outcome: Settled): Effect.Effect<Committable<E, R>, E, R>;
  prepare(erasure: ErasureCase): Effect.Effect<void, E, R>;
  erase(erasure: ErasureCase): Effect.Effect<Option.Option<Committable<E, R>>, E, R>;
}

export type NoticeMedium = "discord" | "slack";

export interface ErasureNotice {
  readonly requestId: number;
  readonly medium: NoticeMedium;
  readonly recipient: string;
  readonly channel: string;
  readonly messageId: string;
}

type RequestKind = "withdraw" | "erase";

const SubmittedRow = Schema.Struct({ id: RowId, outcome: Schema.NullOr(WithdrawalOutcome) });

const ErasureRow = Schema.Struct({
  id: RowId,
  outcome: Schema.NullOr(ErasureOutcome),
  dueAt: Schema.DateTimeUtcFromDate,
});

const UserId = Schema.Struct({ userId: Schema.String });

const PendingRow = Schema.Struct({ id: RowId, userId: Schema.String });

const PendingId = Schema.Struct({ id: RowId });

const PendingErasureRow = Schema.Struct({
  id: RowId,
  requestedAt: Schema.DateTimeUtcFromDate,
  dueAt: Schema.DateTimeUtcFromDate,
  decision: Schema.NullOr(ErasureDecision),
});

const RefusalRow = Schema.Struct({
  id: RowId,
  refusedAt: Schema.DateTimeUtcFromDate,
  ground: RefusalGround,
  reason: Schema.String,
});

const SeenBy = Schema.fromJsonString(Schema.Array(Schema.String));

const SeenByNames = Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String)));

const CaseRow = Schema.Struct({
  id: RowId,
  userId: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  requestedAt: Schema.DateTimeUtcFromDate,
  dueAt: Schema.DateTimeUtcFromDate,
  decision: Schema.NullOr(ErasureDecision),
  decidedBy: Schema.NullOr(Schema.String),
  decidedByName: Schema.NullOr(Schema.String),
  refusalGround: Schema.NullOr(RefusalGround),
  refusalReason: Schema.NullOr(Schema.String),
  announced: Schema.Boolean,
  due: Schema.Boolean,
  seenBy: SeenBy,
  seenByNames: SeenByNames,
});

const NoticeRow = Schema.Struct({
  requestId: RowId,
  medium: Schema.Literals(["discord", "slack"]),
  recipient: Schema.String,
  channel: Schema.String,
  messageId: Schema.String,
});

const Changed = Schema.Struct({ id: RowId });

const latestDecisive = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: UserId,
    Result: Decisive,
    execute: ({ userId }) => sql`
      SELECT kind, notice_version, happened_at FROM office.consent_events
      WHERE user_id = ${userId} AND kind IN ('agreed', 'withdrawn')
      ORDER BY happened_at DESC, id DESC
      LIMIT 1
    `,
  });

const agreedSince = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: Schema.String, id: Schema.Finite }),
    Result: PendingId,
    execute: ({ userId, id }) => sql`
      SELECT e.id FROM office.consent_events e, office.consent_requests r
      WHERE r.id = ${id} AND e.user_id = ${userId} AND e.kind = 'agreed'
        AND e.notice_version = ${CONSENT_NOTICE_VERSION} AND e.happened_at > r.requested_at
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

const pendingErasureOf = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: UserId,
    Result: PendingErasureRow,
    execute: ({ userId }) => sql`
      SELECT id, requested_at, due_at, decision FROM office.consent_requests
      WHERE user_id = ${userId} AND kind = 'erase' AND handled_at IS NULL
      ORDER BY id
      LIMIT 1
    `,
  });

const latestRefusalOf = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: UserId,
    Result: RefusalRow,
    execute: ({ userId }) => sql`
      SELECT id, handled_at AS refused_at, refusal_ground AS ground, refusal_reason AS reason
      FROM office.consent_requests
      WHERE user_id = ${userId} AND kind = 'erase' AND outcome = 'refused'
      ORDER BY id DESC
      LIMIT 1
    `,
  });

const insertWithdrawal = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOne({
    Request: UserId,
    Result: PendingId,
    execute: ({ userId }) => sql`
      INSERT INTO office.consent_requests (user_id, kind)
      VALUES (${userId}, 'withdraw')
      RETURNING id
    `,
  });

const insertErasure = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOne({
    Request: UserId,
    Result: PendingId,
    execute: ({ userId }) => sql`
      INSERT INTO office.consent_requests (user_id, kind, due_at)
      VALUES (${userId}, 'erase', now() + make_interval(days => ${ERASURE_REVIEW_DAYS}))
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
      SELECT id, outcome, due_at FROM office.consent_requests
      WHERE id = ${id} AND kind = 'erase'
        AND (
          user_id = ${userId}
          OR (outcome = 'erased' AND handled_at > now() - make_interval(secs => ${ERASURE_WAIT_MS / 1000}))
        )
    `,
  });

const findErasureById = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Finite,
    Result: ErasureRow,
    execute: (id) => sql`
      SELECT id, outcome, due_at FROM office.consent_requests
      WHERE id = ${id} AND kind = 'erase'
    `,
  });

const findPendingWithdrawals = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingRow,
    execute: () => sql`
      SELECT id, user_id FROM office.consent_requests
      WHERE handled_at IS NULL AND kind = 'withdraw'
      ORDER BY id
    `,
  });

const findCases = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: CaseRow,
    execute: () => sql`
      SELECT r.id, r.user_id, m.display_name, r.requested_at, r.due_at, r.decision,
             r.decided_by, d.name AS decided_by_name, r.refusal_ground, r.refusal_reason,
             r.announced_at IS NOT NULL AS announced,
             r.due_at <= now() AS due,
             r.seen_by::text AS seen_by,
             (
               SELECT coalesce(jsonb_agg(a.name ORDER BY s.position), '[]'::jsonb)
               FROM jsonb_array_elements_text(r.seen_by) WITH ORDINALITY AS s (user_id, position)
               LEFT JOIN office.admins a ON a.discord_user_id = s.user_id
             )::text AS seen_by_names
      FROM office.consent_requests r
      LEFT JOIN office.members m ON m.user_id = r.user_id
      LEFT JOIN office.admins d ON d.discord_user_id = r.decided_by
      WHERE r.kind = 'erase' AND r.handled_at IS NULL
      ORDER BY r.id
    `,
  });

const findAdmins = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: Admin,
    execute: () => sql`
      SELECT name, discord_user_id, slack_user_id FROM office.admins
      ORDER BY added_at, name
    `,
  });

const findAdmin = (sql: SqlClient.SqlClient) =>
  SqlSchema.findOneOption({
    Request: Schema.Struct({
      medium: Schema.Literals(["discord", "slack"]),
      userId: Schema.String,
    }),
    Result: Admin,
    execute: ({ medium, userId }) => sql`
      SELECT name, discord_user_id, slack_user_id FROM office.admins
      WHERE ${medium === "discord" ? sql`discord_user_id` : sql`slack_user_id`} = ${userId}
    `,
  });

const findNotices = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Finite,
    Result: NoticeRow,
    execute: (requestId) => sql`
      SELECT request_id, medium, recipient, channel, message_id FROM office.erasure_notices
      WHERE request_id = ${requestId}
      ORDER BY medium, recipient
    `,
  });

const unavailable = (reason: string) => Effect.fail(recordingUnavailable(reason));

interface ReviewedCase extends ErasureCase {
  readonly announced: boolean;
  readonly due: boolean;
}

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
    cancelErasure(
      userId: string,
      id: number,
    ): Effect.Effect<Option.Option<SubmittedErasure>, RecordingUnavailable>;
    cancelErasuresOf(userId: string): Effect.Effect<void, RecordingUnavailable>;
    pendingErasureOf(
      userId: string,
    ): Effect.Effect<Option.Option<PendingErasure>, RecordingUnavailable>;
    readonly cases: Effect.Effect<ReadonlyArray<ErasureCase>, RecordingUnavailable>;
    readonly admins: Effect.Effect<ReadonlyArray<Admin>, RecordingUnavailable>;
    adminOf(
      medium: NoticeMedium,
      userId: string,
    ): Effect.Effect<Option.Option<Admin>, RecordingUnavailable>;
    expedite(
      id: number,
      adminId: string,
    ): Effect.Effect<Option.Option<SubmittedErasure>, RecordingUnavailable>;
    refuse(
      id: number,
      adminId: string,
      refusal: ErasureRefusal,
    ): Effect.Effect<Option.Option<SubmittedErasure>, RecordingUnavailable>;
    seen(
      id: number,
      adminId: string,
    ): Effect.Effect<Option.Option<SubmittedErasure>, RecordingUnavailable>;
    recordNotice(notice: ErasureNotice): Effect.Effect<void, RecordingUnavailable>;
    noticesOf(requestId: number): Effect.Effect<ReadonlyArray<ErasureNotice>, RecordingUnavailable>;
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
    const committingSlowly = guardTransaction(guard, ERASURE_TIMEOUT);

    const toPending = (row: typeof PendingErasureRow.Type): PendingErasure => ({
      id: row.id,
      requestedAt: row.requestedAt,
      dueAt: row.dueAt,
      decision: row.decision,
    });

    const toRefusal = (row: typeof RefusalRow.Type): Refusal => ({
      id: row.id,
      refusedAt: row.refusedAt,
      ground: row.ground,
      reason: row.reason,
    });

    const toSubmitted = (row: typeof ErasureRow.Type): SubmittedErasure => ({
      id: row.id,
      outcome: row.outcome,
      dueAt: row.dueAt,
    });

    const status = Effect.fn("ConsentRequests.status")((userId: string) =>
      connected(
        Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
          const latest = yield* onceReady(latestDecisive(sql)({ userId }));
          const withdrawal = yield* onceReady(pendingOf(sql, "withdraw")({ userId }));
          const erasure = yield* onceReady(pendingErasureOf(sql)({ userId }));
          const refusal = yield* onceReady(latestRefusalOf(sql)({ userId }));
          const admin = yield* onceReady(findAdmin(sql)({ medium: "discord", userId }));
          const { standing, since } = standingOf(latest);

          const current: ConsentStatus = {
            standing,
            since: Option.getOrNull(since),
            pendingWithdrawal: Option.getOrNull(Option.map(withdrawal, ({ id }) => id)),
            pendingErasure: Option.getOrNull(Option.map(erasure, toPending)),
            refusedErasure: Option.getOrNull(Option.map(refusal, toRefusal)),
            admin: Option.isSome(admin),
          };

          return current;
        }),
      ),
    );

    const withdraw = Effect.fn("ConsentRequests.withdraw")((userId: string) =>
      connected((sql) =>
        onceReady(
          pendingOf(
            sql,
            "withdraw",
          )({ userId }).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => insertWithdrawal(sql)({ userId }),
              }),
            ),
            Effect.map(({ id }): SubmittedWithdrawal => ({ id, outcome: null })),
          ),
        ),
      ),
    );

    const find = Effect.fn("ConsentRequests.find")((userId: string, id: number) =>
      connected((sql) => onceReady(findWithdrawal(sql)({ id, userId }))),
    );

    const submittedById = (sql: SqlClient.SqlClient, id: number) =>
      findErasureById(sql)(id).pipe(Effect.map(Option.map(toSubmitted)));

    const erase = Effect.fn("ConsentRequests.erase")((userId: string) =>
      connected((sql) =>
        onceReady(
          pendingOf(
            sql,
            "erase",
          )({ userId }).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => insertErasure(sql)({ userId }),
              }),
            ),
            Effect.flatMap(({ id }) => submittedById(sql, id)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("An erasure request vanished as it was made"),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),
      ),
    );

    const findErasureOf = Effect.fn("ConsentRequests.findErasure")((userId: string, id: number) =>
      connected((sql) =>
        onceReady(findErasure(sql)({ id, userId }).pipe(Effect.map(Option.map(toSubmitted)))),
      ),
    );

    const pendingErasure = Effect.fn("ConsentRequests.pendingErasureOf")((userId: string) =>
      connected((sql) =>
        onceReady(pendingErasureOf(sql)({ userId }).pipe(Effect.map(Option.map(toPending)))),
      ),
    );

    const decideWhere = (
      sql: SqlClient.SqlClient,
      id: number,
      decision: "now" | "cancelled",
      by: string,
      ownedBy: Option.Option<string>,
    ) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: Changed,
        execute: () => sql`
          UPDATE office.consent_requests
          SET decision = ${decision}, decided_by = ${by}, decided_at = now(),
              due_at = CASE WHEN ${decision} = 'now' THEN now() ELSE due_at END
          WHERE id = ${id} AND kind = 'erase' AND handled_at IS NULL AND decision IS NULL
            ${Option.match(ownedBy, { onNone: () => sql.literal(""), onSome: (userId) => sql`AND user_id = ${userId}` })}
          RETURNING id
        `,
      })();

    const decided = (sql: SqlClient.SqlClient, id: number) => onceReady(submittedById(sql, id));

    const cancelErasure = Effect.fn("ConsentRequests.cancelErasure")((userId: string, id: number) =>
      connected((sql) =>
        onceReady(decideWhere(sql, id, "cancelled", userId, Option.some(userId))).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: () => decided(sql, id),
            }),
          ),
        ),
      ),
    );

    const cancelErasuresOf = Effect.fn("ConsentRequests.cancelErasuresOf")((userId: string) =>
      connected((sql) =>
        onceReady(
          sql`
            UPDATE office.consent_requests
            SET decision = 'cancelled', decided_by = ${userId}, decided_at = now()
            WHERE user_id = ${userId} AND kind = 'erase' AND handled_at IS NULL AND decision IS NULL
          `,
        ).pipe(Effect.asVoid),
      ),
    );

    const expedite = Effect.fn("ConsentRequests.expedite")((id: number, adminId: string) =>
      connected((sql) =>
        onceReady(decideWhere(sql, id, "now", adminId, Option.none())).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: () => decided(sql, id),
            }),
          ),
        ),
      ),
    );

    const refuse = Effect.fn("ConsentRequests.refuse")(
      (id: number, adminId: string, refusal: ErasureRefusal) =>
        connected((sql) =>
          onceReady(
            SqlSchema.findOneOption({
              Request: Schema.Void,
              Result: Changed,
              execute: () => sql`
                UPDATE office.consent_requests
                SET decision = 'refused', decided_by = ${adminId}, decided_at = now(),
                    refusal_ground = ${refusal.ground}, refusal_reason = ${refusal.reason}
                WHERE id = ${id} AND kind = 'erase' AND handled_at IS NULL AND decision IS NULL
                RETURNING id
              `,
            })(),
          ).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: () => decided(sql, id),
              }),
            ),
          ),
        ),
    );

    const seen = Effect.fn("ConsentRequests.seen")((id: number, adminId: string) =>
      connected((sql) =>
        onceReady(
          SqlSchema.findOneOption({
            Request: Schema.Void,
            Result: Changed,
            execute: () => sql`
              UPDATE office.consent_requests
              SET seen_by = CASE WHEN seen_by ? ${adminId} THEN seen_by ELSE seen_by || to_jsonb(${adminId}::text) END
              WHERE id = ${id} AND kind = 'erase' AND handled_at IS NULL
              RETURNING id
            `,
          })(),
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: () => decided(sql, id),
            }),
          ),
        ),
      ),
    );

    const reviewedCases = (sql: SqlClient.SqlClient) =>
      onceReady(
        findCases(sql)().pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              inventoryOf(sql)(row.userId).pipe(
                Effect.map((inventory): ReviewedCase => ({
                  id: row.id,
                  userId: row.userId,
                  displayName: row.displayName,
                  requestedAt: row.requestedAt,
                  dueAt: row.dueAt,
                  decision: row.decision,
                  decidedBy: row.decidedBy,
                  decidedByName: row.decidedByName,
                  refusal:
                    row.refusalGround === null || row.refusalReason === null
                      ? null
                      : { ground: row.refusalGround, reason: row.refusalReason },
                  seenBy: row.seenBy,
                  seenByNames: row.seenByNames,
                  inventory,
                  announced: row.announced,
                  due: row.due,
                })),
              ),
            ),
          ),
        ),
      );

    const publicCase = (erasure: ReviewedCase): ErasureCase => ({
      id: erasure.id,
      userId: erasure.userId,
      displayName: erasure.displayName,
      requestedAt: erasure.requestedAt,
      dueAt: erasure.dueAt,
      decision: erasure.decision,
      decidedBy: erasure.decidedBy,
      decidedByName: erasure.decidedByName,
      refusal: erasure.refusal,
      seenBy: erasure.seenBy,
      seenByNames: erasure.seenByNames,
      inventory: erasure.inventory,
    });

    const cases = connected((sql) =>
      reviewedCases(sql).pipe(Effect.map(Array.map(publicCase))),
    ).pipe(Effect.withSpan("ConsentRequests.cases"));

    const admins = connected((sql) => onceReady(findAdmins(sql)())).pipe(
      Effect.withSpan("ConsentRequests.admins"),
    );

    const adminOf = Effect.fn("ConsentRequests.adminOf")((medium: NoticeMedium, userId: string) =>
      connected((sql) => onceReady(findAdmin(sql)({ medium, userId }))),
    );

    const recordNotice = Effect.fn("ConsentRequests.recordNotice")((notice: ErasureNotice) =>
      connected((sql) =>
        onceReady(
          sql`
            INSERT INTO office.erasure_notices ${sql.insert({
              requestId: notice.requestId,
              medium: notice.medium,
              recipient: notice.recipient,
              channel: notice.channel,
              messageId: notice.messageId,
            })}
            ON CONFLICT (request_id, medium, recipient)
            DO UPDATE SET channel = EXCLUDED.channel, message_id = EXCLUDED.message_id
          `,
        ).pipe(Effect.asVoid),
      ),
    );

    const noticesOf = Effect.fn("ConsentRequests.noticesOf")((requestId: number) =>
      connected((sql) =>
        onceReady(
          findNotices(sql)(requestId).pipe(
            Effect.map(
              Array.map((row): ErasureNotice => ({
                requestId: row.requestId,
                medium: row.medium,
                recipient: row.recipient,
                channel: row.channel,
                messageId: row.messageId,
              })),
            ),
          ),
        ),
      ),
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

    const handleOneWithdrawal = <E, R>(
      sql: SqlClient.SqlClient,
      withdrawal: Withdrawal,
      handler: WithdrawalHandler<E, R>,
    ) =>
      Effect.gen(function* () {
        const latest = yield* onceReady(latestDecisive(sql)({ userId: withdrawal.userId }));
        const made = yield* handler.withdraw(withdrawal, standingOf(latest).standing);

        if (Option.isNone(made))
          return yield* onceReady(resolve(sql, withdrawal.id, "ignored")).pipe(
            Effect.andThen(Effect.logInfo("Ignored a consent withdrawal with nothing to withdraw")),
          );

        yield* committing<Committable<E, R>, E, R>(
          sql,
          Effect.succeed(made.value),
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

    const recordSettled = (sql: SqlClient.SqlClient, id: number, outcome: Settled) =>
      sql`
        UPDATE office.consent_requests
        SET handled_at = now(), outcome = ${outcome}
        WHERE id = ${id} AND handled_at IS NULL
      `;

    const markAnnounced = (sql: SqlClient.SqlClient, id: number) =>
      onceReady(sql`UPDATE office.consent_requests SET announced_at = now() WHERE id = ${id}`).pipe(
        Effect.asVoid,
      );

    const markCancelledByConsent = (sql: SqlClient.SqlClient, erasure: ErasureCase) =>
      onceReady(
        sql`
          UPDATE office.consent_requests
          SET decision = 'cancelled', decided_by = ${erasure.userId}, decided_at = now()
          WHERE id = ${erasure.id} AND handled_at IS NULL
        `,
      ).pipe(Effect.asVoid);

    const settleOne = <E, R>(
      sql: SqlClient.SqlClient,
      erasure: ErasureCase,
      outcome: Settled,
      handler: ErasureHandler<E, R>,
    ) =>
      committing(
        sql,
        handler.settle(erasure, outcome),
        () => recordSettled(sql, erasure.id, outcome),
        Effect.logInfo(`An erasure request was ${outcome}`),
      );

    const eraseOne = <E, R>(
      sql: SqlClient.SqlClient,
      erasure: ReviewedCase,
      handler: ErasureHandler<E, R>,
    ) =>
      Effect.gen(function* () {
        const agreedAgain = yield* onceReady(
          agreedSince(sql)({ userId: erasure.userId, id: erasure.id }),
        );

        if (Option.isSome(agreedAgain)) {
          yield* markCancelledByConsent(sql, erasure);

          return yield* settleOne(sql, erasure, "cancelled", handler);
        }

        yield* handler.prepare(erasure);

        const made = yield* handler.erase(erasure);

        if (Option.isNone(made)) {
          yield* markCancelledByConsent(sql, erasure);

          return yield* settleOne(sql, erasure, "cancelled", handler);
        }

        yield* committingSlowly<Committable<E, R>, E, R>(
          sql,
          Effect.succeed(made.value),
          () => recordErasure(sql, erasure),
          Effect.logInfo("Erased everything held about someone"),
        );
      });

    const handleOneErasure = <E, R>(
      sql: SqlClient.SqlClient,
      erasure: ReviewedCase,
      handler: ErasureHandler<E, R>,
    ) =>
      Effect.gen(function* () {
        if (!erasure.announced) {
          yield* handler.announce(erasure);
          yield* markAnnounced(sql, erasure.id);
        }

        if (erasure.decision === "refused")
          return yield* settleOne(sql, erasure, "refused", handler);

        if (erasure.decision === "cancelled")
          return yield* settleOne(sql, erasure, "cancelled", handler);

        if (erasure.due || erasure.decision === "now")
          return yield* eraseOne(sql, erasure, handler);
      }).pipe(Effect.annotateLogs({ erasure: erasure.id }));

    const handleWithdrawals = <E, R>(handler: WithdrawalHandler<E, R>) =>
      connected(
        Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
          const pending = yield* onceReady(findPendingWithdrawals(sql)()).pipe(
            Effect.withTracerEnabled(false),
          );

          if (pending.length === 0) return;

          yield* Effect.forEach(
            pending,
            (withdrawal) => handleOneWithdrawal(sql, withdrawal, handler),
            { discard: true },
          ).pipe(Effect.withSpan("ConsentRequests.handle.withdraw"));
        }),
      );

    const handleErasures = <E, R>(handler: ErasureHandler<E, R>) =>
      connected(
        Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
          const pending = yield* onceReady(findCases(sql)()).pipe(Effect.withTracerEnabled(false));

          const actionable = Array.filter(
            pending,
            (row) => !row.announced || row.decision !== null || row.due,
          );

          if (actionable.length === 0) return;

          const reviewed = yield* reviewedCases(sql);

          yield* Effect.forEach(
            Array.filter(reviewed, (erasure) =>
              Array.some(actionable, (row) => row.id === erasure.id),
            ),
            (erasure) => handleOneErasure(sql, erasure, handler),
            { discard: true },
          ).pipe(Effect.withSpan("ConsentRequests.handle.erase"));
        }),
      );

    return ConsentRequests.of({
      status,
      withdraw,
      find,
      erase,
      findErasure: findErasureOf,
      cancelErasure,
      cancelErasuresOf,
      pendingErasureOf: pendingErasure,
      cases,
      admins,
      adminOf,
      expedite,
      refuse,
      seen,
      recordNotice,
      noticesOf,
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
      cancelErasure: () => unavailable("Nothing is recorded"),
      cancelErasuresOf: () => Effect.void,
      pendingErasureOf: () => Effect.succeedNone,
      cases: unavailable("Nothing is recorded"),
      admins: Effect.succeed([]),
      adminOf: () => Effect.succeedNone,
      expedite: () => unavailable("Nothing is recorded"),
      refuse: () => unavailable("Nothing is recorded"),
      seen: () => unavailable("Nothing is recorded"),
      recordNotice: () => Effect.void,
      noticesOf: () => Effect.succeed([]),
      handleWithdrawals: () => Effect.void,
      handleErasures: () => Effect.void,
    }),
  );
}
