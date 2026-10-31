import {
  Array,
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  ErrorReporter,
  Fiber,
  Option,
  pipe,
  Queue,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import type { ActiveRecording } from "recording-requests/RecordingRequest";

import { ClipArchive, objectPathOf } from "./ClipArchive.ts";
import type { Clip } from "./audio/ClipCutter.ts";
import { DiscordGateway, type OfficeLocation, OfficeSeat } from "../office/index.ts";
import { oggOpusFile, opusPacketsDuration } from "./audio/OggOpus.ts";
import { MIN_CLIP_DURATION } from "./Recording.ts";
import { RecordingStore } from "./RecordingStore.ts";
import {
  noVoices,
  speakingAt,
  startedSpeaking,
  stoppedSpeaking,
  type Voices,
} from "./audio/Speaking.ts";
import type { Transcription } from "./Transcription.ts";
import { type CaptureError, Heard, VoiceCapture } from "./audio/VoiceCapture.ts";

const SAVING_LIMIT = Duration.seconds(30);

const UPLOAD_ATTEMPTS = 3;

export interface Capture {
  readonly current: Effect.Effect<Option.Option<ActiveRecording>>;
  readonly begin: (recording: ActiveRecording) => Effect.Effect<void>;
  readonly hold: (recording: ActiveRecording) => Effect.Effect<void>;
  readonly end: Effect.Effect<Option.Option<ActiveRecording>>;
  readonly speaking: Effect.Effect<ReadonlySet<string>>;
}

interface Listening {
  readonly fiber: Fiber.Fiber<void>;
  readonly stop: Deferred.Deferred<void>;
}

interface Session {
  readonly recording: ActiveRecording;
  readonly listening: Option.Option<Listening>;
}

const uploadRetry = Schedule.exponential("1 second").pipe(
  Schedule.upTo({ times: UPLOAD_ATTEMPTS - 1 }),
);

const captureRetry = Schedule.spaced("5 seconds").pipe(
  Schedule.setInputType<CaptureError>(),
  Schedule.tap(({ input, attempt }) =>
    Effect.logWarning("Lost the voice connection, rejoining").pipe(
      Effect.annotateLogs({ reason: input.reason, attempt }),
    ),
  ),
);

const make = Effect.fnUntraced(function* (
  office: OfficeLocation,
  transcription: Transcription,
  changed: Effect.Effect<void>,
) {
  const scope = yield* Scope.Scope;
  const gateway = yield* DiscordGateway;
  const seat = yield* OfficeSeat;
  const store = yield* RecordingStore;
  const voice = yield* VoiceCapture;
  const archive = yield* ClipArchive;
  const session = yield* Ref.make(Option.none<Session>());
  const voices = yield* Ref.make<Voices>(noVoices);

  const archiveClip = (recordingId: string, clip: Clip, ogg: Uint8Array) =>
    Option.match(archive.bucket, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: () => {
        const path = objectPathOf(recordingId, clip.userId, clip.startedAt);

        return archive.upload(path, ogg).pipe(
          Effect.retry(uploadRetry),
          Effect.as(Option.some(path)),
          Effect.catchTag("ArchiveError", (error) =>
            Effect.logError("Couldn't archive a clip, keeping it in memory for transcription").pipe(
              Effect.annotateLogs({ reason: error.reason }),
              Effect.andThen(ErrorReporter.report(Cause.fail(error))),
              Effect.as(Option.none<string>()),
            ),
          ),
        );
      },
    });

  const saveClip = Effect.fn("Capture.saveClip")(
    function* (recordingId: string, clip: Clip) {
      const durationMs = opusPacketsDuration(clip.packets);
      const ogg = oggOpusFile(clip.packets);
      const occupants = yield* gateway.occupants;

      const displayName = pipe(
        Array.findFirst(occupants, (occupant) => occupant.userId === clip.userId),
        Option.match({
          onNone: () => clip.userId,
          onSome: (occupant) => occupant.displayName,
        }),
      );

      const objectPath = yield* archiveClip(recordingId, clip, ogg);

      const transcribe = durationMs >= Duration.toMillis(MIN_CLIP_DURATION);

      const clipId = yield* store.addClip({
        recordingId,
        userId: clip.userId,
        displayName,
        startedAt: clip.startedAt,
        durationMs,
        bytes: ogg.length,
        objectPath: Option.getOrNull(objectPath),
        transcription: transcribe ? "pending" : "skipped",
      });

      if (transcribe)
        yield* transcription.queue(
          clipId,
          Option.isNone(objectPath) ? Option.some(ogg) : Option.none(),
        );

      yield* Effect.logInfo("Recorded a clip").pipe(
        Effect.annotateLogs({
          durationMs,
          transcription: transcribe ? "pending" : "skipped",
          archived: Option.isSome(objectPath),
        }),
      );
    },
    Effect.catchTag("StoreUnavailable", (error) =>
      Effect.logError("Couldn't record a clip").pipe(Effect.annotateLogs({ reason: error.reason })),
    ),
  );

  const updateVoices = (change: (current: Voices) => Voices) =>
    Ref.update(voices, change).pipe(Effect.andThen(changed));

  const listen = Effect.fn("Capture.listen")(
    function* (recordingId: string, stop: Deferred.Deferred<void>) {
      const clips = yield* Queue.unbounded<Clip, Cause.Done>();

      const saving = yield* Stream.fromQueue(clips).pipe(
        Stream.runForEach((clip) => saveClip(recordingId, clip)),
        Effect.forkScoped,
      );

      yield* voice.capture(office, Deferred.await(stop)).pipe(
        Stream.runForEach((heard) =>
          Heard.$match(heard, {
            Spoke: ({ clip }) => Queue.offer(clips, clip),
            StartedSpeaking: ({ userId }) =>
              updateVoices((current) => startedSpeaking(current, userId)),
            StoppedSpeaking: ({ userId }) =>
              DateTime.now.pipe(
                Effect.flatMap((at) =>
                  updateVoices((current) => stoppedSpeaking(current, userId, at)),
                ),
              ),
          }),
        ),
        Effect.ensuring(updateVoices(() => noVoices)),
        Effect.retry({
          schedule: captureRetry,
          while: () => Effect.map(Deferred.isDone(stop), (stopping) => !stopping),
        }),
        Effect.catchTag("CaptureError", (error) =>
          Effect.logError("Gave up on the voice connection").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          ),
        ),
      );

      yield* Queue.end(clips);
      yield* Fiber.join(saving);
    },
    Effect.scoped,
    (effect, recordingId) => Effect.annotateLogs(effect, { recordingId }),
  );

  const stopListening = ({ fiber, stop }: Listening) =>
    Deferred.succeed(stop, undefined).pipe(
      Effect.andThen(Fiber.await(fiber)),
      Effect.timeoutOption(SAVING_LIMIT),
      Effect.flatMap(
        Option.match({
          onSome: () => Effect.void,
          onNone: () =>
            Effect.logWarning("Gave up waiting for the last clips to be saved").pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
            ),
        }),
      ),
    );

  const stopSession = (current: Option.Option<Session>) =>
    Option.match(
      Option.flatMap(current, ({ listening }) => listening),
      {
        onNone: () => Effect.void,
        onSome: stopListening,
      },
    );

  const begin = Effect.fn("Capture.begin")(function* (recording: ActiveRecording) {
    yield* seat.record("Capturing");

    const stop = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkIn(listen(recording.id, stop), scope);

    yield* Ref.set(session, Option.some({ recording, listening: Option.some({ fiber, stop }) }));
  });

  const hold = Effect.fn("Capture.hold")(function* (recording: ActiveRecording) {
    const current = yield* Ref.getAndSet(
      session,
      Option.some({ recording, listening: Option.none() }),
    );

    yield* stopSession(current);
    yield* seat.record("Paused");
  });

  const end = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(session, Option.none());

    if (Option.isNone(current)) return Option.none<ActiveRecording>();

    yield* stopSession(current);
    yield* seat.record("Off");

    return Option.some(current.value.recording);
  });

  const speaking = Effect.gen(function* () {
    return speakingAt(yield* Ref.get(voices), yield* DateTime.now);
  });

  const current = Effect.map(
    Ref.get(session),
    Option.map(({ recording }) => recording),
  );

  return { current, begin, hold, end, speaking } satisfies Capture;
});

export const Capture = { make };
