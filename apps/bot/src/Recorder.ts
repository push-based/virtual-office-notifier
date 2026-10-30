import {
  Array,
  Cause,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  Fiber,
  Layer,
  Match,
  Option,
  pipe,
  Queue,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Semaphore,
  Stream,
  String,
} from "effect";
import { SecureRandom } from "effect/crypto";
import {
  type ActiveRecording,
  CHECK_INTERVAL,
  isOverLimit,
} from "recording-requests/RecordingRequest";
import {
  type RecordingUnavailable,
  type RequestHandler,
  RecordingRequests,
  type StatusUpdate,
} from "recording-requests/RecordingRequests";

import type { BotPresence } from "./BotPresence.ts";
import { ClipArchive, objectPathOf } from "./ClipArchive.ts";
import { SlackConfig } from "./Config.ts";
import { reconnectDelay } from "./Database.ts";
import { DiscordGateway } from "./DiscordGateway.ts";
import type { OfficeLocation } from "./OfficeEvent.ts";
import { oggOpusFile, opusPacketsDuration } from "./OggOpus.ts";
import { MIN_CLIP_DURATION, type StopReason } from "./Recording.ts";
import { type PendingClip, RecordingStore, type StoreUnavailable } from "./RecordingStore.ts";
import { SlackClient } from "./SlackClient.ts";
import { SlackHistory } from "./SlackHistory.ts";
import { summaryMessage } from "./SlackMessage.ts";
import { noVoices, speakingAt, startedSpeaking, stoppedSpeaking, type Voices } from "./Speaking.ts";
import { hasSpeech, speakersOf, SummaryWriter, transcriptText } from "./SummaryWriter.ts";
import { Transcriber } from "./Transcriber.ts";
import { type CaptureError, type Clip, Heard, VoiceCapture } from "./VoiceCapture.ts";

export const POLL_INTERVAL = CHECK_INTERVAL;

export const STATUS_INTERVAL = Duration.seconds(1);

export const FINISH_POLL = Duration.seconds(15);

export const TRANSCRIPTION_IDLE = Duration.seconds(30);

export const REJECTED_CLIP_PAUSE = Duration.seconds(5);

const FINISH_RETRY = Duration.minutes(10);

const FINISH_ATTEMPTS = 6;

const UPLOAD_ATTEMPTS = 3;

interface Session {
  readonly recording: ActiveRecording;
  readonly capture: Fiber.Fiber<void>;
}

type Audio = Data.TaggedEnum<{
  Found: { readonly bytes: Uint8Array };
  Missing: {};
  Unavailable: {};
}>;

const Audio = Data.taggedEnum<Audio>();

const found = (bytes: Uint8Array): Audio => Audio.Found({ bytes });

const report = (error: Error) => ErrorReporter.report(Cause.fail(error));

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

const finishRetry = Schedule.spaced(FINISH_RETRY).pipe(
  Schedule.upTo({ times: FINISH_ATTEMPTS - 1 }),
  Schedule.tap(({ attempt }) =>
    Effect.logWarning("Couldn't finish the recording, trying again later").pipe(
      Effect.annotateLogs({ attempt }),
    ),
  ),
);

const fileDate = (at: DateTime.Utc): string =>
  pipe(
    DateTime.formatIso(at),
    String.slice(0, 16),
    String.replace("T", "-"),
    String.replaceAll(":", ""),
  );

const encodeStatusKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const untilTomorrow = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const tomorrow = DateTime.add(DateTime.startOf(now, "day"), { days: 1, minutes: 1 });

  yield* Effect.sleep(DateTime.distance(now, tomorrow));
});

export class Recorder extends Context.Service<
  Recorder,
  {
    readonly run: Effect.Effect<void>;
  }
>()("bot/Recorder") {
  static readonly layerNone = Layer.succeed(Recorder, Recorder.of({ run: Effect.void }));

  static readonly layer = Layer.effect(
    Recorder,
    Effect.gen(function* () {
      const gateway = yield* DiscordGateway;
      const store = yield* RecordingStore;
      const requests = yield* RecordingRequests;
      const voice = yield* VoiceCapture;
      const archive = yield* ClipArchive;
      const transcriber = yield* Transcriber;
      const summaries = yield* SummaryWriter;
      const slack = yield* SlackClient;
      const history = yield* SlackHistory;
      const { channelId: slackChannel } = yield* SlackConfig;
      const random = yield* SecureRandom.SecureRandom;

      const runFor = Effect.fn("Recorder.run")(function* (office: OfficeLocation) {
        const audio = yield* Ref.make<ReadonlyMap<number, Uint8Array>>(new Map());
        const wake = yield* Queue.dropping<void>(1);
        const session = yield* Ref.make(Option.none<Session>());
        const presence = yield* Ref.make<BotPresence>("Away");
        const started = yield* Ref.make(false);
        const lastStatus = yield* Ref.make("");
        const voices = yield* Ref.make<Voices>(noVoices);
        const statusChanged = yield* Queue.dropping<void>(1);
        const storeHealthy = yield* Ref.make(true);
        const unavailableAttempts = yield* Ref.make(0);
        const mutex = yield* Semaphore.make(1);

        const storeIssue = (what: string) => (error: StoreUnavailable | RecordingUnavailable) =>
          Ref.getAndSet(storeHealthy, false).pipe(
            Effect.flatMap((wasHealthy) =>
              wasHealthy
                ? Effect.logWarning(`${what}, the database isn't available`).pipe(
                    Effect.annotateLogs({ reason: error.reason }),
                  )
                : Effect.void,
            ),
          );

        const storeOk = Ref.set(storeHealthy, true);

        const statusChange = Queue.offer(statusChanged, undefined).pipe(Effect.asVoid);

        const writeStatus = Effect.gen(function* () {
          const current = yield* Ref.get(session);
          const inOffice = (yield* Ref.get(presence)) === "InOffice";
          const speaking = speakingAt(yield* Ref.get(voices), yield* DateTime.now);

          const occupants = Array.map(yield* gateway.occupants, (member) => ({
            ...member,
            speaking: speaking.has(member.userId),
          }));

          const status: StatusUpdate = {
            recordingId: Option.getOrNull(Option.map(current, ({ recording }) => recording.id)),
            botInOffice: inOffice,
            occupants,
          };

          const key = yield* encodeStatusKey(status).pipe(Effect.orDie);

          if (key !== (yield* Ref.get(lastStatus)))
            yield* requests
              .publishStatus(status)
              .pipe(
                Effect.andThen(Ref.set(lastStatus, key)),
                Effect.catchTag(
                  "RecordingUnavailable",
                  storeIssue("Couldn't update the recording status"),
                ),
              );

          return speaking.size > 0;
        });

        const publishStatuses = Effect.forever(
          Effect.gen(function* () {
            yield* Queue.take(statusChanged);

            if (yield* writeStatus) yield* statusChange;

            yield* Effect.sleep(STATUS_INTERVAL);
          }),
        );

        const archiveClip = (recordingId: string, clip: Clip, ogg: Uint8Array) =>
          Option.match(archive.bucket, {
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: () => {
              const path = objectPathOf(recordingId, clip.userId, clip.startedAt);

              return archive.upload(path, ogg).pipe(
                Effect.retry(uploadRetry),
                Effect.as(Option.some(path)),
                Effect.catchTag("ArchiveError", (error) =>
                  Effect.logError(
                    "Couldn't archive a clip, keeping it in memory for transcription",
                  ).pipe(
                    Effect.annotateLogs({ reason: error.reason }),
                    Effect.andThen(report(error)),
                    Effect.as(Option.none<string>()),
                  ),
                ),
              );
            },
          });

        const handleClip = Effect.fn("Recorder.handleClip")(
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

            const transcription =
              durationMs < Duration.toMillis(MIN_CLIP_DURATION) ? "skipped" : "pending";

            const clipId = yield* store.addClip({
              recordingId,
              userId: clip.userId,
              displayName,
              startedAt: clip.startedAt,
              durationMs,
              bytes: ogg.length,
              objectPath: Option.getOrNull(objectPath),
              transcription,
            });

            if (transcription === "pending") {
              if (Option.isNone(objectPath))
                yield* Ref.update(audio, (all) => new Map(all).set(clipId, ogg));

              yield* Queue.offer(wake, undefined);
            }

            yield* Effect.logInfo("Recorded a clip").pipe(
              Effect.annotateLogs({
                durationMs,
                transcription,
                archived: Option.isSome(objectPath),
              }),
            );
          },
          Effect.catchTag("StoreUnavailable", (error) =>
            Effect.logError("Couldn't record a clip").pipe(
              Effect.annotateLogs({ reason: error.reason }),
            ),
          ),
        );

        const updateVoices = (change: (current: Voices) => Voices) =>
          Ref.update(voices, change).pipe(Effect.andThen(statusChange));

        const runCapture = (recordingId: string) =>
          Effect.gen(function* () {
            const clips = yield* Queue.unbounded<Clip, Cause.Done>();

            const saving = yield* Stream.fromQueue(clips).pipe(
              Stream.runForEach((clip) => handleClip(recordingId, clip)),
              Effect.forkScoped,
            );

            yield* voice.capture(office).pipe(
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
              Effect.retry(captureRetry),
              Effect.catchTag("CaptureError", (error) =>
                Effect.logError("Gave up on the voice connection").pipe(
                  Effect.annotateLogs({ reason: error.reason }),
                ),
              ),
            );

            yield* Queue.end(clips);
            yield* Fiber.join(saving);
          }).pipe(Effect.scoped, Effect.annotateLogs({ recordingId }));

        const beginCapture = (recording: ActiveRecording) =>
          Effect.gen(function* () {
            yield* gateway.setRecording(true);

            const capture = yield* runCapture(recording.id).pipe(Effect.forkScoped);

            yield* Ref.set(session, Option.some({ recording, capture }));
          });

        const awaitClips = (id: string) =>
          Effect.gen(function* () {
            while ((yield* store.outstandingClips(id)) > 0) yield* Effect.sleep(FINISH_POLL);
          });

        const finish = Effect.fn("Recorder.finish")(
          function* (id: string) {
            yield* awaitClips(id);

            const details = yield* store.recordingDetails(id);

            if (Option.isNone(details)) {
              yield* Effect.logWarning("The recording to finish wasn't found");

              return;
            }

            const lines = yield* store.clipsOf(id);
            const transcript = transcriptText(details.value, lines);
            const at = yield* DateTime.now;

            if (!hasSpeech(lines)) {
              yield* store.finishRecording(id, {
                transcript,
                summary: null,
                summaryModel: null,
                slackChannelId: null,
                slackTs: null,
                finishedAt: at,
              });
              yield* Effect.logInfo("Nothing was said during the recording, so nothing is posted");

              return;
            }

            const summary = yield* summaries.write(transcript);
            const { startedAt, stoppedAt, startedByName } = details.value;

            const posted = yield* slack.postMessage({
              channel: slackChannel,
              ...summaryMessage({
                office,
                startedAt,
                stoppedAt,
                startedByName,
                speakers: speakersOf(lines),
                summary,
              }),
            });

            yield* slack
              .uploadFile({
                channel: slackChannel,
                threadTs: posted.ts,
                filename: `office-recording-${fileDate(startedAt)}.txt`,
                title: "Transcript",
                content: new TextEncoder().encode(transcript),
              })
              .pipe(
                Effect.catchTag("SlackError", (error) =>
                  Effect.logWarning("Couldn't attach the transcript to the summary").pipe(
                    Effect.annotateLogs({ reason: error.reason._tag }),
                    Effect.andThen(report(error)),
                  ),
                ),
              );

            yield* history
              .recordPost({
                channel: posted.channel,
                ts: posted.ts,
                threadTs: null,
                kind: "Recording",
                model: Option.getOrNull(Option.map(summary, ({ model }) => model)),
                postedAt: at,
              })
              .pipe(
                Effect.catchTag("HistoryUnavailable", (error) =>
                  Effect.logWarning("Couldn't record the Slack post").pipe(
                    Effect.annotateLogs({ reason: error.reason }),
                  ),
                ),
              );

            yield* store.finishRecording(id, {
              transcript,
              summary: Option.getOrNull(Option.map(summary, ({ text }) => text)),
              summaryModel: Option.getOrNull(Option.map(summary, ({ model }) => model)),
              slackChannelId: posted.channel,
              slackTs: posted.ts,
              finishedAt: at,
            });

            yield* Effect.logInfo("Posted the recording summary").pipe(
              Effect.annotateLogs({
                speakers: speakersOf(lines).length,
                summarized: Option.isSome(summary),
              }),
            );
          },
          Effect.retry(finishRetry),
          Effect.catch((error) =>
            Effect.logError("Gave up finishing the recording").pipe(
              Effect.annotateLogs({ reason: error.message }),
              Effect.andThen(report(error)),
            ),
          ),
          (effect, id) => Effect.annotateLogs(effect, { recordingId: id }),
        );

        const endCapture = Effect.gen(function* () {
          const current = yield* Ref.getAndSet(session, Option.none());

          if (Option.isNone(current)) return;

          yield* Fiber.interrupt(current.value.capture);
          yield* gateway.setRecording(false);
        });

        const stopped = (recordingId: string, reason: StopReason) =>
          Effect.logInfo("Stopped recording").pipe(
            Effect.annotateLogs({ recordingId, reason }),
            Effect.andThen(finish(recordingId).pipe(Effect.forkScoped)),
          );

        const stopRecording = (reason: StopReason, by: string | null) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(session);

            if (Option.isNone(current)) return;

            const { recording } = current.value;

            yield* endCapture;
            yield* store.stopRecording(recording.id, yield* DateTime.now, reason, by);
            yield* stopped(recording.id, reason);
          });

        const requestHandler: RequestHandler<StoreUnavailable, Scope.Scope> = {
          situation: Effect.gen(function* () {
            const occupants = new Set(
              Array.map(yield* gateway.occupants, (occupant) => occupant.userId),
            );

            const active = Option.map(yield* Ref.get(session), ({ recording }) => recording);

            return { occupants, active };
          }),
          start: (request) =>
            Effect.gen(function* () {
              const startedAt = yield* DateTime.now;

              const recording: ActiveRecording = {
                id: yield* random.uuidV4(),
                startedAt,
                startedBy: request.requestedBy,
              };

              yield* store.startRecording({
                ...recording,
                guildId: office.guildId,
                channelId: office.channelId,
                startedByName: request.requestedByName,
              });

              return {
                recordingId: recording.id,
                afterCommit: beginCapture(recording).pipe(
                  Effect.andThen(
                    Effect.logInfo("Started recording").pipe(
                      Effect.annotateLogs({ recordingId: recording.id }),
                    ),
                  ),
                ),
              };
            }),
          stop: (request, recording) =>
            Effect.gen(function* () {
              yield* store.stopRecording(
                recording.id,
                yield* DateTime.now,
                "requested",
                request.requestedBy,
              );

              return {
                recordingId: recording.id,
                afterCommit: endCapture.pipe(Effect.andThen(stopped(recording.id, "requested"))),
              };
            }),
        };

        const tick = mutex.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(session);
            const now = yield* DateTime.now;

            if (Option.isSome(current) && isOverLimit(current.value.recording, now))
              yield* stopRecording("time_limit", null);

            yield* requests.handlePending(requestHandler);
            yield* storeOk;
            yield* statusChange;
          }).pipe(
            Effect.catchTag(
              ["StoreUnavailable", "RecordingUnavailable"],
              storeIssue("Couldn't handle recording requests"),
            ),
          ),
        );

        const reconcileStartup = (current: BotPresence) =>
          Effect.gen(function* () {
            const unfinished = yield* store.unfinishedRecordings;

            for (const id of unfinished) yield* finish(id).pipe(Effect.forkScoped);

            const active = yield* store.activeRecording;

            if (Option.isNone(active)) return;

            const now = yield* DateTime.now;

            if (current === "InOffice" && !isOverLimit(active.value, now)) {
              yield* store.resumeRecording(active.value.id, now);
              yield* beginCapture(active.value);
              yield* Effect.logInfo("Resumed the recording that was on before the restart").pipe(
                Effect.annotateLogs({ recordingId: active.value.id }),
              );

              return;
            }

            yield* store.stopRecording(active.value.id, now, "bot_restarted", null);
            yield* Effect.logInfo("Ended the recording that was on before the restart").pipe(
              Effect.annotateLogs({ recordingId: active.value.id }),
            );
            yield* finish(active.value.id).pipe(Effect.forkScoped);
          }).pipe(
            Effect.catchTag(
              "StoreUnavailable",
              storeIssue("Couldn't check for a recording in progress"),
            ),
          );

        const onPresence = (next: BotPresence) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.set(presence, next);

              const alreadyStarted = yield* Ref.getAndSet(started, true);

              if (!alreadyStarted) {
                yield* reconcileStartup(next);
              } else if (next === "Away") {
                yield* stopRecording("office_emptied", null).pipe(
                  Effect.catchTag(
                    "StoreUnavailable",
                    storeIssue("Couldn't record the end of the recording"),
                  ),
                );
              }

              yield* statusChange;
            }),
          );

        const audioFor = (clip: PendingClip) =>
          Effect.gen(function* () {
            const inMemory = (yield* Ref.get(audio)).get(clip.id);

            if (inMemory !== undefined) return found(inMemory);

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
            Effect.flatMap(({ text, model }) =>
              DateTime.now.pipe(
                Effect.flatMap((at) => store.clipTranscribed(clip.id, at, text, model)),
                Effect.andThen(
                  Ref.update(audio, (all) => {
                    const next = new Map(all);

                    next.delete(clip.id);

                    return next;
                  }),
                ),
                Effect.andThen(Ref.set(unavailableAttempts, 0)),
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
                Match.when("Unavailable", () =>
                  Ref.updateAndGet(unavailableAttempts, (attempts) => attempts + 1).pipe(
                    Effect.flatMap((attempts) =>
                      Effect.logWarning("Couldn't reach the transcriber, retrying").pipe(
                        Effect.annotateLogs({ reason: error.detail, attempt: attempts }),
                        Effect.andThen(Effect.sleep(reconnectDelay(attempts))),
                      ),
                    ),
                  ),
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

          yield* storeOk;

          if (Option.isNone(next)) {
            yield* Queue.take(wake).pipe(Effect.timeoutOption(TRANSCRIPTION_IDLE));

            return;
          }

          const clip = next.value;

          yield* Match.valueTags(yield* audioFor(clip), {
            Found: ({ bytes }) => transcribeClip(clip, bytes),
            Missing: () =>
              store
                .clipFailed(clip.id, "No audio is available for this clip", true)
                .pipe(Effect.andThen(Effect.logWarning("A clip has no audio to transcribe"))),
            Unavailable: () => Effect.sleep(TRANSCRIPTION_IDLE),
          });
        }).pipe(
          Effect.annotateLogs({ worker: "transcription" }),
          Effect.catchTag("StoreUnavailable", (error) =>
            storeIssue("Couldn't read the clips to transcribe")(error).pipe(
              Effect.andThen(Effect.sleep(TRANSCRIPTION_IDLE)),
            ),
          ),
        );

        yield* Effect.forever(transcribeNext).pipe(Effect.forkScoped);
        yield* publishStatuses.pipe(Effect.forkScoped);

        const follow = Stream.runForEach(gateway.botPresence, onPresence);
        const poll = Effect.forever(Effect.sleep(POLL_INTERVAL).pipe(Effect.andThen(tick)));

        yield* Effect.raceFirst(follow, poll);
      }, Effect.scoped);

      return Recorder.of({
        run: Option.match(gateway.office, {
          onNone: () => Effect.logInfo("No office voice channel, so recording is off"),
          onSome: runFor,
        }),
      });
    }),
  );
}
