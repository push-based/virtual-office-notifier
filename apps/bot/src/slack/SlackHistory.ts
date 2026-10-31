import { Array, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { guardQuery } from "recording-requests/Query";
import { RowId } from "recording-requests/RecordingRequest";

import type { ClefRequest } from "../answering/index.ts";

import { Database, describeError } from "../Database.ts";
import { HistoryUnavailable } from "../OfficeHistory.ts";

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

const MessageRow = Schema.Struct({
  channel: Schema.String,
  ts: Schema.String,
  threadTs: Schema.String,
  userId: Schema.String,
  displayName: Schema.String,
  memberUserId: Schema.NullOr(Schema.String),
  text: Schema.String,
  isMention: Schema.Boolean,
  receivedAt: Schema.DateTimeUtcFromDate,
});

const JsonColumn = Schema.fromJsonString(Schema.Unknown);

const DecisionRow = Schema.Struct({
  messageId: Schema.Finite,
  decidedAt: Schema.DateTimeUtcFromDate,
  clef: Schema.OptionFromNullOr(
    Schema.Struct({
      model: Schema.String,
      request: JsonColumn,
      action: Schema.String,
      actionProbabilities: JsonColumn,
      actionConfidence: Schema.Finite,
      reaction: Schema.String,
      reactionProbabilities: JsonColumn,
      reactionConfidence: Schema.Finite,
      latencyMs: Schema.Finite,
    }),
  ),
  minConfidence: Schema.Finite,
  maxRepliesPerDay: Schema.Finite,
  maxReactionsPerDay: Schema.Finite,
  maxRepliesPerThread: Schema.Finite,
  outcome: Schema.String,
  reason: Schema.String,
});

const Since = Schema.Struct({ from: Schema.DateTimeUtcFromDate });

const Total = Schema.Struct({ total: Schema.Int });

const notRecording = () => Effect.fail(HistoryUnavailable.make({ reason: "Nothing is recorded" }));

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
>()("bot/slack/SlackHistory") {
  static readonly layer = Layer.effect(
    SlackHistory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;

      const onceReady = guardQuery({
        ready: database.ready,
        unavailable: (reason) => HistoryUnavailable.make({ reason }),
        describe: describeError,
      });

      const readSettings = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: SettingsRow,
        execute: () => sql`SELECT * FROM office.responder_settings`,
      });

      const insertMessage = SqlSchema.findOne({
        Request: MessageRow,
        Result: Schema.Struct({ id: RowId }),
        execute: ({ channel, ...message }) => sql`
          INSERT INTO office.slack_messages ${sql.insert({ channelId: channel, ...message })}
          RETURNING id
        `,
      });

      const insertDecision = SqlSchema.void({
        Request: DecisionRow,
        execute: ({ clef, ...decision }) => sql`
          INSERT INTO office.slack_decisions (
            message_id, decided_at, clef_model, clef_request, action, action_probabilities, action_confidence,
            reaction, reaction_probabilities, reaction_confidence, latency_ms, min_confidence,
            max_replies_per_day, max_reactions_per_day, max_replies_per_thread, outcome, reason
          ) VALUES (
            ${decision.messageId},
            ${decision.decidedAt},
            ${clef?.model ?? null},
            ${clef?.request ?? null}::jsonb,
            ${clef?.action ?? null},
            ${clef?.actionProbabilities ?? null}::jsonb,
            ${clef?.actionConfidence ?? null},
            ${clef?.reaction ?? null},
            ${clef?.reactionProbabilities ?? null}::jsonb,
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
      });

      const countRepliesSince = SqlSchema.findOneOption({
        Request: Since,
        Result: Total,
        execute: ({ from }) => sql`
          SELECT count(*)::int AS total FROM office.slack_posts
          WHERE kind = 'Reply' AND posted_at >= ${from}
        `,
      });

      const countReactionsSince = SqlSchema.findOneOption({
        Request: Since,
        Result: Total,
        execute: ({ from }) => sql`
          SELECT count(*)::int AS total FROM office.slack_decisions
          WHERE outcome = 'reacted' AND decided_at >= ${from}
        `,
      });

      const countRepliesInThread = SqlSchema.findOneOption({
        Request: Schema.Struct({ channel: Schema.String, threadTs: Schema.String }),
        Result: Total,
        execute: ({ channel, threadTs }) => sql`
          SELECT count(*)::int AS total FROM office.slack_posts
          WHERE kind = 'Reply' AND channel_id = ${channel} AND thread_ts = ${threadTs}
        `,
      });

      const findMember = SqlSchema.findOneOption({
        Request: Schema.Struct({ slackUserId: Schema.String, realName: Schema.String }),
        Result: Schema.Struct({ memberUserId: Schema.String, name: Schema.String }),
        execute: ({ slackUserId, realName }) => sql`
          SELECT user_id AS member_user_id, coalesce(real_name, display_name) AS name
          FROM office.members
          WHERE slack_user_id = ${slackUserId}
            OR (${realName} <> '' AND lower(real_name) = lower(${realName}))
          ORDER BY slack_user_id = ${slackUserId} DESC NULLS LAST, user_id
          LIMIT 1
        `,
      });

      const count = <E extends Error>(query: Effect.Effect<Option.Option<typeof Total.Type>, E>) =>
        onceReady(query).pipe(
          Effect.map(Option.match({ onNone: () => 0, onSome: ({ total }) => total })),
        );

      const settings = onceReady(readSettings()).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                HistoryUnavailable.make({ reason: "The responder settings are missing" }),
              ),
            onSome: ({ staleAfterSeconds, ...row }) =>
              Effect.succeed<ResponderSettings>({
                ...row,
                staleAfter: Duration.seconds(staleAfterSeconds),
              }),
          }),
        ),
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

      const recordMessage = Effect.fn("SlackHistory.recordMessage")(
        (message: ConsideredMessage) => onceReady(insertMessage(message)),
        Effect.map(({ id }) => id),
      );

      const recordDecision = Effect.fn("SlackHistory.recordDecision")((decision: DecisionRecord) =>
        onceReady(insertDecision(decision)),
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
        count(countRepliesSince({ from })),
      );

      const reactionsSince = Effect.fn("SlackHistory.reactionsSince")((from: DateTime.Utc) =>
        count(countReactionsSince({ from })),
      );

      const repliesInThread = Effect.fn("SlackHistory.repliesInThread")(
        (channel: string, threadTs: string) => count(countRepliesInThread({ channel, threadTs })),
      );

      const linkMember = Effect.fn("SlackHistory.linkMember")(
        (slackUserId: string, realName: string) => onceReady(findMember({ slackUserId, realName })),
        Effect.map(Option.map(({ memberUserId, name }): LinkedMember => ({ memberUserId, name }))),
      );

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
