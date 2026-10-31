import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, type Cause, DateTime, Effect, Layer, Option, Queue, Ref } from "effect";
import { SqlClient } from "effect/sql";
import type { ActiveRecording } from "recording-requests/RecordingRequest";

import { Capture } from "../../src/recording/Capture.ts";
import { ClipArchive } from "../../src/recording/ClipArchive.ts";
import type { Clip } from "../../src/recording/audio/ClipCutter.ts";
import { columnNaming, Database } from "../../src/database/Database.ts";
import { DiscordGateway } from "../../src/office/DiscordGateway.ts";
import { OfficeSeat, type RecordingMode } from "../../src/office/OfficeSeat.ts";
import { RecordingStore } from "../../src/recording/RecordingStore.ts";
import type { Transcription } from "../../src/recording/Transcription.ts";
import { type CaptureError, Heard, VoiceCapture } from "../../src/recording/audio/VoiceCapture.ts";
import { pollUntil, withEnv } from "../fakes.ts";

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const OFFICE = { guildId: "guild", channelId: "office" };

const celt20ms = new Uint8Array([0b1111_1100, 1, 2, 3]);

const clip = (seconds: number): Clip => ({
  userId: "u1",
  startedAt: DateTime.nowUnsafe(),
  packets: Array.makeBy(Math.round(seconds * 50), () => celt20ms),
});

const recording: ActiveRecording = {
  id: RECORDING,
  startedAt: DateTime.makeUnsafe(0),
  startedBy: "u1",
  pause: Option.none(),
};

const setUp = Effect.gen(function* () {
  const heard = yield* Queue.unbounded<Heard, Cause.Done | CaptureError>();
  const modes = yield* Queue.unbounded<RecordingMode>();
  const updates = yield* Queue.unbounded<never, Cause.Done>();
  const queued = yield* Ref.make<ReadonlyArray<readonly [number, boolean]>>([]);
  const changes = yield* Ref.make(0);

  const layer = Layer.mergeAll(
    RecordingStore.layer,
    ClipArchive.layerDisabled,
    VoiceCapture.layerTest(heard),
    DiscordGateway.layerTest({ updates }),
    Layer.succeed(
      OfficeSeat,
      OfficeSeat.of({
        want: () => Effect.void,
        record: (mode) => Queue.offer(modes, mode).pipe(Effect.asVoid),
      }),
    ),
  ).pipe(
    Layer.provideMerge(Database.layerNoDeps()),
    Layer.provideMerge(PgliteClient.layer(columnNaming)),
  );

  const context = yield* Layer.build(layer).pipe(
    withEnv({ DISCORD_BOT_TOKEN: "discord-token", DISCORD_OFFICE_CHANNEL_ID: OFFICE.channelId }),
  );

  yield* Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* RecordingStore;

    yield* database.ready;
    yield* store.startRecording({
      ...recording,
      ...OFFICE,
      startedByName: "Ada",
      title: null,
      agenda: null,
      summaryStyle: "brief",
    });
  }).pipe(Effect.provideContext(context));

  const transcription: Transcription = {
    queue: (clipId, unarchived) =>
      Ref.update(queued, (all) => [...all, [clipId, Option.isSome(unarchived)] as const]),
    run: Effect.never,
  };

  const capture = yield* Capture.make(
    OFFICE,
    transcription,
    Ref.update(changes, (count) => count + 1),
  ).pipe(Effect.provideContext(context));

  const clips = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly transcription: string }>`
      SELECT transcription FROM office.recording_clips ORDER BY id
    `,
  ).pipe(Effect.provideContext(context));

  return {
    capture,
    clips,
    hear: (event: Heard) => Queue.offer(heard, event),
    modes: Queue.clear(modes),
    queued: Ref.get(queued),
    changes: Ref.get(changes),
  };
});

describe("Capture", () => {
  it.effect("saves each clip it hears and hands it to transcription with its audio", () =>
    Effect.gen(function* () {
      const { capture, clips, hear, queued } = yield* setUp;

      yield* capture.begin(recording);
      yield* hear(Heard.Spoke({ clip: clip(2) }));

      const rows = yield* pollUntil(clips, (all) => all.length === 1);

      assert.deepStrictEqual(rows, [{ transcription: "pending" }]);
      assert.deepStrictEqual(
        Array.map(yield* queued, ([, kept]) => kept),
        [true],
      );
    }),
  );

  it.effect("keeps a clip too short to transcribe without queueing it", () =>
    Effect.gen(function* () {
      const { capture, clips, hear, queued } = yield* setUp;

      yield* capture.begin(recording);
      yield* hear(Heard.Spoke({ clip: clip(0.2) }));

      assert.deepStrictEqual(yield* pollUntil(clips, (all) => all.length === 1), [
        { transcription: "skipped" },
      ]);
      assert.deepStrictEqual(yield* queued, []);
    }),
  );

  it.effect("keeps the clip still being saved when the recording ends", () =>
    Effect.gen(function* () {
      const { capture, clips, hear } = yield* setUp;

      yield* capture.begin(recording);
      yield* hear(Heard.Spoke({ clip: clip(2) }));

      const ended = yield* capture.end;

      assert.deepStrictEqual(
        Option.map(ended, ({ id }) => id),
        Option.some(RECORDING),
      );
      assert.strictEqual((yield* clips).length, 1);
    }),
  );

  it.effect("tells the bot to listen, go quiet while paused and stop at the end", () =>
    Effect.gen(function* () {
      const { capture, modes } = yield* setUp;

      yield* capture.begin(recording);
      yield* capture.hold(recording);
      yield* capture.end;

      assert.deepStrictEqual(yield* modes, ["Capturing", "Paused", "Off"]);
      assert.isTrue(Option.isNone(yield* capture.current));
    }),
  );

  it.effect("knows who is speaking, and forgets them once capture stops", () =>
    Effect.gen(function* () {
      const { capture, hear, changes } = yield* setUp;

      yield* capture.begin(recording);
      yield* hear(Heard.StartedSpeaking({ userId: "u1" }));

      assert.deepStrictEqual(
        [...(yield* pollUntil(capture.speaking, (who) => who.size > 0))],
        ["u1"],
      );

      yield* capture.end;

      assert.strictEqual((yield* capture.speaking).size, 0);
      assert.isAbove(yield* changes, 1);
    }),
  );
});
