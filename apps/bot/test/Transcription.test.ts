import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";

import { ArchiveError, ClipArchive } from "../src/ClipArchive.ts";
import { columnNaming, Database } from "../src/Database.ts";
import { RecordingStore } from "../src/RecordingStore.ts";
import { Transcriber } from "../src/Transcriber.ts";
import { Transcription } from "../src/Transcription.ts";
import { pollUntil } from "./fakes.ts";

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const ARCHIVED = "recordings/clip.ogg";

const minute = (n: number) => DateTime.makeUnsafe(n * 60_000);

const setUp = Effect.fnUntraced(function* (archived: ReadonlyMap<string, Uint8Array> = new Map()) {
  const heard = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);

  const layer = Layer.mergeAll(
    RecordingStore.layer,
    Layer.succeed(
      Transcriber,
      Transcriber.of({
        transcribe: (audio) =>
          Ref.update(heard, (all) => [...all, [...audio]]).pipe(
            Effect.as({ text: "hello there", model: "whisper" }),
          ),
      }),
    ),
    Layer.succeed(
      ClipArchive,
      ClipArchive.of({
        bucket: Option.some("clips"),
        upload: () => Effect.void,
        download: (path) =>
          Effect.fromOption(Option.fromUndefinedOr(archived.get(path))).pipe(
            Effect.mapError(() => ArchiveError.make({ reason: "Not in the archive" })),
          ),
      }),
    ),
  ).pipe(
    Layer.provideMerge(Database.layerNoDeps()),
    Layer.provideMerge(PgliteClient.layer(columnNaming)),
  );

  const context = yield* Layer.build(layer);

  const addClip = (objectPath: string | null) =>
    Effect.gen(function* () {
      const database = yield* Database;
      const store = yield* RecordingStore;

      yield* database.ready;
      yield* store.startRecording({
        id: RECORDING,
        guildId: "g1",
        channelId: "office",
        startedAt: minute(0),
        startedBy: "u1",
        startedByName: "Ada",
        title: null,
        agenda: null,
        summaryStyle: "brief",
      });

      return yield* store.addClip({
        recordingId: RECORDING,
        userId: "u1",
        displayName: "Ada",
        startedAt: minute(1),
        durationMs: 2000,
        bytes: 3,
        objectPath,
        transcription: "pending",
      });
    }).pipe(Effect.provideContext(context));

  const clips = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{
        readonly transcription: string;
        readonly transcript: string | null;
      }>`SELECT transcription, transcript FROM office.recording_clips ORDER BY id`,
  ).pipe(Effect.provideContext(context));

  const transcription = yield* Transcription.make.pipe(Effect.provideContext(context));

  yield* Effect.forkChild(transcription.run);

  return { transcription, addClip, clips, heard: Ref.get(heard) };
});

describe("Transcription", () => {
  it.effect("transcribes a clip it was handed the audio for", () =>
    Effect.gen(function* () {
      const { transcription, addClip, clips, heard } = yield* setUp();

      const clipId = yield* addClip(null);

      yield* transcription.queue(clipId, Option.some(new Uint8Array([1, 2, 3])));

      const [row] = yield* pollUntil(clips, (rows) => rows[0]?.transcription === "done");

      assert.strictEqual(row?.transcript, "hello there");
      assert.deepStrictEqual(yield* heard, [[1, 2, 3]]);
    }),
  );

  it.effect("fetches an archived clip's audio from the archive", () =>
    Effect.gen(function* () {
      const { transcription, addClip, clips, heard } = yield* setUp(
        new Map([[ARCHIVED, new Uint8Array([4, 5])]]),
      );

      const clipId = yield* addClip(ARCHIVED);

      yield* transcription.queue(clipId, Option.none());
      yield* pollUntil(clips, (rows) => rows[0]?.transcription === "done");

      assert.deepStrictEqual(yield* heard, [[4, 5]]);
    }),
  );

  it.effect("gives up on a clip whose audio was neither archived nor kept", () =>
    Effect.gen(function* () {
      const { transcription, addClip, clips, heard } = yield* setUp();

      const clipId = yield* addClip(null);

      yield* transcription.queue(clipId, Option.none());
      yield* pollUntil(clips, (rows) => rows[0]?.transcription === "failed");

      assert.deepStrictEqual(yield* heard, []);
    }),
  );
});
