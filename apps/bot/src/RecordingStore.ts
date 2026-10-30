import { Array, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { type ActiveRecording, RowId } from "recording-requests/RecordingRequest";

import { memberUpsert } from "./ActivityLog.ts";
import { Database, describeError } from "./Database.ts";
import { MAX_TRANSCRIPTION_ATTEMPTS, StopReason, TranscriptionStatus } from "./Recording.ts";

const QUERY_TIMEOUT = Duration.seconds(10);

export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()("StoreUnavailable", {
  reason: Schema.String,
}) {}

export interface NewRecording {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly startedAt: DateTime.Utc;
  readonly startedBy: string;
  readonly startedByName: string;
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

export interface RecordingDetails {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly startedAt: DateTime.Utc;
  readonly stoppedAt: DateTime.Utc;
  readonly startedByName: string;
  readonly stopReason: StopReason;
}

export interface FinishedRecording {
  readonly transcript: string;
  readonly summary: string | null;
  readonly summaryModel: string | null;
  readonly slackChannelId: string | null;
  readonly slackTs: string | null;
  readonly finishedAt: DateTime.Utc;
}

const decodeActive = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      startedAt: Schema.DateTimeUtcFromDate,
      startedBy: Schema.String,
    }),
  ),
);

const decodePending = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: RowId,
      recordingId: Schema.String,
      objectPath: Schema.NullOr(Schema.String),
      attempts: Schema.Number,
    }),
  ),
);

const decodeClipLines = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      who: Schema.String,
      startedAt: Schema.DateTimeUtcFromDate,
      durationMs: Schema.Number,
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
    }),
  ),
);

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));

const decodeCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ total: Schema.Number })),
);

const notRecording = () => Effect.fail(new StoreUnavailable({ reason: "Nothing is recorded" }));

export class RecordingStore extends Context.Service<
  RecordingStore,
  {
    readonly activeRecording: Effect.Effect<Option.Option<ActiveRecording>, StoreUnavailable>;
    readonly unfinishedRecordings: Effect.Effect<ReadonlyArray<string>, StoreUnavailable>;
    startRecording(recording: NewRecording): Effect.Effect<void, StoreUnavailable>;
    resumeRecording(id: string, at: DateTime.Utc): Effect.Effect<void, StoreUnavailable>;
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
    recordingDetails(id: string): Effect.Effect<Option.Option<RecordingDetails>, StoreUnavailable>;
    finishRecording(id: string, finished: FinishedRecording): Effect.Effect<void, StoreUnavailable>;
  }
>()("virtual-office-notifier/RecordingStore") {
  static readonly layer = Layer.effect(
    RecordingStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;
      const upsertMember = memberUpsert(sql);

      const onceReady = <A, E extends Error>(query: Effect.Effect<A, E>) =>
        database.ready.pipe(
          Effect.andThen(query),
          Effect.mapError((error) => new StoreUnavailable({ reason: describeError(error) })),
          Effect.timeoutOrElse({
            duration: QUERY_TIMEOUT,
            orElse: () =>
              Effect.fail(new StoreUnavailable({ reason: "Timed out after 10 seconds" })),
          }),
        );

      const activeRecording = onceReady(
        sql`SELECT id, started_at, started_by FROM office.recordings WHERE stopped_at IS NULL LIMIT 1`.pipe(
          Effect.flatMap(decodeActive),
        ),
      ).pipe(Effect.map(Array.head), Effect.withSpan("RecordingStore.activeRecording"));

      const unfinishedRecordings = onceReady(
        sql`SELECT id FROM office.recordings WHERE stopped_at IS NOT NULL AND finished_at IS NULL ORDER BY started_at`.pipe(
          Effect.flatMap(decodeIds),
        ),
      ).pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
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
                  })}
                `,
                event(recording.id, recording.startedAt, "started", null, recording.startedBy),
              ]),
            ),
          ),
        Effect.asVoid,
      );

      const resumeRecording = Effect.fn("RecordingStore.resumeRecording")(
        (id: string, at: DateTime.Utc) => onceReady(event(id, at, "resumed", null, null)),
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

      const recordingDetails = Effect.fn("RecordingStore.recordingDetails")((id: string) =>
        onceReady(
          sql`
            SELECT r.id, r.guild_id, r.channel_id, r.started_at, r.stopped_at,
                   coalesce(m.real_name, m.display_name) AS started_by_name, r.stop_reason
            FROM office.recordings r
            JOIN office.members m ON m.user_id = r.started_by
            WHERE r.id = ${id} AND r.stopped_at IS NOT NULL
          `.pipe(Effect.flatMap(decodeDetails), Effect.map(Array.head)),
        ),
      );

      const finishRecording = Effect.fn("RecordingStore.finishRecording")(
        (id: string, finished: FinishedRecording) =>
          onceReady(
            sql`
              UPDATE office.recordings
              SET transcript = ${finished.transcript}, summary = ${finished.summary},
                  summary_model = ${finished.summaryModel}, slack_channel_id = ${finished.slackChannelId},
                  slack_ts = ${finished.slackTs}, finished_at = ${DateTime.toDate(finished.finishedAt)}
              WHERE id = ${id}
            `,
          ),
        Effect.asVoid,
      );

      return RecordingStore.of({
        activeRecording,
        unfinishedRecordings,
        startRecording,
        resumeRecording,
        stopRecording,
        addClip,
        nextPendingClip,
        clipTranscribed,
        clipFailed,
        outstandingClips,
        clipsOf,
        recordingDetails,
        finishRecording,
      });
    }),
  );

  static readonly layerDisabled = Layer.succeed(
    RecordingStore,
    RecordingStore.of({
      activeRecording: notRecording(),
      unfinishedRecordings: notRecording(),
      startRecording: notRecording,
      resumeRecording: notRecording,
      stopRecording: notRecording,
      addClip: notRecording,
      nextPendingClip: notRecording(),
      clipTranscribed: notRecording,
      clipFailed: notRecording,
      outstandingClips: notRecording,
      clipsOf: notRecording,
      recordingDetails: notRecording,
      finishRecording: notRecording,
    }),
  );
}
