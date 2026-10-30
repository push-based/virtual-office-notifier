import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

import { columnNaming, Database } from "../src/Database.ts";
import { MAX_TRANSCRIPTION_ATTEMPTS } from "../src/Recording.ts";
import { type NewClip, RecordingStore } from "../src/RecordingStore.ts";

const TestLayer = RecordingStore.layer.pipe(
  Layer.provideMerge(Database.layerNoDeps()),
  Layer.provideMerge(PgliteClient.layer(columnNaming)),
);

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const minute = (n: number) => DateTime.makeUnsafe(n * 60_000);

const newRecording = (id = RECORDING) => ({
  id,
  guildId: "g1",
  channelId: "office",
  startedAt: minute(0),
  startedBy: "u1",
  startedByName: "Ada",
});

const clip = (overrides: Partial<NewClip> = {}): NewClip => ({
  recordingId: RECORDING,
  userId: "u2",
  displayName: "Grace",
  startedAt: minute(1),
  durationMs: 2000,
  bytes: 1234,
  objectPath: `recordings/${RECORDING}/u2/clip.ogg`,
  transcription: "pending",
  ...overrides,
});

const started = Effect.gen(function* () {
  const store = yield* RecordingStore;

  yield* store.startRecording(newRecording());

  return store;
});

describe("RecordingStore", () => {
  it.effect("starts a recording, with its member and a started event", () =>
    Effect.gen(function* () {
      const store = yield* started;
      const sql = yield* SqlClient.SqlClient;

      const active = yield* store.activeRecording;
      assert.deepStrictEqual(
        active,
        Option.some({ id: RECORDING, startedAt: minute(0), startedBy: "u1" }),
      );

      const [member] = yield* sql`SELECT user_id, display_name FROM office.members`;
      assert.deepStrictEqual(member, { userId: "u1", displayName: "Ada" });

      const events =
        yield* sql`SELECT event, reason, user_id FROM office.recording_events ORDER BY id`;

      assert.deepStrictEqual(events, [{ event: "started", reason: null, userId: "u1" }]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("allows only one recording at a time", () =>
    Effect.gen(function* () {
      const store = yield* started;

      const second = yield* store
        .startRecording(newRecording("8c3d4e5f-1111-4c55-9a0e-8e3b8f9b2a10"))
        .pipe(Effect.flip);

      assert.include(second.reason, "recordings_active");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stops a recording with its reason and who stopped it, once", () =>
    Effect.gen(function* () {
      const store = yield* started;
      const sql = yield* SqlClient.SqlClient;

      yield* store.stopRecording(RECORDING, minute(5), "requested", "u2");
      yield* store.stopRecording(RECORDING, minute(9), "time_limit", null);

      assert.deepStrictEqual(yield* store.activeRecording, Option.none());

      const [row] = yield* sql`SELECT stopped_at, stop_reason, stopped_by FROM office.recordings`;
      assert.deepStrictEqual(row, {
        stoppedAt: DateTime.toDate(minute(5)),
        stopReason: "requested",
        stoppedBy: "u2",
      });

      const events = yield* sql`SELECT event, reason FROM office.recording_events ORDER BY id`;
      assert.deepStrictEqual(
        Array.map(events, (event) => event.event),
        ["started", "stopped", "stopped"],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("lists stopped recordings until they're finished", () =>
    Effect.gen(function* () {
      const store = yield* started;

      assert.deepStrictEqual(yield* store.unfinishedRecordings, []);

      yield* store.stopRecording(RECORDING, minute(5), "office_emptied", null);
      assert.deepStrictEqual(yield* store.unfinishedRecordings, [RECORDING]);

      yield* store.finishRecording(RECORDING, {
        transcript: "nothing",
        summary: null,
        summaryModel: null,
        slackChannelId: null,
        slackTs: null,
        slackPermalink: null,
        finishedAt: minute(6),
      });
      assert.deepStrictEqual(yield* store.unfinishedRecordings, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records a resume as an event", () =>
    Effect.gen(function* () {
      const store = yield* started;
      const sql = yield* SqlClient.SqlClient;

      yield* store.resumeRecording(RECORDING, minute(3));

      const events = yield* sql`SELECT event, at FROM office.recording_events ORDER BY id`;
      assert.deepStrictEqual(events, [
        { event: "started", at: DateTime.toDate(minute(0)) },
        { event: "resumed", at: DateTime.toDate(minute(3)) },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stores clips with their member and queues the pending ones in order", () =>
    Effect.gen(function* () {
      const store = yield* started;

      const first = yield* store.addClip(clip());

      const skipped = yield* store.addClip(
        clip({ userId: "u1", displayName: "Ada", startedAt: minute(2), transcription: "skipped" }),
      );

      const second = yield* store.addClip(clip({ startedAt: minute(3), objectPath: null }));

      assert.notStrictEqual(first, skipped);
      assert.strictEqual(yield* store.outstandingClips(RECORDING), 2);

      const next = yield* store.nextPendingClip;
      assert.deepStrictEqual(
        next,
        Option.some({
          id: first,
          recordingId: RECORDING,
          objectPath: clip().objectPath,
          attempts: 0,
        }),
      );

      yield* store.clipTranscribed(first, minute(4), "Hello there", "whisper");

      const afterFirst = yield* store.nextPendingClip;
      assert.strictEqual(Option.getOrThrow(afterFirst).id, second);
      assert.isNull(Option.getOrThrow(afterFirst).objectPath);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("writes a clip only once when the same one is added again", () =>
    Effect.gen(function* () {
      const store = yield* started;

      const first = yield* store.addClip(clip());
      const again = yield* store.addClip(clip({ bytes: 999 }));

      assert.strictEqual(again, first);
      assert.strictEqual(yield* store.outstandingClips(RECORDING), 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "keeps a failed clip pending until the attempts run out, or right away when told to",
    () =>
      Effect.gen(function* () {
        const store = yield* started;
        const sql = yield* SqlClient.SqlClient;

        const retried = yield* store.addClip(clip());
        const hopeless = yield* store.addClip(clip({ startedAt: minute(2) }));

        for (let attempt = 1; attempt < MAX_TRANSCRIPTION_ATTEMPTS; attempt += 1) {
          yield* store.clipFailed(retried, `attempt ${attempt}`, false);
        }

        const [stillPending] =
          yield* sql`SELECT transcription, attempts, last_error FROM office.recording_clips WHERE id = ${retried}`;

        assert.deepStrictEqual(stillPending, {
          transcription: "pending",
          attempts: MAX_TRANSCRIPTION_ATTEMPTS - 1,
          lastError: "attempt 9",
        });

        yield* store.clipFailed(retried, "last straw", false);
        yield* store.clipFailed(hopeless, "no audio", true);

        const rows =
          yield* sql`SELECT transcription, attempts FROM office.recording_clips ORDER BY id`;

        assert.deepStrictEqual(rows, [
          { transcription: "failed", attempts: MAX_TRANSCRIPTION_ATTEMPTS },
          { transcription: "failed", attempts: 1 },
        ]);
        assert.strictEqual(yield* store.outstandingClips(RECORDING), 0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reads the clips of a recording in order with office names", () =>
    Effect.gen(function* () {
      const store = yield* started;
      const sql = yield* SqlClient.SqlClient;

      const later = yield* store.addClip(clip({ startedAt: minute(3) }));

      const earlier = yield* store.addClip(
        clip({ userId: "u1", displayName: "Ada", startedAt: minute(1) }),
      );

      yield* store.clipTranscribed(later, minute(4), "Second", "whisper");
      yield* store.clipTranscribed(earlier, minute(4), "First", "whisper");
      yield* sql`UPDATE office.members SET real_name = 'Grace Hopper' WHERE user_id = 'u2'`;

      const lines = yield* store.clipsOf(RECORDING);
      assert.deepStrictEqual(
        Array.map(lines, ({ who, transcript, transcription }) => ({
          who,
          transcript,
          transcription,
        })),
        [
          { who: "Ada", transcript: "First", transcription: "done" },
          { who: "Grace Hopper", transcript: "Second", transcription: "done" },
        ],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("describes a stopped recording and stores how it was finished", () =>
    Effect.gen(function* () {
      const store = yield* started;
      const sql = yield* SqlClient.SqlClient;

      assert.deepStrictEqual(yield* store.recordingDetails(RECORDING), Option.none());

      yield* store.stopRecording(RECORDING, minute(30), "requested", "u1");

      const details = yield* store.recordingDetails(RECORDING);
      assert.deepStrictEqual(
        details,
        Option.some({
          id: RECORDING,
          guildId: "g1",
          channelId: "office",
          startedAt: minute(0),
          stoppedAt: minute(30),
          startedByName: "Ada",
          stopReason: "requested",
        }),
      );

      yield* store.finishRecording(RECORDING, {
        transcript: "10:00 Ada: Hello",
        summary: "• Ada said hello",
        summaryModel: "model",
        slackChannelId: "C1",
        slackTs: "1.2",
        slackPermalink: "https://office.slack.com/archives/C1/p12",
        finishedAt: minute(31),
      });

      const [row] =
        yield* sql`SELECT transcript, summary, summary_model, slack_channel_id, slack_ts, slack_permalink FROM office.recordings`;

      assert.deepStrictEqual(row, {
        transcript: "10:00 Ada: Hello",
        summary: "• Ada said hello",
        summaryModel: "model",
        slackChannelId: "C1",
        slackTs: "1.2",
        slackPermalink: "https://office.slack.com/archives/C1/p12",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "lists the posted recordings without a link to their summary until they're linked",
    () =>
      Effect.gen(function* () {
        const store = yield* started;

        yield* store.stopRecording(RECORDING, minute(30), "requested", "u1");

        assert.deepStrictEqual(yield* store.unlinkedPosts, []);

        yield* store.finishRecording(RECORDING, {
          transcript: "10:00 Ada: Hello",
          summary: null,
          summaryModel: null,
          slackChannelId: "C1",
          slackTs: "1.2",
          slackPermalink: null,
          finishedAt: minute(31),
        });

        assert.deepStrictEqual(yield* store.unlinkedPosts, [
          { id: RECORDING, slackChannelId: "C1", slackTs: "1.2" },
        ]);

        yield* store.linkPost(RECORDING, "https://office.slack.com/archives/C1/p12");
        yield* store.linkPost(RECORDING, "https://office.slack.com/archives/C1/other");

        assert.deepStrictEqual(yield* store.unlinkedPosts, []);

        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql`SELECT slack_permalink FROM office.recordings`;

        assert.deepStrictEqual(row, { slackPermalink: "https://office.slack.com/archives/C1/p12" });
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records nothing and says so when there's no database", () =>
    Effect.gen(function* () {
      const store = yield* RecordingStore;

      const error = yield* store.activeRecording.pipe(Effect.flip);
      assert.strictEqual(error.reason, "Nothing is recorded");
    }).pipe(Effect.provide(RecordingStore.layerDisabled)),
  );
});
