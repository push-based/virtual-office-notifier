import { Array, Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import type { ConsentEventKind, Delivery, Wording } from "recording-requests/Consent";
import { CONSENT_NOTICE_VERSION } from "recording-requests/wire";

import { type ActivityLogError, classify } from "../activity/index.ts";

export interface ConsentEvent {
  readonly userId: string;
  readonly at: DateTime.Utc;
  readonly kind: ConsentEventKind;
  readonly asked?: { readonly wording: Wording; readonly delivery: Delivery };
}

export interface ConsentRecord {
  readonly agreed: boolean;
  readonly asked: number;
}

export const NEVER_ASKED: ConsentRecord = { agreed: false, asked: 0 };

const HistoryRow = Schema.Struct({
  userId: Schema.String,
  asked: Schema.Finite,
  decisiveKind: Schema.NullOr(Schema.Literals(["agreed", "withdrawn"])),
  decisiveVersion: Schema.NullOr(Schema.Union([Schema.Finite, Schema.FiniteFromString])),
});

const recordOf = (row: typeof HistoryRow.Type): ConsentRecord => ({
  asked: row.asked,
  agreed: row.decisiveKind === "agreed" && row.decisiveVersion === CONSENT_NOTICE_VERSION,
});

export class ConsentLog extends Context.Service<
  ConsentLog,
  {
    readonly history: Effect.Effect<ReadonlyMap<string, ConsentRecord>, ActivityLogError>;
    append(event: ConsentEvent): Effect.Effect<void, ActivityLogError>;
  }
>()("bot/consent/ConsentLog") {
  static readonly layer = Layer.effect(
    ConsentLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const readHistory = SqlSchema.findAll({
        Request: Schema.Void,
        Result: HistoryRow,
        execute: () => sql`
          SELECT
            user_id,
            count(*) FILTER (WHERE kind = 'asked')::int AS asked,
            (array_agg(kind ORDER BY happened_at DESC, id DESC) FILTER (WHERE kind IN ('agreed', 'withdrawn')))[1] AS decisive_kind,
            (array_agg(notice_version ORDER BY happened_at DESC, id DESC) FILTER (WHERE kind IN ('agreed', 'withdrawn')))[1] AS decisive_version
          FROM office.consent_events
          GROUP BY user_id
        `,
      });

      const history = readHistory().pipe(
        Effect.map(
          (rows): ReadonlyMap<string, ConsentRecord> =>
            new Map(Array.map(rows, (row) => [row.userId, recordOf(row)])),
        ),
        Effect.catchTag("SchemaError", (error) => Effect.die(error)),
        Effect.mapError(classify),
      );

      const append = (event: ConsentEvent) =>
        sql`
          INSERT INTO office.consent_events ${sql.insert({
            userId: event.userId,
            happenedAt: DateTime.toDate(event.at),
            kind: event.kind,
            noticeVersion: CONSENT_NOTICE_VERSION,
            wording: event.asked?.wording ?? null,
            delivery: event.asked?.delivery ?? null,
          })}
        `.pipe(Effect.asVoid, Effect.mapError(classify));

      return ConsentLog.of({ history, append });
    }),
  );
}
