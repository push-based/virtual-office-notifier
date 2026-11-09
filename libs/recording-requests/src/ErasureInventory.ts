import { Array, Effect, pipe, Schema, String } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import type { ErasureInventory } from "./Consent.ts";
import { FORMER_MEMBER } from "./Wire.ts";

export const MIN_NAME_LENGTH = 3;

const NameRow = Schema.Struct({ name: Schema.String });

const SlackIdRow = Schema.Struct({ slackUserId: Schema.String });

const CountRow = Schema.Struct({ total: Schema.Int });

const CountsRow = Schema.Struct({
  voiceActivity: Schema.Int,
  soundsAndEmoji: Schema.Int,
  slackMessages: Schema.Int,
  slackReactions: Schema.Int,
  clips: Schema.Int,
  audioFiles: Schema.Int,
  recordingsSpokenIn: Schema.Int,
  recordingsStartedStoppedOrPaused: Schema.Int,
  recordingRequests: Schema.Int,
  recordingEdits: Schema.Int,
  actionItemsOwned: Schema.Int,
});

export const namesOf = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.String,
    Result: NameRow,
    execute: (userId) => sql`
      WITH m AS (SELECT * FROM office.members WHERE user_id = ${userId})
      SELECT DISTINCT name FROM (
        SELECT display_name AS name FROM m
        UNION ALL SELECT real_name FROM m
        UNION ALL
        SELECT display_name FROM office.slack_messages
        WHERE member_user_id = ${userId} OR user_id IN (SELECT slack_user_id FROM m)
        UNION ALL
        SELECT requested_by_name FROM office.recording_requests WHERE requested_by = ${userId}
        UNION ALL
        SELECT edited_by_name FROM office.recording_edits WHERE edited_by = ${userId}
      ) names
      WHERE name IS NOT NULL
      ORDER BY name
    `,
  });

export const slackIdsOf = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.String,
    Result: SlackIdRow,
    execute: (userId) => sql`
      SELECT DISTINCT slack_user_id FROM (
        SELECT slack_user_id FROM office.members WHERE user_id = ${userId}
        UNION ALL
        SELECT user_id FROM office.slack_messages WHERE member_user_id = ${userId}
      ) ids
      WHERE slack_user_id IS NOT NULL
      ORDER BY slack_user_id
    `,
  });

const firstWordOf = (name: string): ReadonlyArray<string> =>
  Array.take(pipe(name, String.split(/\s+/)), 1);

export const needlesOf = (
  names: ReadonlyArray<string>,
  slackUserIds: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  pipe(
    names,
    Array.map(String.trim),
    Array.flatMap((name) => [name, ...firstWordOf(name)]),
    Array.filter((name) => name.length >= MIN_NAME_LENGTH && name !== FORMER_MEMBER),
    Array.appendAll(Array.map(slackUserIds, (id) => `<@${id}`)),
    Array.map(String.toLowerCase),
    Array.dedupe,
  );

export const inventoryOf = (sql: SqlClient.SqlClient) => {
  const counts = SqlSchema.findOne({
    Request: Schema.String,
    Result: CountsRow,
    execute: (userId) => sql`
      WITH m AS (SELECT slack_user_id FROM office.members WHERE user_id = ${userId})
      SELECT
        (SELECT count(*) FROM office.voice_snapshots WHERE user_id = ${userId})::int AS voice_activity,
        (SELECT count(*) FROM office.voice_effects WHERE user_id = ${userId})::int AS sounds_and_emoji,
        (SELECT count(*) FROM office.slack_messages
          WHERE member_user_id = ${userId} OR user_id IN (SELECT slack_user_id FROM m WHERE slack_user_id IS NOT NULL))::int AS slack_messages,
        (SELECT count(*) FROM office.slack_reactions
          WHERE user_id IN (SELECT slack_user_id FROM m WHERE slack_user_id IS NOT NULL))::int AS slack_reactions,
        (SELECT count(*) FROM office.recording_clips WHERE user_id = ${userId})::int AS clips,
        (SELECT count(*) FROM office.recording_clips WHERE user_id = ${userId} AND object_path IS NOT NULL)::int AS audio_files,
        (SELECT count(DISTINCT recording_id) FROM office.recording_clips WHERE user_id = ${userId})::int AS recordings_spoken_in,
        (SELECT count(*) FROM office.recordings WHERE ${userId} IN (started_by, stopped_by, paused_by))::int AS recordings_started_stopped_or_paused,
        (SELECT count(*) FROM office.recording_requests WHERE requested_by = ${userId})::int AS recording_requests,
        (SELECT count(*) FROM office.recording_edits WHERE edited_by = ${userId})::int AS recording_edits,
        (SELECT count(*) FROM office.recording_action_items WHERE owner = ${userId})::int AS action_items_owned
    `,
  });

  const mentioning = (needles: Array.NonEmptyReadonlyArray<string>, column: string) =>
    sql.or(Array.map(needles, (needle) => sql`strpos(lower(${sql(column)}), ${needle}) > 0`));

  const countMentions = (
    needles: Array.NonEmptyReadonlyArray<string>,
    table: string,
    column: string,
    userId: string,
    ownColumn: string | null,
  ) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: CountRow,
      execute: () => sql`
        SELECT count(*)::int AS total FROM ${sql(table)}
        WHERE ${sql(column)} IS NOT NULL AND ${mentioning(needles, column)}
          ${ownColumn === null ? sql.literal("") : sql`AND ${sql(ownColumn)} IS DISTINCT FROM ${userId}`}
      `,
    })().pipe(Effect.map(({ total }) => total));

  const sum = (totals: ReadonlyArray<number>) => Array.reduce(totals, 0, (a, b) => a + b);

  return Effect.fnUntraced(function* (userId: string) {
    const own = yield* counts(userId);
    const names = Array.map(yield* namesOf(sql)(userId), ({ name }) => name);
    const slackIds = Array.map(yield* slackIdsOf(sql)(userId), ({ slackUserId }) => slackUserId);
    const needles = needlesOf(names, slackIds);

    const mentions = Array.isReadonlyArrayNonEmpty(needles)
      ? {
          linesMentioningThem: yield* countMentions(
            needles,
            "office.recording_clips",
            "transcript",
            userId,
            "user_id",
          ),
          recordingTextsMentioningThem: sum([
            yield* countMentions(needles, "office.recordings", "title", userId, null),
            yield* countMentions(needles, "office.recordings", "agenda", userId, null),
            yield* countMentions(needles, "office.recordings", "summary", userId, null),
            yield* countMentions(needles, "office.recording_summaries", "summary", userId, null),
            yield* countMentions(needles, "office.recording_action_items", "text", userId, null),
          ]),
          slackPostsMentioningThem: yield* countMentions(
            needles,
            "office.slack_posts",
            "text",
            userId,
            null,
          ),
          slackMessagesMentioningThem: yield* countMentions(
            needles,
            "office.slack_messages",
            "text",
            userId,
            "member_user_id",
          ),
        }
      : {
          linesMentioningThem: 0,
          recordingTextsMentioningThem: 0,
          slackPostsMentioningThem: 0,
          slackMessagesMentioningThem: 0,
        };

    const inventory: ErasureInventory = { ...own, names, ...mentions };

    return inventory;
  });
};
