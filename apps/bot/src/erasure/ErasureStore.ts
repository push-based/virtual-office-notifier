import { Array, Context, Effect, Layer, pipe, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { guardChange, guardQuery, type QueryGuard } from "recording-requests/Query";
import { FORMER_MEMBER, FORMER_MEMBER_ID } from "recording-requests/wire";

import { Database, describeError } from "../database/index.ts";
import { StoreUnavailable } from "../recording/index.ts";
import { type Scrubber, scrubberFor } from "./Scrub.ts";

export interface Subject {
  readonly userId: string;
  readonly slackUserIds: ReadonlyArray<string>;
  readonly scrubber: Scrubber;
  readonly objectPaths: ReadonlyArray<string>;
}

export interface PostedThread {
  readonly channel: string;
  readonly ts: string;
}

export interface BotPostings {
  readonly channels: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<PostedThread>;
}

export interface Erased {
  readonly objectPaths: ReadonlyArray<string>;
  readonly republishing: number;
}

const NameRow = Schema.Struct({ name: Schema.String });

const SlackIdRow = Schema.Struct({ slackUserId: Schema.String });

const PathRow = Schema.Struct({ objectPath: Schema.String });

const RecordingRow = Schema.Struct({ recordingId: Schema.String });

const ScrubbedRow = Schema.Struct({ recordingId: Schema.NullOr(Schema.String) });

const ScrubRow = Schema.Struct({ id: Schema.String, value: Schema.String });

const ChannelRow = Schema.Struct({ channel: Schema.String });

const ThreadRow = Schema.Struct({ channel: Schema.String, ts: Schema.String });

const JsonText = Schema.fromJsonString(Schema.Json);

const decodeJsonText = Schema.decodeUnknownEffect(JsonText);

const encodeJsonText = Schema.encodeEffect(JsonText);

const notRecording = () => Effect.fail(StoreUnavailable.make({ reason: "Nothing is recorded" }));

interface Column {
  readonly table: string;
  readonly column: string;
  readonly recording: string | null;
  readonly json: boolean;
}

const text = (table: string, column: string, recording: string | null = null): Column => ({
  table,
  column,
  recording,
  json: false,
});

const json = (table: string, column: string, recording: string | null = null): Column => ({
  table,
  column,
  recording,
  json: true,
});

const SCRUBBED: ReadonlyArray<Column> = [
  text("office.recordings", "title", "id"),
  text("office.recordings", "agenda", "id"),
  text("office.recordings", "summary", "id"),
  text("office.recording_summaries", "summary", "recording_id"),
  text("office.recording_clips", "transcript", "recording_id"),
  text("office.recording_action_items", "text", "recording_id"),
  text("office.recording_requests", "title"),
  text("office.recording_requests", "agenda"),
  json("office.recording_edits", "change", "recording_id"),
  text("office.slack_posts", "text"),
  text("office.slack_messages", "text"),
];

export class ErasureStore extends Context.Service<
  ErasureStore,
  {
    subject(userId: string): Effect.Effect<Subject, StoreUnavailable>;
    readonly botPostings: Effect.Effect<BotPostings, StoreUnavailable>;
    erase(subject: Subject): Effect.Effect<Erased, StoreUnavailable>;
    sweep(userId: string): Effect.Effect<void, StoreUnavailable>;
  }
>()("bot/erasure/ErasureStore") {
  static readonly layer = Layer.effect(
    ErasureStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;

      const guard: QueryGuard<StoreUnavailable> = {
        ready: database.ready,
        unavailable: (reason) => StoreUnavailable.make({ reason }),
        unreadable: (reason) => StoreUnavailable.make({ reason, unreadable: true }),
        describe: describeError,
      };

      const onceReady = guardQuery(guard);

      const atomically = guardChange(guard, sql);

      const findNames = SqlSchema.findAll({
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

      const findSlackIds = SqlSchema.findAll({
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

      const findPaths = SqlSchema.findAll({
        Request: Schema.String,
        Result: PathRow,
        execute: (userId) => sql`
          SELECT object_path FROM office.recording_clips
          WHERE user_id = ${userId} AND object_path IS NOT NULL
          ORDER BY id
        `,
      });

      const findChannels = SqlSchema.findAll({
        Request: Schema.Void,
        Result: ChannelRow,
        execute: () => sql`
          SELECT DISTINCT channel_id AS channel FROM office.slack_posts
          WHERE deleted_at IS NULL
          ORDER BY channel
        `,
      });

      const findThreads = SqlSchema.findAll({
        Request: Schema.Void,
        Result: ThreadRow,
        execute: () => sql`
          SELECT DISTINCT channel, ts FROM (
            SELECT channel_id AS channel, thread_ts AS ts FROM office.slack_posts
            WHERE thread_ts IS NOT NULL AND deleted_at IS NULL
            UNION ALL
            SELECT slack_channel_id, slack_ts FROM office.recordings
            WHERE slack_channel_id IS NOT NULL AND slack_ts IS NOT NULL
          ) threads
          ORDER BY channel, ts
        `,
      });

      const subject = Effect.fn("ErasureStore.subject")(function* (userId: string) {
        const names = yield* onceReady(findNames(userId));
        const slackIds = yield* onceReady(findSlackIds(userId));
        const paths = yield* onceReady(findPaths(userId));

        const slackUserIds = Array.map(slackIds, ({ slackUserId }) => slackUserId);

        return {
          userId,
          slackUserIds,
          scrubber: scrubberFor(
            Array.map(names, ({ name }) => name),
            slackUserIds,
          ),
          objectPaths: Array.map(paths, ({ objectPath }) => objectPath),
        } satisfies Subject;
      });

      const botPostings = Effect.gen(function* () {
        const channels = yield* onceReady(findChannels());
        const threads = yield* onceReady(findThreads());

        return {
          channels: Array.map(channels, ({ channel }) => channel),
          threads,
        } satisfies BotPostings;
      }).pipe(Effect.withSpan("ErasureStore.botPostings"));

      const recordingIds = (rows: ReadonlyArray<typeof RecordingRow.Type>) =>
        Array.map(rows, ({ recordingId }) => recordingId);

      const mentioning = (scrubber: Scrubber, column: string) =>
        sql.or(
          Array.map(
            scrubber.needles,
            (needle) => sql`strpos(lower(${sql(column)}::text), ${needle}) > 0`,
          ),
        );

      const scrubbedValue = (scrubber: Scrubber, { json }: Column, value: string) =>
        json
          ? decodeJsonText(value).pipe(
              Effect.map(scrubber.json),
              Effect.flatMap(encodeJsonText),
              Effect.orDie,
            )
          : Effect.succeed(scrubber.text(value));

      const scrubColumn = Effect.fnUntraced(function* (scrubber: Scrubber, column: Column) {
        const candidates = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: ScrubRow,
          execute: () => sql`
            SELECT id::text AS id, ${sql(column.column)}::text AS value FROM ${sql(column.table)}
            WHERE ${sql(column.column)} IS NOT NULL AND ${mentioning(scrubber, column.column)}
          `,
        })();

        const changed = yield* Effect.forEach(candidates, ({ id, value }) =>
          scrubbedValue(scrubber, column, value).pipe(
            Effect.flatMap((scrubbed) =>
              scrubbed === value
                ? Effect.succeed(Array.empty<typeof ScrubbedRow.Type>())
                : SqlSchema.findAll({
                    Request: Schema.Void,
                    Result: ScrubbedRow,
                    execute: () => sql`
                      UPDATE ${sql(column.table)}
                      SET ${sql(column.column)} = ${scrubbed}${sql.literal(column.json ? "::jsonb" : "")}
                      WHERE id::text = ${id}
                      RETURNING ${column.recording === null ? sql.literal("NULL") : sql(column.recording)}::text AS recording_id
                    `,
                  })(),
            ),
          ),
        );

        return Array.flatMap(Array.flatten(changed), ({ recordingId }) =>
          recordingId === null ? [] : [recordingId],
        );
      });

      const deleteOwn = Effect.fnUntraced(function* (subject: Subject) {
        const { userId } = subject;

        const spokenIn = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Schema.Struct({
            recordingId: Schema.String,
            objectPath: Schema.NullOr(Schema.String),
          }),
          execute: () => sql`
            DELETE FROM office.recording_clips WHERE user_id = ${userId}
            RETURNING recording_id, object_path
          `,
        })();

        yield* sql`DELETE FROM office.voice_snapshots WHERE user_id = ${userId}`;
        yield* sql`DELETE FROM office.voice_effects WHERE user_id = ${userId}`;
        const slackIds = subject.slackUserIds;

        yield* sql`
          WITH own AS (
            SELECT id FROM office.slack_messages
            WHERE member_user_id = ${userId}
              ${Array.isReadonlyArrayNonEmpty(slackIds) ? sql`OR user_id IN ${sql.in(slackIds)}` : sql.literal("")}
          ),
          decisions AS (DELETE FROM office.slack_decisions WHERE message_id IN (SELECT id FROM own))
          DELETE FROM office.slack_messages WHERE id IN (SELECT id FROM own)
        `;

        if (Array.isReadonlyArrayNonEmpty(slackIds))
          yield* sql`DELETE FROM office.slack_reactions WHERE user_id IN ${sql.in(slackIds)}`;

        yield* sql`
          DELETE FROM office.rejected_updates WHERE strpos(payload::text, ${`"${userId}"`}) > 0
        `;

        return spokenIn;
      });

      const repoint = Effect.fnUntraced(function* (userId: string) {
        const started = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: RecordingRow,
          execute: () => sql`
            UPDATE office.recordings
            SET started_by = CASE WHEN started_by = ${userId} THEN ${FORMER_MEMBER_ID} ELSE started_by END,
                stopped_by = CASE WHEN stopped_by = ${userId} THEN ${FORMER_MEMBER_ID} ELSE stopped_by END,
                paused_by = CASE WHEN paused_by = ${userId} THEN ${FORMER_MEMBER_ID} ELSE paused_by END
            WHERE ${userId} IN (started_by, stopped_by, paused_by)
            RETURNING id AS recording_id
          `,
        })();

        const events = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: RecordingRow,
          execute: () => sql`
            UPDATE office.recording_events SET user_id = ${FORMER_MEMBER_ID}
            WHERE user_id = ${userId}
            RETURNING recording_id
          `,
        })();

        const owned = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: RecordingRow,
          execute: () => sql`
            UPDATE office.recording_action_items SET owner = NULL
            WHERE owner = ${userId}
            RETURNING recording_id
          `,
        })();

        yield* sql`
          UPDATE office.recording_requests
          SET requested_by = ${FORMER_MEMBER_ID}, requested_by_name = ${FORMER_MEMBER}
          WHERE requested_by = ${userId}
        `;
        yield* sql`
          UPDATE office.recording_edits
          SET edited_by = ${FORMER_MEMBER_ID}, edited_by_name = ${FORMER_MEMBER}
          WHERE edited_by = ${userId}
        `;
        yield* sql`
          UPDATE office.recording_edits SET change = jsonb_set(change, '{owner}', 'null'::jsonb)
          WHERE kind = 'reassign' AND change->>'owner' = ${userId}
        `;

        return [...recordingIds(started), ...recordingIds(events), ...recordingIds(owned)];
      });

      const forgetDerived = (spokenIn: ReadonlyArray<string>) =>
        Array.isReadonlyArrayNonEmpty(spokenIn)
          ? Effect.all([
              sql`DELETE FROM office.recording_summaries WHERE recording_id IN ${sql.in(spokenIn)}`,
              sql`
                DELETE FROM office.recording_action_items
                WHERE recording_id IN ${sql.in(spokenIn)} AND replaced_at IS NOT NULL
              `,
              sql`
                WITH untouched AS (
                  UPDATE office.recordings r
                  SET action_items_pulled_at = NULL, action_items_model = NULL
                  WHERE r.id IN ${sql.in(spokenIn)} AND r.finished_at IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM office.recording_edits e
                      WHERE e.recording_id = r.id AND e.kind IN ('tick', 'untick', 'reassign')
                        AND e.outcome IS DISTINCT FROM 'ignored'
                    )
                  RETURNING r.id
                )
                DELETE FROM office.recording_action_items
                WHERE recording_id IN (SELECT id FROM untouched)
              `,
              sql`
                UPDATE office.recordings
                SET summary = NULL, summary_model = NULL, summary_written_style = NULL
                WHERE id IN ${sql.in(spokenIn)} AND finished_at IS NOT NULL
              `,
            ])
          : Effect.void;

      const spokeIn = (spokenIn: ReadonlyArray<string>) =>
        Array.isReadonlyArrayNonEmpty(spokenIn)
          ? sql`id IN ${sql.in(spokenIn)}`
          : sql.literal("false");

      const markForRepublishing = (
        touched: ReadonlyArray<string>,
        spokenIn: ReadonlyArray<string>,
      ) =>
        Array.isReadonlyArrayNonEmpty(touched)
          ? SqlSchema.findAll({
              Request: Schema.Void,
              Result: RecordingRow,
              execute: () => sql`
                UPDATE office.recordings
                SET transcript = NULL, republish_requested_at = now(),
                    republish_resummarize = republish_resummarize OR ${spokeIn(spokenIn)}
                WHERE id IN ${sql.in(touched)} AND stopped_at IS NOT NULL
                RETURNING id AS recording_id
              `,
            })()
          : Effect.succeed(Array.empty<typeof RecordingRow.Type>());

      const erase = Effect.fn("ErasureStore.erase")((subject: Subject) =>
        atomically(
          Effect.gen(function* () {
            const removed = yield* deleteOwn(subject);
            const spokenIn = pipe(recordingIds(removed), Array.dedupe);
            const repointed = yield* repoint(subject.userId);

            const scrubbed = Array.isReadonlyArrayNonEmpty(subject.scrubber.needles)
              ? yield* Effect.forEach(SCRUBBED, (column) => scrubColumn(subject.scrubber, column))
              : [];

            if (Array.isReadonlyArrayNonEmpty(subject.scrubber.needles))
              yield* sql`
                UPDATE office.slack_decisions SET clef_request = NULL
                WHERE clef_request IS NOT NULL AND ${mentioning(subject.scrubber, "clef_request")}
              `;

            yield* forgetDerived(spokenIn);
            yield* sql`DELETE FROM office.members WHERE user_id = ${subject.userId}`;

            const republishing = yield* markForRepublishing(
              pipe([...spokenIn, ...repointed, ...Array.flatten(scrubbed)], Array.dedupe),
              spokenIn,
            );

            return {
              objectPaths: Array.flatMap(removed, ({ objectPath }) =>
                objectPath === null ? [] : [objectPath],
              ),
              republishing: republishing.length,
            } satisfies Erased;
          }),
        ),
      );

      const sweep = Effect.fn("ErasureStore.sweep")((userId: string) =>
        atomically(
          Effect.all([
            sql`DELETE FROM office.voice_snapshots WHERE user_id = ${userId}`,
            sql`DELETE FROM office.voice_effects WHERE user_id = ${userId}`,
            sql`
              DELETE FROM office.members m
              WHERE m.user_id = ${userId}
                AND NOT EXISTS (SELECT 1 FROM office.recording_clips c WHERE c.user_id = m.user_id)
                AND NOT EXISTS (SELECT 1 FROM office.recordings r WHERE r.started_by = m.user_id)
                AND NOT EXISTS (SELECT 1 FROM office.recording_action_items a WHERE a.owner = m.user_id)
                AND NOT EXISTS (SELECT 1 FROM office.slack_messages s WHERE s.member_user_id = m.user_id)
            `,
          ]),
        ),
      );

      return ErasureStore.of({ subject, botPostings, erase, sweep });
    }),
  );

  static readonly layerDisabled = Layer.succeed(
    ErasureStore,
    ErasureStore.of({
      subject: notRecording,
      botPostings: notRecording(),
      erase: notRecording,
      sweep: notRecording,
    }),
  );
}
