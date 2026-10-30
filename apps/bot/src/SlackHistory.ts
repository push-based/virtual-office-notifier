import { Array, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type { ClefRequest } from "./CloudflareDecisionModel.ts";
import { Database, describeError } from "./Database.ts";
import { HistoryUnavailable } from "./OfficeHistory.ts";

const READ_TIMEOUT = Duration.seconds(10);

export interface ResponderSettings {
  readonly enabled: boolean;
  readonly clefModel: string;
  readonly minConfidence: number;
  readonly maxRepliesPerDay: number;
  readonly maxReactionsPerDay: number;
  readonly maxRepliesPerThread: number;
  readonly staleAfter: Duration.Duration;
  readonly clefThreadMessages: number;
  readonly writerThreadMessages: number;
  readonly reactionEmoji: Array.NonEmptyReadonlyArray<string>;
}

const SettingsRow = Schema.Struct({
  enabled: Schema.Boolean,
  clefModel: Schema.NonEmptyString,
  minConfidence: Schema.Finite,
  maxRepliesPerDay: Schema.Int,
  maxReactionsPerDay: Schema.Int,
  maxRepliesPerThread: Schema.Int,
  staleAfterSeconds: Schema.Int,
  clefThreadMessages: Schema.Int,
  writerThreadMessages: Schema.Int,
  reactionEmoji: Schema.NonEmptyArray(Schema.NonEmptyString),
});

const decodeSettings = Schema.decodeUnknownEffect(SettingsRow);

export type PostKind = "Opened" | "Emptied" | "Reminder" | "Banter" | "Reply" | "Recording";

export interface SlackPost {
  readonly channel: string;
  readonly ts: string;
  readonly threadTs: string | null;
  readonly kind: PostKind;
  readonly model: string | null;
  readonly postedAt: DateTime.Utc;
}

export interface ConsideredMessage {
  readonly channel: string;
  readonly ts: string;
  readonly threadTs: string;
  readonly userId: string;
  readonly displayName: string;
  readonly memberUserId: string | null;
  readonly text: string;
  readonly isMention: boolean;
  readonly receivedAt: DateTime.Utc;
}

export type Action = "reply" | "react" | "ignore";

export type Outcome = "replied" | "reacted" | "ignored";

export type DecisionReason =
  | "clef"
  | "mention"
  | "low_confidence"
  | "daily_cap"
  | "thread_cap"
  | "outside_hours"
  | "stale"
  | "superseded"
  | "clef_failed"
  | "no_model";

export interface ClefVerdict {
  readonly model: string;
  readonly request: ClefRequest;
  readonly action: Action;
  readonly actionProbabilities: Readonly<Record<string, number>>;
  readonly actionConfidence: number;
  readonly reaction: string;
  readonly reactionProbabilities: Readonly<Record<string, number>>;
  readonly reactionConfidence: number;
  readonly latencyMs: number;
}

export interface DecisionRecord {
  readonly messageId: number;
  readonly decidedAt: DateTime.Utc;
  readonly clef: Option.Option<ClefVerdict>;
  readonly minConfidence: number;
  readonly maxRepliesPerDay: number;
  readonly maxReactionsPerDay: number;
  readonly maxRepliesPerThread: number;
  readonly outcome: Outcome;
  readonly reason: DecisionReason;
}

export interface ReactionRecord {
  readonly channel: string;
  readonly itemTs: string;
  readonly userId: string;
  readonly emoji: string;
  readonly added: boolean;
  readonly eventTs: string;
  readonly receivedAt: DateTime.Utc;
}

export interface LinkedMember {
  readonly memberUserId: string;
  readonly name: string;
}

const jsonb = (value: ClefRequest | Readonly<Record<string, number>>): string =>
  JSON.stringify(value);

const notRecording = () => Effect.fail(new HistoryUnavailable({ reason: "Nothing is recorded" }));

export class SlackHistory extends Context.Service<
  SlackHistory,
  {
    readonly settings: Effect.Effect<ResponderSettings, HistoryUnavailable>;
    recordPost(post: SlackPost): Effect.Effect<void, HistoryUnavailable>;
    recordMessage(message: ConsideredMessage): Effect.Effect<number, HistoryUnavailable>;
    recordDecision(decision: DecisionRecord): Effect.Effect<void, HistoryUnavailable>;
    recordReaction(reaction: ReactionRecord): Effect.Effect<void, HistoryUnavailable>;
    repliesSince(from: DateTime.Utc): Effect.Effect<number, HistoryUnavailable>;
    reactionsSince(from: DateTime.Utc): Effect.Effect<number, HistoryUnavailable>;
    repliesInThread(channel: string, threadTs: string): Effect.Effect<number, HistoryUnavailable>;
    linkMember(
      slackUserId: string,
      realName: string,
    ): Effect.Effect<Option.Option<LinkedMember>, HistoryUnavailable>;
  }
>()("virtual-office-notifier/SlackHistory") {
  static readonly layer = Layer.effect(
    SlackHistory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;

      const onceReady = <A, E extends Error>(query: Effect.Effect<A, E>) =>
        database.ready.pipe(
          Effect.andThen(query),
          Effect.mapError((error) => new HistoryUnavailable({ reason: describeError(error) })),
          Effect.timeoutOrElse({
            duration: READ_TIMEOUT,
            orElse: () =>
              Effect.fail(new HistoryUnavailable({ reason: "Timed out after 10 seconds" })),
          }),
        );

      const count = (query: Effect.Effect<ReadonlyArray<{ readonly total: number }>, Error>) =>
        onceReady(query).pipe(Effect.map(([row]) => row?.total ?? 0));

      const settings = onceReady(
        sql`SELECT * FROM office.responder_settings`.pipe(
          Effect.flatMap(([row]) => decodeSettings(row)),
        ),
      ).pipe(
        Effect.map(({ staleAfterSeconds, ...row }): ResponderSettings => ({
          ...row,
          staleAfter: Duration.seconds(staleAfterSeconds),
        })),
        Effect.withSpan("SlackHistory.settings"),
      );

      const recordPost = Effect.fn("SlackHistory.recordPost")(
        (post: SlackPost) =>
          onceReady(
            sql`
              INSERT INTO office.slack_posts ${sql.insert({
                channelId: post.channel,
                ts: post.ts,
                threadTs: post.threadTs,
                kind: post.kind,
                model: post.model,
                postedAt: DateTime.toDate(post.postedAt),
              })}
              ON CONFLICT (channel_id, ts) DO NOTHING
            `,
          ),
        Effect.asVoid,
      );

      const recordMessage = Effect.fn("SlackHistory.recordMessage")(function* (
        message: ConsideredMessage,
      ) {
        const [row] = yield* onceReady(
          sql<{ readonly id: string }>`
            INSERT INTO office.slack_messages ${sql.insert({
              channelId: message.channel,
              ts: message.ts,
              threadTs: message.threadTs,
              userId: message.userId,
              displayName: message.displayName,
              memberUserId: message.memberUserId,
              text: message.text,
              isMention: message.isMention,
              receivedAt: DateTime.toDate(message.receivedAt),
            })}
            RETURNING id
          `,
        );

        return Number(row?.id);
      });

      const recordDecision = Effect.fn("SlackHistory.recordDecision")(
        (decision: DecisionRecord) => {
          const clef = Option.getOrNull(decision.clef);

          return onceReady(
            sql`
            INSERT INTO office.slack_decisions (
              message_id, decided_at, clef_model, clef_request, action, action_probabilities, action_confidence,
              reaction, reaction_probabilities, reaction_confidence, latency_ms, min_confidence,
              max_replies_per_day, max_reactions_per_day, max_replies_per_thread, outcome, reason
            ) VALUES (
              ${decision.messageId},
              ${DateTime.toDate(decision.decidedAt)},
              ${clef?.model ?? null},
              ${clef === null ? null : jsonb(clef.request)}::jsonb,
              ${clef?.action ?? null},
              ${clef === null ? null : jsonb(clef.actionProbabilities)}::jsonb,
              ${clef?.actionConfidence ?? null},
              ${clef?.reaction ?? null},
              ${clef === null ? null : jsonb(clef.reactionProbabilities)}::jsonb,
              ${clef?.reactionConfidence ?? null},
              ${clef?.latencyMs ?? null},
              ${decision.minConfidence},
              ${decision.maxRepliesPerDay},
              ${decision.maxReactionsPerDay},
              ${decision.maxRepliesPerThread},
              ${decision.outcome},
              ${decision.reason}
            )
          `,
          );
        },
        Effect.asVoid,
      );

      const recordReaction = Effect.fn("SlackHistory.recordReaction")(
        (reaction: ReactionRecord) =>
          onceReady(
            sql`
              INSERT INTO office.slack_reactions ${sql.insert({
                channelId: reaction.channel,
                itemTs: reaction.itemTs,
                userId: reaction.userId,
                emoji: reaction.emoji,
                added: reaction.added,
                eventTs: reaction.eventTs,
                receivedAt: DateTime.toDate(reaction.receivedAt),
              })}
            `,
          ),
        Effect.asVoid,
      );

      const repliesSince = Effect.fn("SlackHistory.repliesSince")((from: DateTime.Utc) =>
        count(
          sql`
            SELECT count(*)::int AS total FROM office.slack_posts
            WHERE kind = 'Reply' AND posted_at >= ${DateTime.toDate(from)}
          `,
        ),
      );

      const reactionsSince = Effect.fn("SlackHistory.reactionsSince")((from: DateTime.Utc) =>
        count(
          sql`
            SELECT count(*)::int AS total FROM office.slack_decisions
            WHERE outcome = 'reacted' AND decided_at >= ${DateTime.toDate(from)}
          `,
        ),
      );

      const repliesInThread = Effect.fn("SlackHistory.repliesInThread")(
        (channel: string, threadTs: string) =>
          count(
            sql`
            SELECT count(*)::int AS total FROM office.slack_posts
            WHERE kind = 'Reply' AND channel_id = ${channel} AND thread_ts = ${threadTs}
          `,
          ),
      );

      const linkMember = Effect.fn("SlackHistory.linkMember")(function* (
        slackUserId: string,
        realName: string,
      ) {
        const rows = yield* onceReady(
          sql<{ readonly memberUserId: string; readonly name: string }>`
            SELECT user_id AS member_user_id, coalesce(real_name, display_name) AS name
            FROM office.members
            WHERE slack_user_id = ${slackUserId}
              OR (${realName} <> '' AND lower(real_name) = lower(${realName}))
            ORDER BY slack_user_id = ${slackUserId} DESC NULLS LAST, user_id
            LIMIT 1
          `,
        );

        return Option.map(Array.head(rows), ({ memberUserId, name }): LinkedMember => ({
          memberUserId,
          name,
        }));
      });

      return SlackHistory.of({
        settings,
        recordPost,
        recordMessage,
        recordDecision,
        recordReaction,
        repliesSince,
        reactionsSince,
        repliesInThread,
        linkMember,
      });
    }),
  );

  static readonly layerDisabled = Layer.succeed(
    SlackHistory,
    SlackHistory.of({
      settings: notRecording(),
      recordPost: () => Effect.void,
      recordMessage: notRecording,
      recordDecision: notRecording,
      recordReaction: notRecording,
      repliesSince: notRecording,
      reactionsSince: notRecording,
      repliesInThread: notRecording,
      linkMember: notRecording,
    }),
  );
}
