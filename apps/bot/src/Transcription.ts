import { Data, DateTime, Duration, Effect, Match, Option, Queue, Schedule } from "effect";

import { ClipArchive } from "./ClipArchive.ts";
import { ClipAudio } from "./ClipAudio.ts";
import { reconnectSchedule } from "./Database.ts";
import { type PendingClip, RecordingStore } from "./RecordingStore.ts";
import { StoreHealth } from "./StoreHealth.ts";
import { Transcriber, type TranscriptionError } from "./Transcriber.ts";

export const TRANSCRIPTION_IDLE = Duration.seconds(30);

export const REJECTED_CLIP_PAUSE = Duration.seconds(5);

const READING_CLIPS = "Couldn't read the clips to transcribe";

export interface Transcription {
  readonly queue: (clipId: number, unarchived: Option.Option<Uint8Array>) => Effect.Effect<void>;
  readonly run: Effect.Effect<never>;
}

type Audio = Data.TaggedEnum<{
  Found: { readonly bytes: Uint8Array };
  Missing: {};
  Unavailable: {};
}>;

const Audio = Data.taggedEnum<Audio>();

const found = (bytes: Uint8Array): Audio => Audio.Found({ bytes });

const transcriberRetry = reconnectSchedule.pipe(
  Schedule.setInputType<TranscriptionError>(),
  Schedule.tap(({ input, attempt }) =>
    Effect.logWarning("Couldn't reach the transcriber, retrying").pipe(
      Effect.annotateLogs({ reason: input.detail, attempt }),
    ),
  ),
);

const untilTomorrow = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const tomorrow = DateTime.add(DateTime.startOf(now, "day"), { days: 1, minutes: 1 });

  yield* Effect.sleep(DateTime.distance(now, tomorrow));
});

const make = Effect.gen(function* () {
  const store = yield* RecordingStore;
  const archive = yield* ClipArchive;
  const transcriber = yield* Transcriber;
  const audio = yield* ClipAudio.make;
  const wake = yield* Queue.dropping<void>(1);
  const storeHealth = yield* StoreHealth.make;

  const queue = (clipId: number, unarchived: Option.Option<Uint8Array>) =>
    Option.match(unarchived, {
      onNone: () => Effect.void,
      onSome: (bytes) => audio.put(clipId, bytes),
    }).pipe(Effect.andThen(Queue.offer(wake, undefined)), Effect.asVoid);

  const audioFor = Effect.fn("Transcription.audioFor")(function* (clip: PendingClip) {
    const inMemory = yield* audio.get(clip.id);

    if (Option.isSome(inMemory)) return found(inMemory.value);

    if (clip.objectPath === null) return Audio.Missing();

    return yield* archive.download(clip.objectPath).pipe(
      Effect.map(found),
      Effect.catchTag("ArchiveError", (error) =>
        Effect.logWarning("Couldn't fetch a clip from the archive").pipe(
          Effect.annotateLogs({ reason: error.reason }),
          Effect.as(Audio.Unavailable()),
        ),
      ),
    );
  });

  const transcribeClip = (clip: PendingClip, bytes: Uint8Array) =>
    transcriber.transcribe(bytes).pipe(
      Effect.retry({
        schedule: transcriberRetry,
        while: (error) => error.failure === "Unavailable",
      }),
      Effect.flatMap(({ text, model }) =>
        DateTime.now.pipe(
          Effect.flatMap((at) => store.clipTranscribed(clip.id, at, text, model)),
          Effect.andThen(audio.remove(clip.id)),
          Effect.andThen(
            Effect.logInfo("Transcribed a clip").pipe(
              Effect.annotateLogs({ model, characters: text.length }),
            ),
          ),
        ),
      ),
      Effect.catchTag("TranscriptionError", (error) =>
        Match.value(error.failure).pipe(
          Match.when("DailyLimit", () =>
            Effect.logWarning(
              "Workers AI's daily allocation is used up, transcription waits for the reset",
            ).pipe(Effect.andThen(untilTomorrow)),
          ),
          Match.orElse(() =>
            store.clipFailed(clip.id, error.detail, false).pipe(
              Effect.andThen(
                Effect.logWarning("The transcriber rejected a clip").pipe(
                  Effect.annotateLogs({
                    reason: error.detail,
                    attempt: clip.attempts + 1,
                  }),
                ),
              ),
              Effect.andThen(Effect.sleep(REJECTED_CLIP_PAUSE)),
            ),
          ),
        ),
      ),
    );

  const transcribeNext = Effect.gen(function* () {
    const next = yield* store.nextPendingClip;

    yield* storeHealth.ok(READING_CLIPS);

    if (Option.isNone(next)) {
      yield* Queue.take(wake).pipe(Effect.timeoutOption(TRANSCRIPTION_IDLE));

      return;
    }

    const clip = next.value;

    yield* audioFor(clip).pipe(
      Effect.flatMap(
        Match.valueTags({
          Found: ({ bytes }) => transcribeClip(clip, bytes),
          Missing: () =>
            store
              .clipFailed(clip.id, "No audio is available for this clip", true)
              .pipe(Effect.andThen(Effect.logWarning("A clip has no audio to transcribe"))),
          Unavailable: () => Effect.sleep(TRANSCRIPTION_IDLE),
        }),
      ),
      Effect.withSpan("Transcription.transcribe"),
    );
  }).pipe(
    Effect.annotateLogs({ worker: "transcription" }),
    Effect.catchTag("StoreUnavailable", (error) =>
      storeHealth
        .issue(READING_CLIPS)(error)
        .pipe(Effect.andThen(Effect.sleep(TRANSCRIPTION_IDLE))),
    ),
  );

  return { queue, run: Effect.forever(transcribeNext) } satisfies Transcription;
});

export const Transcription = { make };
