import { Array, Context, DateTime, Duration, Effect, Layer, Match, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { RecordingChange } from "recording-requests/RecordingEdit";
import { type ActiveRecording, RowId } from "recording-requests/RecordingRequest";

import {
  type ActionItemLine,
  ActionItemList,
  type Member,
  type PulledActionItems,
} from "./ActionItems.ts";
import { memberUpsert } from "./ActivityLog.ts";
import { Database, describeError } from "./Database.ts";
import {
  MAX_TRANSCRIPTION_ATTEMPTS,
  type ResumeReason,
  StopReason,
  TranscriptionStatus,
} from "./Recording.ts";

const QUERY_TIMEOUT = Duration.seconds(10);

export class StoreUnavailable extends Schema.TaggedError<
  StoreUnavailable,
  { readonly brand: unique symbol }
>()("StoreUnavailable", {
  reason: Schema.String,
}) {}

export interface NewRecording {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly startedAt: DateTime.Utc;
  readonly startedBy: string;
  readonly startedByName: string;
  readonly title: string | null;
  readonly agenda: string | null;
}

export interface NewClip {
  readonly recordingId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly startedAt: DateTime.Utc;
  readonly durationMs: number;
  readonly bytes: number;
  readonly objectPath: string | null;
  readonly transcription: Extract<TranscriptionStatus, "pending" | "skipped">;
}

export interface PendingClip {
  readonly id: number;
  readonly recordingId: string;
  readonly objectPath: string | null;
  readonly attempts: number;
}

export interface ClipLine {
  readonly userId: string;
  readonly who: string;
  readonly startedAt: DateTime.Utc;
  readonly durationMs: number;
  readonly transcription: TranscriptionStatus;
  readonly transcript: string | null;
}

export interface PauseLine {
  readonly pausedAt: DateTime.Utc;
  readonly resumedAt: DateTime.Utc | null;
  readonly who: string;
}

export interface RecordingDetails {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly startedAt: DateTime.Utc;
  readonly stoppedAt: DateTime.Utc;
  readonly startedByName: string;
  readonly stopReason: StopReason;
  readonly title: string | null;
  readonly agenda: string | null;
}

export interface SummaryPost {
  readonly slackChannelId: string;
  readonly slackTs: string;
  readonly summary: string | null;
  readonly summaryModel: string | null;
}

export interface FinishedRecording {
  readonly transcript: string;
  readonly summary: string | null;
  readonly summaryModel: string | null;
  readonly slackChannelId: string | null;
  readonly slackTs: string | null;
  readonly slackPermalink: string | null;
  readonly finishedAt: DateTime.Utc;
}

export interface UnlinkedPost {
  readonly id: string;
  readonly slackChannelId: string;
  readonly slackTs: string;
}

const ActiveRow = Schema.Struct({
  id: Schema.String,
  startedAt: Schema.DateTimeUtcFromDate,
  startedBy: Schema.String,
  pausedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  pausedBy: Schema.NullOr(Schema.String),
});

const decodeActive = Schema.decodeUnknownEffect(Schema.Array(ActiveRow));

const toActive = (row: typeof ActiveRow.Type): ActiveRecording => ({
  id: row.id,
  startedAt: row.startedAt,
  startedBy: row.startedBy,
  pause:
    row.pausedAt === null || row.pausedBy === null
      ? Option.none()
      : Option.some({ pausedAt: row.pausedAt, pausedBy: row.pausedBy }),
});

const decodePauses = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      pausedAt: Schema.DateTimeUtcFromDate,
      resumedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
      who: Schema.String,
    }),
  ),
);

const decodePending = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: RowId,
      recordingId: Schema.String,
      objectPath: Schema.NullOr(Schema.String),
      attempts: Schema.Finite,
    }),
  ),
);

const decodeClipLines = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      who: Schema.String,
      startedAt: Schema.DateTimeUtcFromDate,
      durationMs: Schema.Finite,
      transcription: TranscriptionStatus,
      transcript: Schema.NullOr(Schema.String),
    }),
  ),
);

const decodeDetails = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      guildId: Schema.String,
      channelId: Schema.String,
      startedAt: Schema.DateTimeUtcFromDate,
      stoppedAt: Schema.DateTimeUtcFromDate,
      startedByName: Schema.String,
      stopReason: StopReason,
      title: Schema.NullOr(Schema.String),
      agenda: Schema.NullOr(Schema.String),
    }),
  ),
);

const decodePosts = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      slackChannelId: Schema.String,
      slackTs: Schema.String,
      summary: Schema.NullOr(Schema.String),
      summaryModel: Schema.NullOr(Schema.String),
    }),
  ),
);

const decodeUnlinked = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ id: Schema.String, slackChannelId: Schema.String, slackTs: Schema.String }),
  ),
);

const decodeMembers = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ userId: Schema.String, name: Schema.String })),
);

const decodeTried = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ tried: Schema.Boolean, pulled: Schema.Boolean })),
);

const decodeActionItems = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: RowId,
      text: Schema.String,
      ownerName: Schema.NullOr(Schema.String),
      done: Schema.Boolean,
    }),
  ),
);

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));

const decodeCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ total: Schema.Finite })),
);

const notRecording = () => Effect.fail(StoreUnavailable.make({ reason: "Nothing is recorded" }));

export class RecordingStore extends Context.Service<
  RecordingStore,
  {
    readonly activeRecording: Effect.Effect<Option.Option<ActiveRecording>, StoreUnavailable>;
    readonly unfinishedRecordings: Effect.Effect<ReadonlyArray<string>, StoreUnavailable>;
    startRecording(recording: NewRecording): Effect.Effect<void, StoreUnavailable>;
    recoverRecording(id: string, at: DateTime.Utc): Effect.Effect<void, StoreUnavailable>;
    pauseRecording(
      id: string,
      at: DateTime.Utc,
      by: string,
      byName: string,
    ): Effect.Effect<void, StoreUnavailable>;
    resumeRecording(
      id: string,
      at: DateTime.Utc,
      by: string,
      byName: string,
    ): Effect.Effect<void, StoreUnavailable>;
    stopRecording(
      id: string,
      at: DateTime.Utc,
      reason: StopReason,
      by: string | null,
    ): Effect.Effect<void, StoreUnavailable>;
    addClip(clip: NewClip): Effect.Effect<number, StoreUnavailable>;
    readonly nextPendingClip: Effect.Effect<Option.Option<PendingClip>, StoreUnavailable>;
    clipTranscribed(
      id: number,
      at: DateTime.Utc,
      transcript: string,
      model: string,
    ): Effect.Effect<void, StoreUnavailable>;
    clipFailed(id: number, error: string, final: boolean): Effect.Effect<void, StoreUnavailable>;
    outstandingClips(recordingId: string): Effect.Effect<number, StoreUnavailable>;
    clipsOf(recordingId: string): Effect.Effect<ReadonlyArray<ClipLine>, StoreUnavailable>;
    pausesOf(recordingId: string): Effect.Effect<ReadonlyArray<PauseLine>, StoreUnavailable>;
    recordingDetails(id: string): Effect.Effect<Option.Option<RecordingDetails>, StoreUnavailable>;
    summaryPost(id: string): Effect.Effect<Option.Option<SummaryPost>, StoreUnavailable>;
    applyEdit(id: string, change: RecordingChange): Effect.Effect<void, StoreUnavailable>;
    presentDuring(id: string): Effect.Effect<ReadonlyArray<Member>, StoreUnavailable>;
    actionItemsOf(id: string): Effect.Effect<ActionItemList, StoreUnavailable>;
    recordActionItems(
      id: string,
      pulled: Option.Option<PulledActionItems>,
      at: DateTime.Utc,
    ): Effect.Effect<void, StoreUnavailable>;
    finishRecording(id: string, finished: FinishedRecording): Effect.Effect<void, StoreUnavailable>;
    readonly unlinkedPosts: Effect.Effect<ReadonlyArray<UnlinkedPost>, StoreUnavailable>;
    linkPost(id: string, permalink: string): Effect.Effect<void, StoreUnavailable>;
  }
>()("bot/RecordingStore") {
  static readonly layer = Layer.effect(
    RecordingStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;
      const upsertMember = memberUpsert(sql);

      const onceReady = <A, E extends Error>(query: Effect.Effect<A, E>) =>
        database.ready.pipe(
          Effect.andThen(query),
          Effect.mapError((error) => StoreUnavailable.make({ reason: describeError(error) })),
          Effect.timeoutOrElse({
            duration: QUERY_TIMEOUT,
            orElse: () =>
              Effect.fail(StoreUnavailable.make({ reason: "Timed out after 10 seconds" })),
          }),
        );

      const activeRecording = onceReady(
        sql`
          SELECT id, started_at, started_by, paused_at, paused_by
          FROM office.recordings WHERE stopped_at IS NULL LIMIT 1
        `.pipe(Effect.flatMap(decodeActive)),
      ).pipe(
        Effect.map((rows) => Option.map(Array.head(rows), toActive)),
        Effect.withSpan("RecordingStore.activeRecording"),
      );

      const unfinishedRecordings = onceReady(
        sql`SELECT id FROM office.recordings WHERE stopped_at IS NOT NULL AND finished_at IS NULL ORDER BY started_at`.pipe(
          Effect.flatMap(decodeIds),
        ),
      ).pipe(
        Effect.map((rows) => Array.map(rows, (row) => row.id)),
        Effect.withSpan("RecordingStore.unfinishedRecordings"),
      );

      const event = (
        recordingId: string,
        at: DateTime.Utc,
        event: string,
        reason: string | null,
        userId: string | null,
      ) =>
        sql`
          INSERT INTO office.recording_events ${sql.insert({ recordingId, at: DateTime.toDate(at), event, reason, userId })}
        `;

      const startRecording = Effect.fn("RecordingStore.startRecording")(
        (recording: NewRecording) =>
          onceReady(
            sql.withTransaction(
              Effect.all([
                upsertMember(recording.startedBy, recording.startedByName, recording.startedAt),
                sql`
                  INSERT INTO office.recordings ${sql.insert({
                    id: recording.id,
                    guildId: recording.guildId,
                    channelId: recording.channelId,
                    startedAt: DateTime.toDate(recording.startedAt),
                    startedBy: recording.startedBy,
                    title: recording.title,
                    agenda: recording.agenda,
                  })}
                `,
                event(recording.id, recording.startedAt, "started", null, recording.startedBy),
              ]),
            ),
          ),
        Effect.asVoid,
      );

      const recoverRecording = Effect.fn("RecordingStore.recoverRecording")(
        (id: string, at: DateTime.Utc) =>
          onceReady(event(id, at, "resumed", "bot_restarted" satisfies ResumeReason, null)),
        Effect.asVoid,
      );

      const pauseRecording = Effect.fn("RecordingStore.pauseRecording")(
        (id: string, at: DateTime.Utc, by: string, byName: string) =>
          onceReady(
            sql.withTransaction(
              Effect.all([
                upsertMember(by, byName, at),
                sql`
                  UPDATE office.recordings
                  SET paused_at = ${DateTime.toDate(at)}, paused_by = ${by}
                  WHERE id = ${id} AND stopped_at IS NULL
                `,
                event(id, at, "paused", null, by),
              ]),
            ),
          ),
        Effect.asVoid,
      );

      const resumeRecording = Effect.fn("RecordingStore.resumeRecording")(
        (id: string, at: DateTime.Utc, by: string, byName: string) =>
          onceReady(
            sql.withTransaction(
              Effect.all([
                upsertMember(by, byName, at),
                sql`
                  UPDATE office.recordings
                  SET paused_at = NULL, paused_by = NULL
                  WHERE id = ${id} AND stopped_at IS NULL
                `,
                event(id, at, "resumed", "requested" satisfies ResumeReason, by),
              ]),
            ),
          ),
        Effect.asVoid,
      );

      const stopRecording = Effect.fn("RecordingStore.stopRecording")(
        (id: string, at: DateTime.Utc, reason: StopReason, by: string | null) =>
          onceReady(
            sql.withTransaction(
              Effect.all([
                sql`
                  UPDATE office.recordings
                  SET stopped_at = ${DateTime.toDate(at)}, stop_reason = ${reason}, stopped_by = ${by}
                  WHERE id = ${id} AND stopped_at IS NULL
                `,
                event(id, at, "stopped", reason, by),
              ]),
            ),
          ),
        Effect.asVoid,
      );

      const addClip = Effect.fn("RecordingStore.addClip")(function* (clip: NewClip) {
        const rows = yield* onceReady(
          sql.withTransaction(
            upsertMember(clip.userId, clip.displayName, clip.startedAt).pipe(
              Effect.andThen(
                sql<{ readonly id: string | number }>`
                  INSERT INTO office.recording_clips ${sql.insert({
                    recordingId: clip.recordingId,
                    userId: clip.userId,
                    startedAt: DateTime.toDate(clip.startedAt),
                    durationMs: clip.durationMs,
                    bytes: clip.bytes,
                    objectPath: clip.objectPath,
                    transcription: clip.transcription,
                  })}
                  ON CONFLICT (recording_id, user_id, started_at) DO UPDATE SET bytes = EXCLUDED.bytes
                  RETURNING id
                `,
              ),
            ),
          ),
        );

        return Number(rows[0]?.id);
      });

      const nextPendingClip = onceReady(
        sql`
          SELECT id, recording_id, object_path, attempts
          FROM office.recording_clips
          WHERE transcription = 'pending'
          ORDER BY id
          LIMIT 1
        `.pipe(Effect.flatMap(decodePending)),
      ).pipe(Effect.map(Array.head), Effect.withSpan("RecordingStore.nextPendingClip"));

      const clipTranscribed = Effect.fn("RecordingStore.clipTranscribed")(
        (id: number, at: DateTime.Utc, transcript: string, model: string) =>
          onceReady(
            sql`
              UPDATE office.recording_clips
              SET transcription = 'done', transcript = ${transcript}, model = ${model},
                  transcribed_at = ${DateTime.toDate(at)}, attempts = attempts + 1, last_error = NULL
              WHERE id = ${id}
            `,
          ),
        Effect.asVoid,
      );

      const clipFailed = Effect.fn("RecordingStore.clipFailed")(
        (id: number, error: string, final: boolean) =>
          onceReady(
            sql`
              UPDATE office.recording_clips
              SET attempts = attempts + 1, last_error = ${error},
                  transcription = CASE
                    WHEN ${final} OR attempts + 1 >= ${MAX_TRANSCRIPTION_ATTEMPTS} THEN 'failed'
                    ELSE 'pending'
                  END
              WHERE id = ${id}
            `,
          ),
        Effect.asVoid,
      );

      const outstandingClips = Effect.fn("RecordingStore.outstandingClips")(function* (
        recordingId: string,
      ) {
        const rows = yield* onceReady(
          sql`
            SELECT count(*)::int AS total FROM office.recording_clips
            WHERE recording_id = ${recordingId} AND transcription = 'pending'
          `.pipe(Effect.flatMap(decodeCount)),
        );

        return rows[0]?.total ?? 0;
      });

      const clipsOf = Effect.fn("RecordingStore.clipsOf")((recordingId: string) =>
        onceReady(
          sql`
            SELECT c.user_id, coalesce(m.real_name, m.display_name) AS who, c.started_at, c.duration_ms,
                   c.transcription, c.transcript
            FROM office.recording_clips c
            JOIN office.members m USING (user_id)
            WHERE c.recording_id = ${recordingId}
            ORDER BY c.started_at, c.id
          `.pipe(Effect.flatMap(decodeClipLines)),
        ),
      );

      const pausesOf = Effect.fn("RecordingStore.pausesOf")((recordingId: string) =>
        onceReady(
          sql`
            SELECT p.at AS paused_at, coalesce(m.real_name, m.display_name, p.user_id) AS who,
                   (
                     SELECT e.at FROM office.recording_events e
                     WHERE e.recording_id = p.recording_id AND e.id > p.id
                       AND (e.event = 'stopped' OR (e.event = 'resumed' AND e.reason = 'requested'))
                     ORDER BY e.id
                     LIMIT 1
                   ) AS resumed_at
            FROM office.recording_events p
            LEFT JOIN office.members m ON m.user_id = p.user_id
            WHERE p.recording_id = ${recordingId} AND p.event = 'paused'
            ORDER BY p.id
          `.pipe(Effect.flatMap(decodePauses)),
        ),
      );

      const recordingDetails = Effect.fn("RecordingStore.recordingDetails")((id: string) =>
        onceReady(
          sql`
            SELECT r.id, r.guild_id, r.channel_id, r.started_at, r.stopped_at,
                   coalesce(m.real_name, m.display_name) AS started_by_name, r.stop_reason,
                   r.title, r.agenda
            FROM office.recordings r
            JOIN office.members m ON m.user_id = r.started_by
            WHERE r.id = ${id} AND r.stopped_at IS NOT NULL
          `.pipe(Effect.flatMap(decodeDetails), Effect.map(Array.head)),
        ),
      );

      const summaryPost = Effect.fn("RecordingStore.summaryPost")((id: string) =>
        onceReady(
          sql`
            SELECT slack_channel_id, slack_ts, summary, summary_model FROM office.recordings
            WHERE id = ${id} AND slack_channel_id IS NOT NULL AND slack_ts IS NOT NULL
          `.pipe(Effect.flatMap(decodePosts), Effect.map(Array.head)),
        ),
      );

      const markItem = (id: string, item: number, done: boolean) =>
        sql`
          UPDATE office.recording_action_items SET done = ${done}
          WHERE id = ${item} AND recording_id = ${id} AND replaced_at IS NULL
        `;

      const applyEdit = Effect.fn("RecordingStore.applyEdit")(
        (id: string, change: RecordingChange) =>
          onceReady(
            Match.value(change).pipe(
              Match.discriminatorsExhaustive("kind")({
                title: ({ title }) =>
                  sql`UPDATE office.recordings SET title = ${title} WHERE id = ${id}`,
                agenda: ({ agenda }) =>
                  sql`UPDATE office.recordings SET agenda = ${agenda} WHERE id = ${id}`,
                tick: ({ item }) => markItem(id, item, true),
                untick: ({ item }) => markItem(id, item, false),
                reassign: ({ item, owner }) => sql`
                  UPDATE office.recording_action_items SET owner = ${owner}
                  WHERE id = ${item} AND recording_id = ${id} AND replaced_at IS NULL
                    AND (${owner}::text IS NULL OR EXISTS (SELECT 1 FROM office.members WHERE user_id = ${owner}))
                `,
              }),
            ),
          ),
        Effect.asVoid,
      );

      const presentDuring = Effect.fn("RecordingStore.presentDuring")((id: string) =>
        onceReady(
          sql`
            WITH r AS (
              SELECT id, channel_id, started_at, coalesce(stopped_at, now()) AS stopped_at, started_by
              FROM office.recordings WHERE id = ${id}
            ),
            session AS (
              SELECT b.id FROM office.bot_sessions b, r
              WHERE b.started_at <= r.started_at
              ORDER BY b.started_at DESC
              LIMIT 1
            ),
            before AS (
              SELECT DISTINCT ON (s.user_id) s.user_id,
                     s.new_channel_id IS NOT DISTINCT FROM s.office_channel_id AS is_in
              FROM office.voice_snapshots s, r
              WHERE s.office_channel_id = r.channel_id AND s.observed_at <= r.started_at
                AND s.bot_session_id IN (SELECT id FROM session)
              ORDER BY s.user_id, s.observed_at DESC, s.id DESC
            ),
            present AS (
              SELECT user_id FROM before WHERE is_in
              UNION
              SELECT s.user_id FROM office.voice_snapshots s, r
              WHERE s.office_channel_id = r.channel_id
                AND s.observed_at > r.started_at AND s.observed_at <= r.stopped_at
                AND s.new_channel_id IS NOT DISTINCT FROM s.office_channel_id
              UNION
              SELECT user_id FROM office.recording_clips WHERE recording_id = ${id}
              UNION
              SELECT started_by FROM r
            )
            SELECT m.user_id, coalesce(m.real_name, m.display_name) AS name
            FROM present p
            JOIN office.members m USING (user_id)
            ORDER BY lower(coalesce(m.real_name, m.display_name)), m.user_id
          `.pipe(Effect.flatMap(decodeMembers)),
        ),
      );

      const actionItemsOf = Effect.fn("RecordingStore.actionItemsOf")(function* (id: string) {
        const [state] = yield* onceReady(
          sql`
            SELECT action_items_pulled_at IS NOT NULL AS tried, action_items_model IS NOT NULL AS pulled
            FROM office.recordings WHERE id = ${id}
          `.pipe(Effect.flatMap(decodeTried)),
        );

        if (state === undefined || !state.tried) return ActionItemList.NotTried();

        if (!state.pulled) return ActionItemList.Failed();

        const items: ReadonlyArray<ActionItemLine> = yield* onceReady(
          sql`
            SELECT a.id, a.text, coalesce(m.real_name, m.display_name) AS owner_name, a.done
            FROM office.recording_action_items a
            LEFT JOIN office.members m ON m.user_id = a.owner
            WHERE a.recording_id = ${id} AND a.replaced_at IS NULL
            ORDER BY a.position, a.id
          `.pipe(Effect.flatMap(decodeActionItems)),
        );

        return ActionItemList.Pulled({ items });
      });

      const recordActionItems = Effect.fn("RecordingStore.recordActionItems")(
        (id: string, pulled: Option.Option<PulledActionItems>, at: DateTime.Utc) =>
          onceReady(
            sql.withTransaction(
              Effect.gen(function* () {
                const pulledAt = DateTime.toDate(at);
                const model = Option.getOrNull(Option.map(pulled, ({ model }) => model));

                const marked = yield* sql`
                  UPDATE office.recordings
                  SET action_items_pulled_at = ${pulledAt}, action_items_model = ${model}
                  WHERE id = ${id} AND action_items_pulled_at IS NULL
                  RETURNING id
                `;

                const items = Option.match(pulled, {
                  onNone: () => [],
                  onSome: ({ items }) => items,
                });

                if (marked.length === 0 || !Array.isReadonlyArrayNonEmpty(items)) return;

                yield* sql`
                  INSERT INTO office.recording_action_items ${sql.insert(
                    Array.map(items, ({ text, owner }, position) => ({
                      recordingId: id,
                      position,
                      text,
                      owner,
                      pulledAt,
                    })),
                  )}
                `;
              }),
            ),
          ),
      );

      const finishRecording = Effect.fn("RecordingStore.finishRecording")(
        (id: string, finished: FinishedRecording) =>
          onceReady(
            sql`
              UPDATE office.recordings
              SET transcript = ${finished.transcript}, summary = ${finished.summary},
                  summary_model = ${finished.summaryModel}, slack_channel_id = ${finished.slackChannelId},
                  slack_ts = ${finished.slackTs}, slack_permalink = ${finished.slackPermalink},
                  finished_at = ${DateTime.toDate(finished.finishedAt)}
              WHERE id = ${id}
            `,
          ),
        Effect.asVoid,
      );

      const unlinkedPosts = onceReady(
        sql`
          SELECT id, slack_channel_id, slack_ts FROM office.recordings
          WHERE slack_ts IS NOT NULL AND slack_channel_id IS NOT NULL AND slack_permalink IS NULL
          ORDER BY started_at
        `.pipe(Effect.flatMap(decodeUnlinked)),
      ).pipe(Effect.withSpan("RecordingStore.unlinkedPosts"));

      const linkPost = Effect.fn("RecordingStore.linkPost")(
        (id: string, permalink: string) =>
          onceReady(
            sql`
              UPDATE office.recordings SET slack_permalink = ${permalink}
              WHERE id = ${id} AND slack_permalink IS NULL
            `,
          ),
        Effect.asVoid,
      );

      return RecordingStore.of({
        activeRecording,
        unfinishedRecordings,
        startRecording,
        recoverRecording,
        pauseRecording,
        resumeRecording,
        stopRecording,
        addClip,
        nextPendingClip,
        clipTranscribed,
        clipFailed,
        outstandingClips,
        clipsOf,
        pausesOf,
        recordingDetails,
        summaryPost,
        applyEdit,
        presentDuring,
        actionItemsOf,
        recordActionItems,
        finishRecording,
        unlinkedPosts,
        linkPost,
      });
    }),
  );

  static readonly layerDisabled = Layer.succeed(
    RecordingStore,
    RecordingStore.of({
      activeRecording: notRecording(),
      unfinishedRecordings: notRecording(),
      startRecording: notRecording,
      recoverRecording: notRecording,
      pauseRecording: notRecording,
      resumeRecording: notRecording,
      stopRecording: notRecording,
      addClip: notRecording,
      nextPendingClip: notRecording(),
      clipTranscribed: notRecording,
      clipFailed: notRecording,
      outstandingClips: notRecording,
      clipsOf: notRecording,
      pausesOf: notRecording,
      recordingDetails: notRecording,
      summaryPost: notRecording,
      applyEdit: notRecording,
      presentDuring: notRecording,
      actionItemsOf: notRecording,
      recordActionItems: notRecording,
      finishRecording: notRecording,
      unlinkedPosts: notRecording(),
      linkPost: notRecording,
    }),
  );
}
