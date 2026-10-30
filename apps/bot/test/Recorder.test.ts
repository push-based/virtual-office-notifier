import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { type Cause, DateTime, Effect, Fiber, Layer, Option, Queue } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { RECORDING_LIMIT } from "recording-requests/RecordingRequest";
import { RecordingRequests } from "recording-requests/RecordingRequests";

import { ClipArchive } from "../src/ClipArchive.ts";
import { columnNaming, Database } from "../src/Database.ts";
import { DiscordGateway } from "../src/DiscordGateway.ts";
import { NO_VOICE_DETAILS, type VoiceStateUpdate } from "../src/OfficeEvent.ts";
import { FINISH_POLL, POLL_INTERVAL, Recorder } from "../src/Recorder.ts";
import { RecordingStore, type StoreUnavailable } from "../src/RecordingStore.ts";
import { SummaryWriter, type WrittenSummary } from "../src/SummaryWriter.ts";
import { type Transcript, Transcriber, TranscriptionError } from "../src/Transcriber.ts";
import { type CaptureError, type Clip, VoiceCapture } from "../src/VoiceCapture.ts";
import { makeFakeSlackClient, makeFakeSlackHistory, SLACK_ENV, withEnv } from "./fakes.ts";

const OFFICE = "office";

const env = {
  DISCORD_BOT_TOKEN: "discord-token",
  DISCORD_OFFICE_CHANNEL_ID: OFFICE,
  ...SLACK_ENV,
};

const update = (overrides: Partial<VoiceStateUpdate> = {}): VoiceStateUpdate => ({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  guildId: "guild",
  oldChannelId: null,
  newChannelId: OFFICE,
  isBot: false,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  ...overrides,
});

const ada = update();

const leave = (overrides: Partial<VoiceStateUpdate> = {}) =>
  update({ oldChannelId: OFFICE, newChannelId: null, ...overrides });

const celt20ms = new Uint8Array([0b1111_1100, 1, 2, 3]);

const clip = (userId: string, seconds: number): Clip => ({
  userId,
  startedAt: DateTime.nowUnsafe(),
  packets: Array.from({ length: seconds * 50 }, () => celt20ms),
});

interface HarnessOptions {
  readonly present?: ReadonlyArray<VoiceStateUpdate>;
  readonly transcribe?: (audio: Uint8Array) => Effect.Effect<Transcript, TranscriptionError>;
  readonly summary?: Option.Option<WrittenSummary>;
  readonly before?: Effect.Effect<void, StoreUnavailable, RecordingStore>;
}

const transcribeAll = () => Effect.succeed({ text: "hello world", model: "whisper" });

// Runs the recorder against an in-process Postgres, a scripted office and
// fake clips, Slack and AI, and waits for the real database work between steps.
const makeHarness = Effect.fnUntraced(function* (options: HarnessOptions = {}) {
  const present = options.present ?? [];
  const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
  const clips = yield* Queue.unbounded<Clip, Cause.Done | CaptureError>();
  const recordings = yield* Queue.unbounded<boolean>();
  const slack = yield* makeFakeSlackClient();
  const history = yield* makeFakeSlackHistory();

  const transcriber = Layer.succeed(
    Transcriber,
    Transcriber.of({ transcribe: options.transcribe ?? transcribeAll }),
  );

  const summaries = Layer.succeed(
    SummaryWriter,
    SummaryWriter.of({
      write: () =>
        Effect.succeed(options.summary ?? Option.some({ text: "• They said hello", model: "m" })),
    }),
  );

  const layer = Recorder.layer.pipe(
    Layer.provide([
      VoiceCapture.layerTest(clips),
      ClipArchive.layerDisabled,
      transcriber,
      summaries,
      slack.layer,
      history.layer,
    ]),
    Layer.provideMerge(
      DiscordGateway.layerTest({
        updates,
        present,
        occupants: new Set(present.map((member) => member.userId)),
        recordings,
      }),
    ),
    Layer.provideMerge(RecordingStore.layer),
    Layer.provideMerge(
      Layer.effect(
        RecordingRequests,
        Effect.gen(function* () {
          const database = yield* Database;

          return yield* RecordingRequests.make(database.ready);
        }),
      ),
    ),
    Layer.provideMerge(Database.layerNoDeps()),
    Layer.provideMerge(PgliteClient.layer(columnNaming)),
  );

  const context = yield* Layer.build(layer).pipe(withEnv(env));
  const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provideContext(context));
  const database = yield* Effect.service(Database).pipe(Effect.provideContext(context));
  const recorder = yield* Effect.service(Recorder).pipe(Effect.provideContext(context));
  const requests = yield* Effect.service(RecordingRequests).pipe(Effect.provideContext(context));

  yield* database.ready;
  yield* (options.before ?? Effect.void).pipe(Effect.orDie, Effect.provideContext(context));

  const fiber = yield* recorder.run.pipe(withEnv(env), Effect.forkScoped);

  const request = (requestedBy: string, action: "start" | "stop") =>
    requests
      .submit({ id: requestedBy, name: requestedBy.toUpperCase() }, action)
      .pipe(Effect.asVoid);

  const realSleep = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

  const eventually = <A>(
    query: Effect.Effect<ReadonlyArray<A>, Error>,
    matches: (rows: ReadonlyArray<A>) => boolean,
  ) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const rows = yield* query;

        if (matches(rows)) return rows;

        yield* realSleep;
      }

      return yield* query;
    });

  const recordingRows = sql<{
    readonly id: string;
    readonly stoppedAt: Date | null;
    readonly stopReason: string | null;
    readonly stoppedBy: string | null;
    readonly finishedAt: Date | null;
    readonly summary: string | null;
    readonly transcript: string | null;
  }>`SELECT id, stopped_at, stop_reason, stopped_by, finished_at, summary, transcript FROM office.recordings ORDER BY started_at`;

  const clipRows = sql<{
    readonly userId: string;
    readonly transcription: string;
    readonly transcript: string | null;
  }>`
    SELECT user_id, transcription, transcript FROM office.recording_clips ORDER BY id
  `;

  const requestRows = sql<{ readonly outcome: string | null; readonly reason: string | null }>`
    SELECT outcome, reason FROM office.recording_requests ORDER BY id
  `;

  const eventRows = sql<{ readonly event: string; readonly reason: string | null }>`
    SELECT event, reason FROM office.recording_events ORDER BY id
  `;

  const statusRows = sql<{
    readonly recordingId: string | null;
    readonly botInOffice: boolean;
    readonly occupants: ReadonlyArray<{ readonly userId: string }>;
  }>`
    SELECT recording_id, bot_in_office, occupants FROM office.recording_status
  `;

  return {
    fiber,
    sql,
    request,
    eventually,
    recordingRows,
    clipRows,
    requestRows,
    eventRows,
    statusRows,
    offer: (update: VoiceStateUpdate) => Queue.offer(updates, update),
    speak: (spoken: Clip) => Queue.offer(clips, spoken),
    tick: TestClock.adjust(POLL_INTERVAL),
    recordings: Queue.clear(recordings),
    posts: slack.posts,
    uploads: slack.uploads,
    recordedPosts: history.posts,
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const recordingStarted = (h: Harness) => h.eventually(h.recordingRows, (rows) => rows.length === 1);

const recordingStopped = (h: Harness) =>
  h.eventually(
    h.recordingRows,
    (rows) => rows[0]?.stoppedAt !== null && rows[0]?.stoppedAt !== undefined,
  );

const recordingFinished = (h: Harness) =>
  h.eventually(
    h.recordingRows,
    (rows) => rows[0]?.finishedAt !== null && rows[0]?.finishedAt !== undefined,
  );

describe("Recorder", () => {
  it.effect(
    "records, transcribes and posts a summary with the transcript when asked to start and stop",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* h.request("u1", "start");
        yield* h.tick;
        yield* recordingStarted(h);

        assert.deepStrictEqual(yield* h.recordings, [true]);

        yield* h.speak(clip("u1", 2));
        yield* h.eventually(h.clipRows, (rows) => rows[0]?.transcription === "done");

        yield* h.request("u1", "stop");
        yield* h.tick;
        yield* recordingStopped(h);

        assert.deepStrictEqual(yield* h.recordings, [false]);

        yield* TestClock.adjust(FINISH_POLL);

        const [recording] = yield* recordingFinished(h);
        assert.strictEqual(recording?.stopReason, "requested");
        assert.strictEqual(recording?.stoppedBy, "u1");
        assert.strictEqual(recording?.summary, "• They said hello");
        assert.include(recording?.transcript, "Ada: hello world");

        const [post] = yield* h.posts;
        assert.strictEqual(post?.channel, SLACK_ENV.SLACK_CHANNEL_ID);
        assert.include(JSON.stringify(post?.blocks), "• They said hello");

        const [upload] = yield* h.uploads;
        assert.strictEqual(upload?.threadTs, "900.0");
        assert.include(new TextDecoder().decode(upload?.content), "Ada: hello world");

        const [recorded] = yield* h.recordedPosts;
        assert.strictEqual(recorded?.kind, "Recording");
        assert.strictEqual(recorded?.model, "m");

        assert.deepStrictEqual(
          (yield* h.requestRows).map(({ outcome }) => outcome),
          ["started", "stopped"],
        );
        assert.deepStrictEqual(
          (yield* h.eventRows).map(({ event }) => event),
          ["started", "stopped"],
        );
      }),
  );

  it.effect("ignores requests from people who aren't in the office, and says why", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u9", "start");
      yield* h.request("u1", "stop");
      yield* h.tick;

      const requests = yield* h.eventually(h.requestRows, (rows) =>
        rows.every((row) => row.outcome !== null),
      );

      assert.deepStrictEqual(requests, [
        { outcome: "ignored", reason: "not_in_office" },
        { outcome: "ignored", reason: "not_recording" },
      ]);
      assert.deepStrictEqual(yield* h.recordingRows, []);
      assert.deepStrictEqual(yield* h.recordings, []);
    }),
  );

  it.effect("stops when the office empties, and posts nothing when nobody spoke", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);

      yield* h.speak(clip("u1", 0.2));
      yield* h.eventually(h.clipRows, (rows) => rows.length === 1);
      assert.strictEqual((yield* h.clipRows)[0]?.transcription, "skipped");

      yield* h.offer(leave());

      const [recording] = yield* recordingFinished(h);
      assert.strictEqual(recording?.stopReason, "office_emptied");
      assert.isNull(recording?.summary);
      assert.deepStrictEqual(yield* h.posts, []);
      assert.deepStrictEqual(yield* h.recordings, [true, false]);
    }),
  );

  it.effect("stops at the time limit", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-24T12:00:00Z")));

      const h = yield* makeHarness({
        present: [ada],
        before: Effect.gen(function* () {
          const store = yield* RecordingStore;
          const now = yield* DateTime.now;

          yield* store.startRecording({
            id: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
            guildId: "guild",
            channelId: OFFICE,
            startedAt: DateTime.subtractDuration(
              DateTime.addDuration(now, "1 second"),
              RECORDING_LIMIT,
            ),
            startedBy: "u1",
            startedByName: "Ada",
          });
        }),
      });

      yield* h.eventually(h.eventRows, (rows) => rows.some((row) => row.event === "resumed"));
      assert.deepStrictEqual(yield* h.recordings, [true]);

      yield* h.tick;

      const [recording] = yield* recordingStopped(h);
      assert.strictEqual(recording?.stopReason, "time_limit");
      assert.deepStrictEqual(yield* h.recordings, [false]);
    }),
  );

  it.effect("ends a recording left over from before a restart when the office is empty", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        before: Effect.gen(function* () {
          const store = yield* RecordingStore;

          yield* store.startRecording({
            id: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
            guildId: "guild",
            channelId: OFFICE,
            startedAt: yield* DateTime.now,
            startedBy: "u1",
            startedByName: "Ada",
          });
        }),
      });

      const [recording] = yield* recordingFinished(h);
      assert.strictEqual(recording?.stopReason, "bot_restarted");
      assert.deepStrictEqual(yield* h.recordings, []);
    }),
  );

  it.effect("keeps a clip waiting when the transcriber's daily allocation is used up", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        present: [ada],
        transcribe: () =>
          Effect.fail(new TranscriptionError({ failure: "DailyLimit", detail: "used up" })),
      });

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);
      yield* h.speak(clip("u1", 2));
      yield* h.eventually(h.clipRows, (rows) => rows.length === 1);

      yield* h.request("u1", "stop");
      yield* h.tick;
      yield* recordingStopped(h);
      yield* TestClock.adjust(FINISH_POLL);
      yield* TestClock.adjust(FINISH_POLL);

      const [recording] = yield* h.recordingRows;
      assert.isNull(recording?.finishedAt);
      assert.strictEqual((yield* h.clipRows)[0]?.transcription, "pending");
      assert.deepStrictEqual(yield* h.posts, []);
    }),
  );

  it.effect("keeps the status row current for the Activity", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      const [before] = yield* h.eventually(h.statusRows, (rows) => rows[0]?.botInOffice === true);
      assert.deepStrictEqual(
        before?.occupants.map(({ userId }) => userId),
        ["u1"],
      );
      assert.isNull(before?.recordingId);

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);
      yield* h.tick;

      const [during] = yield* h.eventually(h.statusRows, (rows) => rows[0]?.recordingId !== null);
      assert.isNotNull(during?.recordingId);

      yield* h.offer(update({ userId: "u2", displayName: "Grace" }));
      yield* h.tick;

      const [withGrace] = yield* h.eventually(
        h.statusRows,
        (rows) => (rows[0]?.occupants.length ?? 0) === 2,
      );

      assert.deepStrictEqual(
        withGrace?.occupants.map(({ userId }) => userId),
        ["u1", "u2"],
      );

      yield* Fiber.interrupt(h.fiber);
    }),
  );
});
