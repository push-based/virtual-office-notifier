import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  type Cause,
  Deferred,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  String,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, type SqlError } from "effect/sql";
import { TestClock } from "effect/testing";
import { NO_PLAN, type RecordingPlan, type SummaryStyle } from "recording-requests/Recording";
import { RECORDING_LIMIT, type RequestAction } from "recording-requests/RecordingRequest";
import { RecordingEdits } from "recording-requests/RecordingEdits";
import type { RecordingChange } from "recording-requests/RecordingEdit";
import { RecordingRequests } from "recording-requests/RecordingRequests";

import { ActionItemWriter, type PulledItem } from "../src/ActionItems.ts";
import type { Written } from "../src/AiWriting.ts";
import { ClipArchive } from "../src/ClipArchive.ts";
import type { Clip } from "../src/ClipCutter.ts";
import { columnNaming, Database, reconnectDelay } from "../src/Database.ts";
import { DiscordGateway, type RecordingMode } from "../src/DiscordGateway.ts";
import { NO_VOICE_DETAILS, type VoiceStateUpdate } from "../src/OfficeEvent.ts";
import { FINISH_POLL, POLL_INTERVAL, startRecorder, STATUS_INTERVAL } from "../src/Recorder.ts";
import { RecordingStore, type StoreUnavailable } from "../src/RecordingStore.ts";
import { InvalidPayload } from "../src/SlackClient.ts";
import { SummaryWriter, type WrittenSummary } from "../src/SummaryWriter.ts";
import { type Transcript, Transcriber, TranscriptionError } from "../src/Transcriber.ts";
import { SPEAKING_HOLD } from "../src/Speaking.ts";
import { type CaptureError, Heard, VoiceCapture } from "../src/VoiceCapture.ts";
import {
  captureReports,
  type FakeSlackClientOptions,
  makeFakeSlackClient,
  makeFakeSlackHistory,
  permalinkOf,
  pollUntil,
  SLACK_ENV,
  withEnv,
} from "./fakes.ts";

const OFFICE = "office";

const SETTLE_TURNS = 200;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  packets: Array.makeBy(seconds * 50, () => celt20ms),
});

interface HarnessOptions {
  readonly present?: ReadonlyArray<VoiceStateUpdate>;
  readonly transcribe?: (audio: Uint8Array) => Effect.Effect<Transcript, TranscriptionError>;
  readonly summary?: Option.Option<Omit<WrittenSummary, "style">>;
  readonly actionItems?: Option.Option<Written<ReadonlyArray<PulledItem>>>;
  readonly before?: Effect.Effect<
    void,
    StoreUnavailable | SqlError.SqlError,
    RecordingStore | SqlClient.SqlClient
  >;
  readonly slack?: FakeSlackClientOptions;
}

const transcribeAll = () => Effect.succeed({ text: "hello world", model: "whisper" });

// Runs the recorder against an in-process Postgres, a scripted office and
// fake clips, Slack and AI, and waits for the real database work between steps.
const makeHarness = Effect.fnUntraced(function* (options: HarnessOptions = {}) {
  const present = options.present ?? [];
  const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
  const heard = yield* Queue.unbounded<Heard, Cause.Done | CaptureError>();
  const recordings = yield* Queue.unbounded<RecordingMode>();
  const slack = yield* makeFakeSlackClient(options.slack);
  const history = yield* makeFakeSlackHistory();
  const summaryRequests = yield* Ref.make<ReadonlyArray<string>>([]);
  const summaryStyles = yield* Ref.make<ReadonlyArray<SummaryStyle>>([]);
  const whileSummarizing = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const actionItemRequests = yield* Ref.make<ReadonlyArray<string>>([]);

  const nextActionItems = yield* Ref.make(
    options.actionItems ?? Option.some({ value: [], model: "m" }),
  );

  const nextSummary = yield* Ref.make(
    options.summary ?? Option.some({ text: "• They said hello", model: "m" }),
  );

  const transcriber = Layer.succeed(
    Transcriber,
    Transcriber.of({ transcribe: options.transcribe ?? transcribeAll }),
  );

  const summaries = Layer.succeed(
    SummaryWriter,
    SummaryWriter.of({
      write: (request, style) =>
        Ref.update(summaryRequests, (all) => [...all, request]).pipe(
          Effect.andThen(Ref.update(summaryStyles, (all) => [...all, style])),
          Effect.andThen(Effect.flatten(Ref.get(whileSummarizing))),
          Effect.andThen(Ref.get(nextSummary)),
          Effect.map(Option.map((written) => ({ ...written, style }))),
        ),
    }),
  );

  const actionItemWriter = Layer.succeed(
    ActionItemWriter,
    ActionItemWriter.of({
      pull: (request) =>
        Ref.update(actionItemRequests, (all) => [...all, request]).pipe(
          Effect.andThen(Ref.get(nextActionItems)),
        ),
    }),
  );

  const layer = Layer.mergeAll(
    VoiceCapture.layerTest(heard),
    ClipArchive.layerDisabled,
    transcriber,
    summaries,
    actionItemWriter,
    slack.layer,
    history.layer,
    SecureRandom.layerWebCrypto,
  ).pipe(
    Layer.provideMerge(
      DiscordGateway.layerTest({
        updates,
        present,
        occupants: new Set(Array.map(present, (member) => member.userId)),
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
    Layer.provideMerge(
      Layer.effect(
        RecordingEdits,
        Effect.gen(function* () {
          const database = yield* Database;

          return yield* RecordingEdits.make(database.ready);
        }),
      ),
    ),
    Layer.provideMerge(Database.layerNoDeps()),
    Layer.provideMerge(PgliteClient.layer(columnNaming)),
  );

  const context = yield* Layer.build(layer).pipe(withEnv(env));
  const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provideContext(context));
  const database = yield* Effect.service(Database).pipe(Effect.provideContext(context));
  const requests = yield* Effect.service(RecordingRequests).pipe(Effect.provideContext(context));
  const edits = yield* Effect.service(RecordingEdits).pipe(Effect.provideContext(context));

  yield* database.ready;
  yield* (options.before ?? Effect.void).pipe(Effect.orDie, Effect.provideContext(context));

  const fiber = yield* startRecorder.pipe(Effect.provideContext(context), withEnv(env));

  const request = (requestedBy: string, action: RequestAction, plan: RecordingPlan = NO_PLAN) =>
    requests
      .submit({ id: requestedBy, name: String.toUpperCase(requestedBy) }, action, plan)
      .pipe(Effect.asVoid);

  const edit = (editedBy: string, recordingId: string, change: RecordingChange) =>
    edits
      .submit({ id: editedBy, name: String.toUpperCase(editedBy) }, recordingId, change)
      .pipe(Effect.asVoid);

  const recordingRows = sql<{
    readonly id: string;
    readonly stoppedAt: Date | null;
    readonly stopReason: string | null;
    readonly stoppedBy: string | null;
    readonly finishedAt: Date | null;
    readonly summary: string | null;
    readonly transcript: string | null;
    readonly slackPermalink: string | null;
    readonly title: string | null;
    readonly agenda: string | null;
  }>`SELECT id, stopped_at, stop_reason, stopped_by, finished_at, summary, transcript, slack_permalink, title, agenda FROM office.recordings ORDER BY started_at`;

  const editRows = sql<{
    readonly editedBy: string;
    readonly kind: string;
    readonly change: unknown;
    readonly outcome: string | null;
    readonly reason: string | null;
    readonly handledAt: Date | null;
  }>`SELECT edited_by, kind, change, outcome, reason, handled_at FROM office.recording_edits ORDER BY id`;

  const actionItemRows = sql<{
    readonly text: string;
    readonly owner: string | null;
    readonly done: boolean;
  }>`SELECT text, owner, done FROM office.recording_action_items ORDER BY position`;

  const currentActionItems = sql<{
    readonly text: string;
    readonly done: boolean;
  }>`
    SELECT text, done FROM office.recording_action_items WHERE replaced_at IS NULL ORDER BY position
  `;

  const replacedActionItems = sql<{ readonly text: string }>`
    SELECT text FROM office.recording_action_items WHERE replaced_at IS NOT NULL ORDER BY position
  `;

  const actionItemIds = sql<{
    readonly id: number;
  }>`SELECT id::int AS id FROM office.recording_action_items ORDER BY position`;

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

  const pauseRows = sql<{ readonly pausedAt: Date | null; readonly pausedBy: string | null }>`
    SELECT paused_at, paused_by FROM office.recordings ORDER BY started_at
  `;

  const summaryRows = sql<{
    readonly style: string;
    readonly summary: string;
    readonly model: string;
    readonly editId: string | null;
  }>`SELECT style, summary, model, edit_id::text FROM office.recording_summaries ORDER BY id`;

  const styleRows = sql<{
    readonly summaryStyle: string;
    readonly summaryWrittenStyle: string | null;
    readonly rewriting: boolean;
  }>`
    SELECT summary_style, summary_written_style, summary_rewrite_edit_id IS NOT NULL AS rewriting
    FROM office.recordings ORDER BY started_at
  `;

  const editIds = sql<{ readonly id: string }>`
    SELECT id::text FROM office.recording_edits ORDER BY id
  `;

  const statusRows = sql<{
    readonly recordingId: string | null;
    readonly botInOffice: boolean;
    readonly occupants: ReadonlyArray<{ readonly userId: string; readonly speaking: boolean }>;
  }>`
    SELECT recording_id, bot_in_office, occupants FROM office.recording_status
  `;

  return {
    fiber,
    sql,
    request,
    edit,
    eventually: pollUntil,
    recordingRows,
    editRows,
    actionItemRows,
    actionItemIds,
    currentActionItems,
    replacedActionItems,
    clipRows,
    requestRows,
    eventRows,
    pauseRows,
    statusRows,
    summaryRows,
    styleRows,
    editIds,
    offer: (update: VoiceStateUpdate) => Queue.offer(updates, update),
    speak: (spoken: Clip) => Queue.offer(heard, Heard.Spoke({ clip: spoken })),
    hear: (event: Heard) => Queue.offer(heard, event),
    settle: Effect.repeat(Effect.yieldNow, { times: SETTLE_TURNS }),
    tick: TestClock.adjust(POLL_INTERVAL),
    recordings: Queue.clear(recordings),
    posts: slack.posts,
    uploads: slack.uploads,
    updates: slack.updates,
    recordedPosts: history.posts,
    summaryRequests: Ref.get(summaryRequests),
    actionItemRequests: Ref.get(actionItemRequests),
    summaryStyles: Ref.get(summaryStyles),
    whileSummarizing: (effect: Effect.Effect<void>) => Ref.set(whileSummarizing, effect),
    summarizeAs: (next: Option.Option<Omit<WrittenSummary, "style">>) => Ref.set(nextSummary, next),
    pullAs: (next: Option.Option<Written<ReadonlyArray<PulledItem>>>) =>
      Ref.set(nextActionItems, next),
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

const finishedRecording = (h: Harness, plan: RecordingPlan = NO_PLAN) =>
  Effect.gen(function* () {
    yield* h.request("u1", "start", plan);
    yield* h.tick;
    yield* recordingStarted(h);
    yield* h.speak(clip("u1", 2));
    yield* h.eventually(h.clipRows, (rows) => rows[0]?.transcription === "done");
    yield* h.request("u1", "stop");
    yield* h.tick;
    yield* recordingStopped(h);
    yield* TestClock.adjust(FINISH_POLL);

    const [recording] = yield* recordingFinished(h);

    return recording?.id ?? "";
  });

const allHandled = (h: Harness) =>
  h.eventually(h.editRows, (rows) => Array.every(rows, (row) => row.handledAt !== null));

describe("Recorder", () => {
  it.effect(
    "records, transcribes and posts a summary with the transcript when asked to start and stop",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* h.request("u1", "start");
        yield* h.tick;
        yield* recordingStarted(h);

        assert.deepStrictEqual(yield* h.recordings, ["Capturing"]);

        yield* h.speak(clip("u1", 2));
        yield* h.eventually(h.clipRows, (rows) => rows[0]?.transcription === "done");

        yield* h.request("u1", "stop");
        yield* h.tick;
        yield* recordingStopped(h);

        assert.deepStrictEqual(yield* h.recordings, ["Off"]);

        yield* TestClock.adjust(FINISH_POLL);

        const [recording] = yield* recordingFinished(h);
        assert.strictEqual(recording?.stopReason, "requested");
        assert.strictEqual(recording?.stoppedBy, "u1");
        assert.strictEqual(recording?.summary, "• They said hello");
        assert.include(recording?.transcript, "Ada: hello world");
        assert.strictEqual(
          recording?.slackPermalink,
          permalinkOf(SLACK_ENV.SLACK_CHANNEL_ID, "900.0"),
        );

        const [post] = yield* h.posts;
        assert.strictEqual(post?.channel, SLACK_ENV.SLACK_CHANNEL_ID);
        assert.include(yield* encodeJson(post?.blocks), "• They said hello");

        const [upload] = yield* h.uploads;
        assert.strictEqual(upload?.threadTs, "900.0");
        assert.include(new TextDecoder().decode(upload?.content), "Ada: hello world");

        const [recorded] = yield* h.recordedPosts;
        assert.strictEqual(recorded?.kind, "Recording");
        assert.strictEqual(recorded?.model, "m");

        assert.deepStrictEqual(
          Array.map(yield* h.requestRows, ({ outcome }) => outcome),
          ["started", "stopped"],
        );
        assert.deepStrictEqual(
          Array.map(yield* h.eventRows, ({ event }) => event),
          ["started", "stopped"],
        );
      }),
  );

  it.effect("still finishes the recording when Slack won't give a link to the summary", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        present: [ada],
        slack: { permalinkFailure: InvalidPayload.make({ error: "message_not_found" }) },
      });

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);
      yield* h.speak(clip("u1", 2));
      yield* h.eventually(h.clipRows, (rows) => rows[0]?.transcription === "done");
      yield* h.request("u1", "stop");
      yield* h.tick;
      yield* recordingStopped(h);
      yield* TestClock.adjust(FINISH_POLL);

      const [recording] = yield* recordingFinished(h);
      assert.strictEqual(recording?.summary, "• They said hello");
      assert.isNull(recording?.slackPermalink);
      assert.strictEqual((yield* h.posts).length, 1);
    }),
  );

  it.effect("links recordings posted before it stored links, once, at startup", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        before: Effect.gen(function* () {
          const store = yield* RecordingStore;
          const now = yield* DateTime.now;

          yield* store.startRecording({
            id: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
            guildId: "guild",
            channelId: OFFICE,
            startedAt: now,
            startedBy: "u1",
            startedByName: "Ada",
            title: null,
            agenda: null,
            summaryStyle: "brief",
          });
          yield* store.stopRecording(
            "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
            now,
            "requested",
            "u1",
          );
          yield* store.finishRecording("6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10", {
            transcript: "12:00 Ada: hello",
            writtenWith: { summaryStyle: "brief", agenda: null },
            summary: "• Ada said hello",
            summaryModel: "m",
            slackChannelId: "C1",
            slackTs: "123.456",
            slackPermalink: null,
            finishedAt: now,
          });
        }),
      });

      const [recording] = yield* h.eventually(
        h.recordingRows,
        (rows) => rows[0]?.slackPermalink !== null,
      );

      assert.strictEqual(recording?.slackPermalink, permalinkOf("C1", "123.456"));
      assert.deepStrictEqual(yield* h.posts, []);
    }),
  );

  it.effect("carries on when it can't link earlier recordings", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        present: [ada],
        slack: { permalinkFailure: InvalidPayload.make({ error: "channel_not_found" }) },
        before: Effect.gen(function* () {
          const store = yield* RecordingStore;
          const now = yield* DateTime.now;

          yield* store.startRecording({
            id: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
            guildId: "guild",
            channelId: OFFICE,
            startedAt: now,
            startedBy: "u1",
            startedByName: "Ada",
            title: null,
            agenda: null,
            summaryStyle: "brief",
          });
          yield* store.stopRecording(
            "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
            now,
            "requested",
            "u1",
          );
          yield* store.finishRecording("6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10", {
            transcript: "12:00 Ada: hello",
            writtenWith: { summaryStyle: "brief", agenda: null },
            summary: null,
            summaryModel: null,
            slackChannelId: "C1",
            slackTs: "123.456",
            slackPermalink: null,
            finishedAt: now,
          });
        }),
      });

      yield* h.request("u1", "start");
      yield* h.tick;

      const rows = yield* h.eventually(h.recordingRows, (found) => found.length === 2);
      assert.strictEqual(rows.length, 2);
      assert.isNull(rows[0]?.slackPermalink);
    }),
  );

  it.effect("ignores requests from people who aren't in the office, and says why", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u9", "start");
      yield* h.request("u1", "stop");
      yield* h.tick;

      const requests = yield* h.eventually(h.requestRows, (rows) =>
        Array.every(rows, (row) => row.outcome !== null),
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
      assert.deepStrictEqual(yield* h.actionItemRequests, []);
      assert.deepStrictEqual(yield* h.recordings, ["Capturing", "Off"]);
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
            title: null,
            agenda: null,
            summaryStyle: "brief",
          });
        }),
      });

      yield* h.eventually(h.eventRows, (rows) =>
        Array.some(rows, (row) => row.event === "resumed"),
      );
      assert.deepStrictEqual(yield* h.recordings, ["Capturing"]);

      yield* h.tick;

      const [recording] = yield* recordingStopped(h);
      assert.strictEqual(recording?.stopReason, "time_limit");
      assert.deepStrictEqual(yield* h.recordings, ["Off"]);
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
            title: null,
            agenda: null,
            summaryStyle: "brief",
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
          Effect.fail(TranscriptionError.make({ failure: "DailyLimit", detail: "used up" })),
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

  it.effect("retries a clip with backoff while the transcriber can't be reached", () =>
    Effect.gen(function* () {
      const outages = yield* Ref.make(2);

      const h = yield* makeHarness({
        present: [ada],
        transcribe: () =>
          Ref.getAndUpdate(outages, (left) => left - 1).pipe(
            Effect.flatMap((left) =>
              left > 0
                ? Effect.fail(TranscriptionError.make({ failure: "Unavailable", detail: "down" }))
                : Effect.succeed({ text: "hello world", model: "whisper" }),
            ),
          ),
      });

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);
      yield* h.speak(clip("u1", 2));
      yield* h.eventually(h.clipRows, (rows) => rows.length === 1);

      yield* TestClock.adjust(reconnectDelay(1));
      assert.strictEqual((yield* h.clipRows)[0]?.transcription, "pending");

      yield* TestClock.adjust(reconnectDelay(2));
      yield* h.eventually(h.clipRows, (rows) => rows[0]?.transcription === "done");
      assert.strictEqual(yield* Ref.get(outages), -1);
    }),
  );

  it.effect(
    "pauses, deafening the bot and capturing nothing, then resumes and marks the pause in the transcript",
    () =>
      Effect.gen(function* () {
        const grace = update({ userId: "u2", displayName: "Grace" });
        const h = yield* makeHarness({ present: [ada, grace] });

        yield* h.request("u1", "start");
        yield* h.tick;
        yield* recordingStarted(h);
        yield* h.speak({ ...clip("u1", 2), startedAt: yield* DateTime.now });
        yield* h.eventually(h.clipRows, (rows) => rows[0]?.transcription === "done");
        assert.deepStrictEqual(yield* h.recordings, ["Capturing"]);

        yield* TestClock.adjust("1 minute");
        yield* h.request("u2", "pause");
        yield* h.tick;
        yield* h.eventually(h.pauseRows, (rows) => rows[0]?.pausedBy === "u2");
        assert.deepStrictEqual(yield* h.recordings, ["Paused"]);

        yield* h.request("u1", "pause");
        yield* TestClock.adjust("5 minutes");
        yield* h.request("u1", "resume");
        yield* h.tick;
        yield* h.eventually(h.pauseRows, (rows) => rows[0]?.pausedBy === null);
        assert.deepStrictEqual(yield* h.recordings, ["Capturing"]);

        yield* h.speak({ ...clip("u2", 2), startedAt: yield* DateTime.now });
        yield* h.eventually(h.clipRows, (rows) => rows[1]?.transcription === "done");

        yield* h.request("u2", "stop");
        yield* h.tick;
        yield* recordingStopped(h);
        yield* TestClock.adjust(FINISH_POLL);

        const [recording] = yield* recordingFinished(h);
        const lines = String.split(recording?.transcript ?? "", "\n");
        assert.match(lines[2] ?? "", /^02:00 \S+: hello world$/);
        assert.match(lines[3] ?? "", /^02:01–02:06 Paused by \S+$/);
        assert.match(lines[4] ?? "", /^02:06 \S+: hello world$/);

        assert.deepStrictEqual(yield* h.requestRows, [
          { outcome: "started", reason: null },
          { outcome: "paused", reason: null },
          { outcome: "ignored", reason: "already_paused" },
          { outcome: "resumed", reason: null },
          { outcome: "stopped", reason: null },
        ]);
        assert.deepStrictEqual(yield* h.eventRows, [
          { event: "started", reason: null },
          { event: "paused", reason: null },
          { event: "resumed", reason: "requested" },
          { event: "stopped", reason: "requested" },
        ]);
      }),
  );

  it.effect("stops a paused recording when the office empties", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);
      yield* h.request("u1", "pause");
      yield* h.tick;
      yield* h.eventually(h.pauseRows, (rows) => rows[0]?.pausedBy === "u1");

      yield* h.offer(leave());

      const [recording] = yield* recordingStopped(h);
      assert.strictEqual(recording?.stopReason, "office_emptied");
      assert.deepStrictEqual(yield* h.recordings, ["Capturing", "Paused", "Off"]);
    }),
  );

  it.effect("stops a paused recording at the time limit, since pauses count towards it", () =>
    Effect.gen(function* () {
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
            title: null,
            agenda: null,
            summaryStyle: "brief",
          });
          yield* store.pauseRecording("6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10", now, "u1", "Ada");
        }),
      });

      yield* h.eventually(h.eventRows, (rows) =>
        Array.some(rows, (row) => row.event === "resumed"),
      );
      yield* h.tick;

      const [recording] = yield* recordingStopped(h);
      assert.strictEqual(recording?.stopReason, "time_limit");
    }),
  );

  it.effect(
    "comes back paused after a restart, deafened and capturing nothing until someone resumes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          present: [ada],
          before: Effect.gen(function* () {
            const store = yield* RecordingStore;
            const now = yield* DateTime.now;

            yield* store.startRecording({
              id: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
              guildId: "guild",
              channelId: OFFICE,
              startedAt: now,
              startedBy: "u1",
              startedByName: "Ada",
              title: null,
              agenda: null,
              summaryStyle: "brief",
            });
            yield* store.pauseRecording("6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10", now, "u1", "Ada");
          }),
        });

        yield* h.eventually(h.eventRows, (rows) =>
          Array.some(rows, (row) => row.event === "resumed"),
        );
        assert.deepStrictEqual(yield* h.recordings, ["Paused"]);
        assert.deepStrictEqual(yield* h.eventRows, [
          { event: "started", reason: null },
          { event: "paused", reason: null },
          { event: "resumed", reason: "bot_restarted" },
        ]);
        assert.strictEqual((yield* h.pauseRows)[0]?.pausedBy, "u1");

        yield* h.request("u1", "resume");
        yield* h.tick;
        yield* h.eventually(h.pauseRows, (rows) => rows[0]?.pausedBy === null);
        assert.deepStrictEqual(yield* h.recordings, ["Capturing"]);
      }),
  );

  it.effect(
    "names a recording from the Start request, tells the summary model what it was meant to cover, and heads the Slack post with the title",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* finishedRecording(h, { title: "Deploy retro", agenda: "What broke on Friday" });

        const [recording] = yield* h.recordingRows;
        assert.strictEqual(recording?.title, "Deploy retro");
        assert.strictEqual(recording?.agenda, "What broke on Friday");

        const [summaryRequest] = yield* h.summaryRequests;
        assert.match(
          summaryRequest ?? "",
          /^Title: Deploy retro\nAgenda, what people meant to cover, not what happened:\nWhat broke on Friday\n\nTranscript:\nOffice recording from /,
        );

        const [post] = yield* h.posts;
        assert.strictEqual(post?.text, "📝 Deploy retro, under a minute");
        assert.include(yield* encodeJson(post?.blocks), "📝 *Deploy retro* · <!date^");
      }),
  );

  it.effect("gives the summary model only the transcript when nobody named the recording", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* finishedRecording(h);

      const [summaryRequest] = yield* h.summaryRequests;
      assert.match(summaryRequest ?? "", /^Office recording from /);
      assert.strictEqual((yield* h.posts)[0]?.text, "📝 Office recording, under a minute");
    }),
  );

  it.effect(
    "applies title and agenda edits from anyone on its next check, and keeps every edit on record",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* h.request("u1", "start");
        yield* h.tick;

        const [running] = yield* recordingStarted(h);
        const id = running?.id ?? "";

        yield* h.edit("u2", id, { kind: "title", title: "Planning" });
        yield* h.edit("u3", id, { kind: "agenda", agenda: "Next sprint" });
        yield* h.edit("u2", id, { kind: "title", title: "Sprint planning" });

        assert.deepStrictEqual(
          Array.map(yield* h.editRows, ({ outcome }) => outcome),
          [null, null, null],
        );

        yield* h.tick;

        const edits = yield* allHandled(h);
        assert.deepStrictEqual(
          Array.map(edits, ({ editedBy, kind, change, outcome }) => ({
            editedBy,
            kind,
            change,
            outcome,
          })),
          [
            {
              editedBy: "u2",
              kind: "title",
              change: { kind: "title", title: "Planning" },
              outcome: "applied",
            },
            {
              editedBy: "u3",
              kind: "agenda",
              change: { kind: "agenda", agenda: "Next sprint" },
              outcome: "applied",
            },
            {
              editedBy: "u2",
              kind: "title",
              change: { kind: "title", title: "Sprint planning" },
              outcome: "applied",
            },
          ],
        );

        const [recording] = yield* h.recordingRows;
        assert.strictEqual(recording?.title, "Sprint planning");
        assert.strictEqual(recording?.agenda, "Next sprint");
        assert.deepStrictEqual(yield* h.updates, []);
      }),
  );

  it.effect(
    "edits the Slack post's heading when the title changes after it's posted, and brings back the default when it's cleared",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });
        const id = yield* finishedRecording(h);

        yield* h.edit("u2", id, { kind: "title", title: "Deploy retro" });
        yield* h.tick;

        const [renamed] = yield* h.eventually(h.updates, (all) => all.length === 1);
        assert.strictEqual(renamed?.channel, SLACK_ENV.SLACK_CHANNEL_ID);
        assert.strictEqual(renamed?.ts, "900.0");
        assert.strictEqual(renamed?.message.text, "📝 Deploy retro, under a minute");

        const card = yield* encodeJson(renamed?.message.blocks);
        assert.include(card, "📝 *Deploy retro* · <!date^");
        assert.include(card, "• They said hello");
        assert.include(card, "✨ Brief summary by m");

        yield* h.edit("u2", id, { kind: "title", title: null });
        yield* h.tick;

        const updates = yield* h.eventually(h.updates, (all) => all.length === 2);
        assert.strictEqual(updates[1]?.message.text, "📝 Office recording, under a minute");
        assert.strictEqual((yield* h.posts).length, 1);
        assert.lengthOf(yield* h.summaryRequests, 1);
      }),
  );

  it.effect(
    "retitles the Slack post when the title changes while the summary is being written",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* h.whileSummarizing(
          h.sql`UPDATE office.recordings SET title = 'Named late'`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        );
        yield* finishedRecording(h);

        assert.strictEqual((yield* h.posts)[0]?.text, "📝 Office recording, under a minute");

        const [renamed] = yield* h.eventually(h.updates, (all) => all.length === 1);
        assert.strictEqual(renamed?.message.text, "📝 Named late, under a minute");
      }),
  );

  it.effect("keeps a title edit when Slack won't take the new heading", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        present: [ada],
        slack: { updateFailure: InvalidPayload.make({ error: "message_not_found" }) },
      });

      const id = yield* finishedRecording(h);

      yield* h.edit("u2", id, { kind: "title", title: "Deploy retro" });
      yield* h.tick;

      const [edit] = yield* allHandled(h);
      assert.strictEqual(edit?.outcome, "applied");
      assert.strictEqual((yield* h.recordingRows)[0]?.title, "Deploy retro");
    }),
  );

  it.effect("ignores edits of a silent recording, and says why", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u1", "start");
      yield* h.tick;

      const [running] = yield* recordingStarted(h);

      yield* h.request("u1", "stop");
      yield* h.tick;
      yield* recordingFinished(h);

      yield* h.edit("u2", running?.id ?? "", { kind: "title", title: "Lunch" });
      yield* h.tick;

      const [edit] = yield* allHandled(h);
      assert.strictEqual(edit?.outcome, "ignored");
      assert.strictEqual(edit?.reason, "silent");
      assert.isNull((yield* h.recordingRows)[0]?.title);
      assert.deepStrictEqual(yield* h.posts, []);
    }),
  );

  it.effect(
    "pulls out the action items on their own, gives each one an owner from the office or none, and lists them below the summary in Slack",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          present: [ada],
          actionItems: Option.some({
            value: [
              { text: "write up the deploy checklist", ownerName: "ada" },
              { text: "ask IT about the VPN", ownerName: null },
              { text: "book the room for Thursday", ownerName: "Bob" },
            ],
            model: "m",
          }),
        });

        yield* finishedRecording(h, { title: "Deploy retro", agenda: null });

        const [request] = yield* h.actionItemRequests;
        assert.match(
          request ?? "",
          /^People in the office:\nAda\n\nTitle: Deploy retro\n\nTranscript:\nOffice recording from /,
        );

        assert.deepStrictEqual(yield* h.actionItemRows, [
          { text: "write up the deploy checklist", owner: "u1", done: false },
          { text: "ask IT about the VPN", owner: null, done: false },
          { text: "book the room for Thursday", owner: null, done: false },
        ]);

        const [post] = yield* h.posts;
        const card = yield* encodeJson(post?.blocks);
        assert.include(
          card,
          "*Action items*\\n• Ada: write up the deploy checklist\\n• Unassigned: ask IT about the VPN\\n• Unassigned: book the room for Thursday",
        );
        assert.match(card, /• They said hello.*\*Action items\*/);
        assert.deepStrictEqual(yield* h.updates, []);
      }),
  );

  it.effect("says no action items could be pulled out when no model answers", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada], actionItems: Option.none() });

      yield* finishedRecording(h);

      assert.deepStrictEqual(yield* h.actionItemRows, []);
      assert.include(
        yield* encodeJson((yield* h.posts)[0]?.blocks),
        "*Action items*\\nNo action items could be pulled out",
      );
    }),
  );

  it.effect(
    "writes the summary in the style chosen with the Start request, keeps it on record, and names the style in the post",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* finishedRecording(h, { title: null, agenda: null, summaryStyle: "detailed" });

        assert.deepStrictEqual(yield* h.summaryStyles, ["detailed"]);
        assert.include(yield* encodeJson((yield* h.posts)[0]?.blocks), "✨ Detailed summary by m");
        assert.deepStrictEqual(yield* h.styleRows, [
          { summaryStyle: "detailed", summaryWrittenStyle: "detailed", rewriting: false },
        ]);
        assert.deepStrictEqual(yield* h.summaryRows, [
          { style: "detailed", summary: "• They said hello", model: "m", editId: null },
        ]);
      }),
  );

  it.effect(
    "only decides how the summary will be written when the style changes while recording",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* h.request("u1", "start");
        yield* h.tick;

        const [running] = yield* recordingStarted(h);

        yield* h.edit("u2", running?.id ?? "", { kind: "summary_style", style: "decisions" });
        yield* h.tick;
        yield* allHandled(h);

        yield* h.speak(clip("u1", 2));
        yield* h.eventually(h.clipRows, (rows) => rows[0]?.transcription === "done");
        yield* h.request("u1", "stop");
        yield* h.tick;
        yield* recordingStopped(h);
        yield* TestClock.adjust(FINISH_POLL);
        yield* recordingFinished(h);
        yield* h.settle;

        assert.deepStrictEqual(yield* h.summaryStyles, ["decisions"]);
        assert.include(
          yield* encodeJson((yield* h.posts)[0]?.blocks),
          "✨ Decisions &amp; actions summary by m",
        );
        assert.deepStrictEqual(yield* h.updates, []);
        assert.lengthOf(yield* h.summaryRows, 1);
      }),
  );

  it.effect(
    "rewrites a finished recording's summary in its new style, edits the Slack post and says so in the thread",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });
        const id = yield* finishedRecording(h);

        yield* h.summarizeAs(Option.some({ text: "• Hello\n• Then more", model: "m2" }));
        yield* h.edit("u2", id, { kind: "summary_style", style: "detailed" });
        yield* h.tick;

        const [updated] = yield* h.eventually(h.updates, (all) => all.length === 1);
        assert.strictEqual(updated?.ts, "900.0");

        const card = yield* encodeJson(updated?.message.blocks);
        assert.include(card, "• Hello\\n• Then more");
        assert.include(card, "✨ Detailed summary by m2");

        const posts = yield* h.eventually(h.posts, (all) => all.length === 2);
        assert.strictEqual(posts[1]?.threadTs, "900.0");
        assert.strictEqual(posts[1]?.text, "✨ Summary rewritten as Detailed by U2");

        const [edit] = yield* h.editIds;
        assert.deepStrictEqual(yield* h.summaryRows, [
          { style: "brief", summary: "• They said hello", model: "m", editId: null },
          {
            style: "detailed",
            summary: "• Hello\n• Then more",
            model: "m2",
            editId: edit?.id ?? "",
          },
        ]);
        assert.deepStrictEqual(yield* h.styleRows, [
          { summaryStyle: "detailed", summaryWrittenStyle: "detailed", rewriting: false },
        ]);
        assert.strictEqual((yield* h.recordingRows)[0]?.summary, "• Hello\n• Then more");
        assert.deepStrictEqual(yield* h.summaryStyles, ["brief", "detailed"]);
      }),
  );

  it.effect(
    "rewrites the summary in the same style on Rewrite summary, and with the new agenda when it changes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });
        const id = yield* finishedRecording(h);

        yield* h.edit("u2", id, { kind: "rewrite_summary" });
        yield* h.tick;

        const posts = yield* h.eventually(h.posts, (all) => all.length === 2);
        assert.strictEqual(posts[1]?.text, "✨ Summary rewritten by U2");

        yield* h.edit("u3", id, { kind: "agenda", agenda: "Friday's outage" });
        yield* h.tick;

        const more = yield* h.eventually(h.posts, (all) => all.length === 3);
        assert.strictEqual(more[2]?.text, "✨ Summary rewritten by U3");
        assert.deepStrictEqual(yield* h.summaryStyles, ["brief", "brief", "brief"]);
        assert.include((yield* h.summaryRequests)[2] ?? "", "Friday's outage");
        assert.lengthOf(yield* h.summaryRows, 3);
        assert.lengthOf(yield* h.updates, 2);
      }),
  );

  it.effect(
    "writes one more summary with the latest settings for all the edits made during a rewrite",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });
        const id = yield* finishedRecording(h);
        const release = yield* Deferred.make<void>();

        yield* h.whileSummarizing(Deferred.await(release));
        yield* h.edit("u2", id, { kind: "summary_style", style: "detailed" });
        yield* h.tick;
        yield* h.eventually(h.summaryRequests, (all) => all.length === 2);

        yield* h.edit("u2", id, { kind: "agenda", agenda: "Friday's outage" });
        yield* h.edit("u3", id, { kind: "summary_style", style: "decisions" });
        yield* h.tick;
        yield* allHandled(h);

        assert.deepStrictEqual(yield* h.styleRows, [
          { summaryStyle: "decisions", summaryWrittenStyle: "brief", rewriting: true },
        ]);

        yield* h.whileSummarizing(Effect.void);
        yield* Deferred.succeed(release, undefined);

        const posts = yield* h.eventually(h.posts, (all) => all.length === 3);
        yield* h.settle;

        assert.deepStrictEqual(yield* h.summaryStyles, ["brief", "detailed", "decisions"]);
        assert.include((yield* h.summaryRequests)[2] ?? "", "Friday's outage");
        assert.deepStrictEqual(
          Array.map(posts, ({ text }) => text),
          [
            "📝 Office recording, under a minute",
            "✨ Summary rewritten as Detailed by U2",
            "✨ Summary rewritten as Decisions &amp; actions by U3",
          ],
        );

        const edits = yield* h.editIds;
        assert.deepStrictEqual(
          Array.map(yield* h.summaryRows, ({ editId }) => editId),
          [null, edits[0]?.id ?? "", edits[2]?.id ?? ""],
        );
        assert.deepStrictEqual(yield* h.styleRows, [
          { summaryStyle: "decisions", summaryWrittenStyle: "decisions", rewriting: false },
        ]);
      }),
  );

  it.effect("keeps the summary as it was when no model can rewrite it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });
      const id = yield* finishedRecording(h);

      yield* h.summarizeAs(Option.none());
      yield* h.edit("u2", id, { kind: "summary_style", style: "detailed" });
      yield* h.tick;

      yield* h.eventually(h.styleRows, (rows) => rows[0]?.rewriting === false);
      yield* h.settle;

      assert.lengthOf(yield* h.summaryRequests, 2);
      assert.deepStrictEqual(yield* h.styleRows, [
        { summaryStyle: "detailed", summaryWrittenStyle: "brief", rewriting: false },
      ]);
      assert.strictEqual((yield* h.recordingRows)[0]?.summary, "• They said hello");
      assert.lengthOf(yield* h.summaryRows, 1);
      assert.deepStrictEqual(yield* h.updates, []);
      assert.lengthOf(yield* h.posts, 1);
    }),
  );

  it.effect("writes the summary on Rewrite summary when no model could write it at first", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada], summary: Option.none() });
      const id = yield* finishedRecording(h);

      assert.include(
        yield* encodeJson((yield* h.posts)[0]?.blocks),
        "No AI model could write a summary",
      );
      assert.deepStrictEqual(yield* h.summaryRows, []);

      yield* h.summarizeAs(Option.some({ text: "• At last", model: "m" }));
      yield* h.edit("u2", id, { kind: "rewrite_summary" });
      yield* h.tick;

      const posts = yield* h.eventually(h.posts, (all) => all.length === 2);
      assert.strictEqual(posts[1]?.text, "✨ Summary rewritten by U2");

      const [updated] = yield* h.updates;
      const card = yield* encodeJson(updated?.message.blocks);
      assert.include(card, "• At last");
      assert.include(card, "✨ Brief summary by m");
      assert.lengthOf(yield* h.summaryRows, 1);
    }),
  );

  it.effect("ignores Rewrite summary before the summary is written, and says why", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u1", "start");
      yield* h.tick;

      const [running] = yield* recordingStarted(h);

      yield* h.edit("u2", running?.id ?? "", { kind: "rewrite_summary" });
      yield* h.tick;

      const [edit] = yield* allHandled(h);
      assert.strictEqual(edit?.outcome, "ignored");
      assert.strictEqual(edit?.reason, "unfinished");
      assert.deepStrictEqual(yield* h.summaryRequests, []);
    }),
  );

  it.effect(
    "ticks, unticks and reassigns action items through recording edits, and edits the Slack post with no thread note",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          present: [ada],
          actionItems: Option.some({
            value: [
              { text: "write up the deploy checklist", ownerName: "Ada" },
              { text: "ask IT about the VPN", ownerName: null },
            ],
            model: "m",
          }),
        });

        const id = yield* finishedRecording(h);

        yield* h.sql`
          INSERT INTO office.members (user_id, display_name, first_seen_at, last_seen_at)
          VALUES ('u2', 'Grace', now(), now())
        `;

        const [checklist, vpn] = Array.map(yield* h.actionItemIds, (row) => row.id);

        yield* h.edit("u2", id, { kind: "tick", item: checklist ?? 0 });
        yield* h.tick;

        const [ticked] = yield* h.eventually(h.updates, (all) => all.length === 1);
        assert.include(
          yield* encodeJson(ticked?.message.blocks),
          "*Action items*\\n~• Ada: write up the deploy checklist~ ✅\\n• Unassigned: ask IT about the VPN",
        );

        yield* h.edit("u3", id, { kind: "reassign", item: vpn ?? 0, owner: "u2" });
        yield* h.tick;
        yield* h.eventually(h.updates, (all) => all.length === 2);

        yield* h.edit("u3", id, { kind: "untick", item: checklist ?? 0 });
        yield* h.tick;

        const updates = yield* h.eventually(h.updates, (all) => all.length === 3);
        assert.include(
          yield* encodeJson(updates[2]?.message.blocks),
          "*Action items*\\n• Ada: write up the deploy checklist\\n• Grace: ask IT about the VPN",
        );

        assert.deepStrictEqual(yield* h.actionItemRows, [
          { text: "write up the deploy checklist", owner: "u1", done: false },
          { text: "ask IT about the VPN", owner: "u2", done: false },
        ]);
        assert.deepStrictEqual(
          Array.map(yield* allHandled(h), ({ editedBy, kind, outcome }) => [
            editedBy,
            kind,
            outcome,
          ]),
          [
            ["u2", "tick", "applied"],
            ["u3", "reassign", "applied"],
            ["u3", "untick", "applied"],
          ],
        );
        assert.strictEqual((yield* h.posts).length, 1);
        assert.strictEqual((yield* h.uploads).length, 1);
      }),
  );

  it.effect(
    "pulls the action items out again on a rewrite, retiring the old ones, while nobody has touched them",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          present: [ada],
          actionItems: Option.some({
            value: [{ text: "write up the deploy checklist", ownerName: "Ada" }],
            model: "m",
          }),
        });

        const id = yield* finishedRecording(h);

        yield* h.pullAs(
          Option.some({ value: [{ text: "book the room", ownerName: null }], model: "m" }),
        );
        yield* h.edit("u2", id, { kind: "rewrite_summary" });
        yield* h.tick;

        yield* h.eventually(h.posts, (all) => all.length === 2);

        assert.lengthOf(yield* h.actionItemRequests, 2);
        assert.deepStrictEqual(yield* h.currentActionItems, [
          { text: "book the room", done: false },
        ]);
        assert.deepStrictEqual(yield* h.replacedActionItems, [
          { text: "write up the deploy checklist" },
        ]);
        assert.include(
          yield* encodeJson((yield* h.updates)[0]?.message.blocks),
          "*Action items*\\n• Unassigned: book the room",
        );
      }),
  );

  it.effect("keeps the action items as they are on a rewrite once someone has ticked one", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        present: [ada],
        actionItems: Option.some({
          value: [{ text: "write up the deploy checklist", ownerName: "Ada" }],
          model: "m",
        }),
      });

      const id = yield* finishedRecording(h);
      const [checklist] = Array.map(yield* h.actionItemIds, (row) => row.id);

      yield* h.edit("u2", id, { kind: "tick", item: checklist ?? 0 });
      yield* h.tick;
      yield* h.eventually(h.updates, (all) => all.length === 1);

      yield* h.pullAs(
        Option.some({ value: [{ text: "book the room", ownerName: null }], model: "m" }),
      );
      yield* h.edit("u2", id, { kind: "summary_style", style: "detailed" });
      yield* h.tick;

      yield* h.eventually(h.posts, (all) => all.length === 2);

      assert.lengthOf(yield* h.actionItemRequests, 1);
      assert.deepStrictEqual(yield* h.currentActionItems, [
        { text: "write up the deploy checklist", done: true },
      ]);
      assert.deepStrictEqual(yield* h.replacedActionItems, []);
    }),
  );

  it.effect(
    "rewrites the summary once it's posted when the style changed while it was being written",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        yield* h.whileSummarizing(
          Effect.gen(function* () {
            yield* h.sql`UPDATE office.recordings SET summary_style = 'detailed'`;
            yield* h.sql`
              INSERT INTO office.recording_edits
                (recording_id, edited_by, edited_by_name, kind, change, handled_at, outcome)
              SELECT id, 'u2', 'Ben', 'summary_style', '{"kind":"summary_style","style":"detailed"}'::jsonb,
                     now(), 'applied'
              FROM office.recordings
            `;
            yield* h.whileSummarizing(Effect.void);
          }).pipe(Effect.orDie),
        );
        yield* finishedRecording(h);

        const posts = yield* h.eventually(h.posts, (all) => all.length === 2);
        assert.strictEqual(posts[1]?.text, "✨ Summary rewritten as Detailed by Ben");
        assert.deepStrictEqual(yield* h.summaryStyles, ["brief", "detailed"]);
        assert.include(
          yield* encodeJson((yield* h.updates)[0]?.message.blocks),
          "✨ Detailed summary by m",
        );
      }),
  );

  it.effect("picks up a rewrite that was waiting before a restart", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        before: Effect.gen(function* () {
          const store = yield* RecordingStore;
          const sql = yield* SqlClient.SqlClient;
          const now = yield* DateTime.now;
          const id = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

          yield* store.startRecording({
            id,
            guildId: "guild",
            channelId: OFFICE,
            startedAt: now,
            startedBy: "u1",
            startedByName: "Ada",
            title: null,
            agenda: null,
            summaryStyle: "brief",
          });
          yield* store.stopRecording(id, now, "requested", "u1");
          yield* store.finishRecording(id, {
            transcript: "12:00 Ada: hello",
            writtenWith: { summaryStyle: "brief", agenda: null },
            summary: "• Ada said hello",
            summaryModel: "m",
            slackChannelId: "C1",
            slackTs: "123.456",
            slackPermalink: "https://office.slack.com/archives/C1/p123456",
            finishedAt: now,
          });

          const [edit] = yield* sql<{ readonly id: string }>`
            INSERT INTO office.recording_edits
              (recording_id, edited_by, edited_by_name, kind, change, handled_at, outcome)
            VALUES (${id}, 'u2', 'Ben', 'rewrite_summary', '{"kind":"rewrite_summary"}'::jsonb, now(), 'applied')
            RETURNING id::text
          `;

          assert.isTrue(yield* store.requestRewrite(id, Number(edit?.id)));
        }),
      });

      const posts = yield* h.eventually(h.posts, (all) => all.length === 1);
      assert.strictEqual(posts[0]?.threadTs, "123.456");
      assert.strictEqual(posts[0]?.text, "✨ Summary rewritten by Ben");
      assert.deepStrictEqual(yield* h.styleRows, [
        { summaryStyle: "brief", summaryWrittenStyle: "brief", rewriting: false },
      ]);
    }),
  );

  it.effect("keeps the status row current for the Activity", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      const [before] = yield* h.eventually(h.statusRows, (rows) => rows[0]?.botInOffice === true);
      assert.isDefined(before);
      assert.deepStrictEqual(
        Array.map(before.occupants, ({ userId }) => userId),
        ["u1"],
      );
      assert.isNull(before.recordingId);

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

      assert.isDefined(withGrace);
      assert.deepStrictEqual(
        Array.map(withGrace.occupants, ({ userId }) => userId),
        ["u1", "u2"],
      );

      yield* Fiber.interrupt(h.fiber);
    }),
  );

  it.effect(
    "shows who the bot hears speaking until the hold runs out, writing at most once a second",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ present: [ada] });

        const adaSpeaks = (
          rows: ReadonlyArray<{
            readonly occupants: ReadonlyArray<{ readonly speaking: boolean }>;
          }>,
        ) => rows[0]?.occupants[0]?.speaking === true;

        yield* h.request("u1", "start");
        yield* h.tick;
        yield* recordingStarted(h);

        yield* h.hear(Heard.StartedSpeaking({ userId: "u1" }));
        yield* h.settle;
        assert.isFalse(adaSpeaks(yield* h.statusRows));

        yield* TestClock.adjust(STATUS_INTERVAL);
        assert.isTrue(adaSpeaks(yield* h.eventually(h.statusRows, adaSpeaks)));

        yield* h.hear(Heard.StoppedSpeaking({ userId: "u1" }));
        yield* h.settle;
        yield* TestClock.adjust(STATUS_INTERVAL);
        yield* h.settle;
        assert.isTrue(adaSpeaks(yield* h.statusRows));

        yield* TestClock.adjust(Duration.subtract(SPEAKING_HOLD, STATUS_INTERVAL));
        assert.isFalse(adaSpeaks(yield* h.eventually(h.statusRows, (rows) => !adaSpeaks(rows))));

        yield* Fiber.interrupt(h.fiber);
      }),
  );

  it.effect("shows nobody speaking while the recording is paused", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);
      yield* h.hear(Heard.StartedSpeaking({ userId: "u1" }));
      yield* h.settle;
      yield* TestClock.adjust(STATUS_INTERVAL);
      yield* h.eventually(h.statusRows, (rows) => rows[0]?.occupants[0]?.speaking === true);

      yield* h.request("u1", "pause");
      yield* h.tick;
      yield* h.eventually(h.pauseRows, (rows) => rows[0]?.pausedBy === "u1");
      yield* TestClock.adjust(STATUS_INTERVAL);

      const [paused] = yield* h.eventually(
        h.statusRows,
        (rows) => rows[0]?.occupants[0]?.speaking === false,
      );

      assert.isNotNull(paused?.recordingId);
      assert.isFalse(paused?.occupants[0]?.speaking);

      yield* Fiber.interrupt(h.fiber);
    }),
  );

  it.effect("shows nobody speaking once the recording stops", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      yield* h.request("u1", "start");
      yield* h.tick;
      yield* recordingStarted(h);
      yield* h.hear(Heard.StartedSpeaking({ userId: "u1" }));
      yield* h.settle;
      yield* TestClock.adjust(STATUS_INTERVAL);
      yield* h.eventually(h.statusRows, (rows) => rows[0]?.occupants[0]?.speaking === true);

      yield* h.request("u1", "stop");
      yield* h.tick;
      yield* recordingStopped(h);
      yield* TestClock.adjust(STATUS_INTERVAL);

      const [after] = yield* h.eventually(
        h.statusRows,
        (rows) => rows[0]?.recordingId === null && rows[0]?.occupants[0]?.speaking === false,
      );

      assert.isNull(after?.recordingId);
      assert.isFalse(after?.occupants[0]?.speaking);

      yield* Fiber.interrupt(h.fiber);
    }),
  );
  it.effect("reports a request it can't read once, and again only after it recovered", () => {
    const { reports, layer } = captureReports();

    return Effect.gen(function* () {
      const h = yield* makeHarness({ present: [ada] });

      const reported = (count: number) =>
        h.eventually(
          Effect.sync(() => reports),
          (found) => found.length >= count,
        );

      const unreadableRequest = h.sql`
        INSERT INTO office.recording_requests (requested_by, requested_by_name, action)
        VALUES ('u1', 'Ada', 'dance')
      `;

      yield* h.sql`
        ALTER TABLE office.recording_requests DROP CONSTRAINT recording_requests_action_check
      `;
      yield* unreadableRequest;
      yield* h.tick;
      yield* reported(1);
      yield* h.tick;
      yield* h.settle;
      yield* h.tick;
      yield* h.settle;

      assert.deepStrictEqual(
        Array.map(reports, ({ name, severity }) => ({ name, severity })),
        [{ name: "RecordingUnavailable", severity: "Error" }],
      );

      yield* h.sql`DELETE FROM office.recording_requests`;
      yield* h.tick;
      yield* h.settle;
      yield* unreadableRequest;
      yield* h.tick;
      yield* reported(2);

      assert.strictEqual(reports.length, 2);
    }).pipe(Effect.provide(layer));
  });
});
