import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Fiber, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { ActionItemWriter } from "../src/ActionItems.ts";
import { columnNaming, Database } from "../src/Database.ts";
import { FINISH_RETRY, Publication } from "../src/Publication.ts";
import { type NewClip, RecordingStore, StoreUnavailable } from "../src/RecordingStore.ts";
import { SummaryWriter } from "../src/SummaryWriter.ts";
import { makeFakeSlackClient, makeFakeSlackHistory, permalinkOf, pollUntil } from "./fakes.ts";

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const OFFICE = { guildId: "g1", channelId: "office" };

const SLACK_CHANNEL = "C-OFFICE";

const minute = (n: number) => DateTime.makeUnsafe(n * 60_000);

const clip = (transcription: NewClip["transcription"]): NewClip => ({
  recordingId: RECORDING,
  userId: "u1",
  displayName: "Ada",
  startedAt: minute(1),
  durationMs: 2000,
  bytes: 1234,
  objectPath: null,
  transcription,
});

interface Options {
  readonly spoken?: boolean;
  readonly finishFailures?: number;
}

const setUp = Effect.fnUntraced(function* (options: Options = {}) {
  const slack = yield* makeFakeSlackClient();
  const history = yield* makeFakeSlackHistory();
  const finishFailures = yield* Ref.make(options.finishFailures ?? 0);

  const store = Layer.effect(
    RecordingStore,
    Effect.gen(function* () {
      const real = yield* RecordingStore;

      return RecordingStore.of({
        ...real,
        finishRecording: (id, finished) =>
          Ref.modify(finishFailures, (left) => [left > 0, Math.max(0, left - 1)] as const).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(StoreUnavailable.make({ reason: "The database is down" }))
                : real.finishRecording(id, finished),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(RecordingStore.layer));

  const layer = Layer.mergeAll(
    store,
    slack.layer,
    history.layer,
    Layer.succeed(
      SummaryWriter,
      SummaryWriter.of({
        write: (_, style) => Effect.succeedSome({ text: "• They said hello", model: "m", style }),
      }),
    ),
    Layer.succeed(
      ActionItemWriter,
      ActionItemWriter.of({ pull: () => Effect.succeedSome({ value: [], model: "m" }) }),
    ),
  ).pipe(
    Layer.provideMerge(Database.layerNoDeps()),
    Layer.provideMerge(PgliteClient.layer(columnNaming)),
  );

  const context = yield* Layer.build(layer);

  const run = <A, E>(
    effect: Effect.Effect<A, E, RecordingStore | SqlClient.SqlClient | Database>,
  ) => Effect.provideContext(effect, context);

  yield* run(
    Effect.gen(function* () {
      const database = yield* Database;
      const recordings = yield* RecordingStore;

      yield* database.ready;
      yield* recordings.startRecording({
        id: RECORDING,
        ...OFFICE,
        startedAt: minute(0),
        startedBy: "u1",
        startedByName: "Ada",
        title: null,
        agenda: null,
        summaryStyle: "brief",
      });

      const clipId = yield* recordings.addClip(
        clip(options.spoken === false ? "skipped" : "pending"),
      );

      if (options.spoken !== false)
        yield* recordings.clipTranscribed(clipId, minute(2), "hello there", "whisper");

      yield* recordings.stopRecording(RECORDING, minute(30), "requested", "u1");
    }),
  );

  const publication = yield* Publication.make({ office: OFFICE, slackChannel: SLACK_CHANNEL }).pipe(
    Effect.provideContext(context),
  );

  const finished = run(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly finishedAt: Date | null;
          readonly slackPermalink: string | null;
        }>`SELECT finished_at, slack_permalink FROM office.recordings`,
    ),
  );

  return { publication, slack, history, finished, run };
});

describe("Publication", () => {
  it.effect("posts the summary once, with the transcript, and finishes the recording", () =>
    Effect.gen(function* () {
      const { publication, slack, history, finished } = yield* setUp();

      yield* publication.finish(RECORDING);

      const [post] = yield* slack.posts;
      const [row] = yield* finished;

      assert.strictEqual((yield* slack.posts).length, 1);
      assert.strictEqual(post?.channel, SLACK_CHANNEL);
      assert.strictEqual((yield* slack.uploads).length, 1);
      assert.strictEqual((yield* history.posts)[0]?.kind, "Recording");
      assert.isNotNull(row?.finishedAt);
      assert.strictEqual(row?.slackPermalink, permalinkOf(SLACK_CHANNEL, "900.0"));
    }),
  );

  it.effect("finishes a recording where nobody spoke without posting anything", () =>
    Effect.gen(function* () {
      const { publication, slack, finished } = yield* setUp({ spoken: false });

      yield* publication.finish(RECORDING);

      assert.deepStrictEqual(yield* slack.posts, []);
      assert.isNotNull((yield* finished)[0]?.finishedAt);
    }),
  );

  it.effect("posts once when finishing fails after the post went out", () =>
    Effect.gen(function* () {
      const { publication, slack, finished } = yield* setUp({ finishFailures: 1 });

      const finishing = yield* Effect.forkChild(publication.finish(RECORDING));

      yield* TestClock.adjust(FINISH_RETRY);
      yield* Fiber.join(finishing);

      assert.strictEqual((yield* slack.posts).length, 1);
      assert.strictEqual((yield* slack.uploads).length, 1);
      assert.isNotNull((yield* finished)[0]?.finishedAt);
    }),
  );

  it.effect("edits the posted summary when the recording changes", () =>
    Effect.gen(function* () {
      const { publication, slack, run } = yield* setUp();

      yield* publication.finish(RECORDING);
      yield* run(
        Effect.flatMap(RecordingStore, (store) =>
          store.applyEdit(RECORDING, { kind: "title", title: "Standup" }),
        ),
      );
      yield* publication.refresh(RECORDING);

      const [update] = yield* slack.updates;

      assert.strictEqual(update?.ts, "900.0");
      assert.include(update?.message.text ?? "", "Standup");
    }),
  );

  it.effect("finishes what was left unfinished before a restart when catching up", () =>
    Effect.gen(function* () {
      const { publication, slack, finished } = yield* setUp();

      yield* publication.catchUp;
      yield* pollUntil(finished, (rows) => rows[0]?.finishedAt !== null);

      assert.strictEqual((yield* slack.posts).length, 1);
    }),
  );

  it.effect("doesn't post again for a recording that already finished", () =>
    Effect.gen(function* () {
      const { publication, slack } = yield* setUp();

      yield* publication.finish(RECORDING);
      yield* publication.catchUp;
      yield* TestClock.adjust("1 millis");

      assert.strictEqual((yield* slack.posts).length, 1);
      assert.strictEqual((yield* slack.updates).length, 0);
    }),
  );

  it.effect("leaves a missing recording alone", () =>
    Effect.gen(function* () {
      const { publication, slack } = yield* setUp();

      yield* publication.finish("00000000-0000-4000-8000-000000000000");

      assert.deepStrictEqual(yield* slack.posts, []);
    }),
  );
});
