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
import {
  type PendingClip,
  RecordingStore,
  type StoreUnavailable,
  type UnlinkedPost,
} from "./RecordingStore.ts";
import { SlackClient } from "./SlackClient.ts";
import { SlackHistory } from "./SlackHistory.ts";
import { summaryMessage } from "./SlackMessage.ts";
import { hasSpeech, speakersOf, SummaryWriter, transcriptText } from "./SummaryWriter.ts";
import { Transcriber } from "./Transcriber.ts";
import { type CaptureError, type Clip, VoiceCapture } from "./VoiceCapture.ts";

export const POLL_INTERVAL = CHECK_INTERVAL;

export const FINISH_POLL = Duration.seconds(15);

export const TRANSCRIPTION_IDLE = Duration.seconds(30);

export const REJECTED_CLIP_PAUSE = Duration.seconds(5);

const FINISH_RETRY = Duration.minutes(10);

const FINISH_ATTEMPTS = 6;

const UPLOAD_ATTEMPTS = 3;

interface Session {
  readonly recording: ActiveRecording;
  readonly capture: Option.Option<Fiber.Fiber<void>>;
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

        const writeStatus = Effect.gen(function* () {
          const current = yield* Ref.get(session);
          const inOffice = (yield* Ref.get(presence)) === "InOffice";
          const occupants = yield* gateway.occupants;

          const status: StatusUpdate = {
            recordingId: Option.getOrNull(Option.map(current, ({ recording }) => recording.id)),
            botInOffice: inOffice,
            occupants,
          };

          const key = yield* encodeStatusKey(status).pipe(Effect.orDie);

          if (key === (yield* Ref.get(lastStatus))) return;

          yield* requests
            .publishStatus(status)
            .pipe(
              Effect.andThen(Ref.set(lastStatus, key)),
              Effect.catchTag(
                "RecordingUnavailable",
                storeIssue("Couldn't update the recording status"),
              ),
            );
        });

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

        const runCapture = (recordingId: string) =>
          voice.capture(office).pipe(
            Stream.runForEach((clip) => handleClip(recordingId, clip)),
            Effect.retry(captureRetry),
            Effect.catchTag("CaptureError", (error) =>
              Effect.logError("Gave up on the voice connection").pipe(
                Effect.annotateLogs({ reason: error.reason }),
              ),
            ),
            Effect.annotateLogs({ recordingId }),
          );

        const interruptCapture = (current: Option.Option<Session>) =>
          Option.match(
            Option.flatMap(current, ({ capture }) => capture),
            {
              onNone: () => Effect.void,
              onSome: (capture) => Fiber.interrupt(capture),
            },
          );

        const beginCapture = (recording: ActiveRecording) =>
          Effect.gen(function* () {
            yield* gateway.setRecording("Capturing");

            const capture = yield* runCapture(recording.id).pipe(Effect.forkScoped);

            yield* Ref.set(session, Option.some({ recording, capture: Option.some(capture) }));
          });

        const holdPaused = (recording: ActiveRecording) =>
          Effect.gen(function* () {
            const current = yield* Ref.getAndSet(
              session,
              Option.some({ recording, capture: Option.none() }),
            );

            yield* interruptCapture(current);
            yield* gateway.setRecording("Paused");
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
            const pauses = yield* store.pausesOf(id);
            const transcript = transcriptText(details.value, lines, pauses);
            const at = yield* DateTime.now;

            if (!hasSpeech(lines)) {
              yield* store.finishRecording(id, {
                transcript,
                summary: null,
                summaryModel: null,
                slackChannelId: null,
                slackTs: null,
                slackPermalink: null,
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

            const permalink = yield* slack.permalink(posted.channel, posted.ts).pipe(
              Effect.asSome,
              Effect.catchTag("SlackError", (error) =>
                Effect.logWarning("Couldn't get the link to the summary").pipe(
                  Effect.annotateLogs({ reason: error.reason._tag }),
                  Effect.as(Option.none<string>()),
                ),
              ),
            );

            yield* store.finishRecording(id, {
              transcript,
              summary: Option.getOrNull(Option.map(summary, ({ text }) => text)),
              summaryModel: Option.getOrNull(Option.map(summary, ({ model }) => model)),
              slackChannelId: posted.channel,
              slackTs: posted.ts,
              slackPermalink: Option.getOrNull(permalink),
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

        const linkPost = (post: UnlinkedPost) =>
          slack.permalink(post.slackChannelId, post.slackTs).pipe(
            Effect.flatMap((permalink) => store.linkPost(post.id, permalink)),
            Effect.as(true),
            Effect.catchTags({
              SlackError: (error) =>
                Effect.logWarning("Couldn't get the link to a recording's summary").pipe(
                  Effect.annotateLogs({ reason: error.reason._tag }),
                  Effect.as(false),
                ),
              StoreUnavailable: (error) =>
                Effect.logWarning("Couldn't store the link to a recording's summary").pipe(
                  Effect.annotateLogs({ reason: error.reason }),
                  Effect.as(false),
                ),
            }),
            Effect.annotateLogs({ recordingId: post.id }),
          );

        const linkPosts = Effect.gen(function* () {
          const linked = yield* Effect.forEach(yield* store.unlinkedPosts, linkPost);
          const total = Array.filter(linked, Boolean).length;

          if (total > 0)
            yield* Effect.logInfo("Linked earlier recordings to their summaries").pipe(
              Effect.annotateLogs({ linked: total }),
            );
        }).pipe(
          Effect.catchTag("StoreUnavailable", (error) =>
            Effect.logWarning("Couldn't look for recordings without a link to their summary").pipe(
              Effect.annotateLogs({ reason: error.reason }),
            ),
          ),
          Effect.withSpan("Recorder.linkPosts"),
        );

        const endCapture = Effect.gen(function* () {
          const current = yield* Ref.getAndSet(session, Option.none());

          if (Option.isNone(current)) return;

          yield* interruptCapture(current);
          yield* gateway.setRecording("Off");
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
                pause: Option.none(),
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
          pause: (request, recording) =>
            Effect.gen(function* () {
              const pausedAt = yield* DateTime.now;

              yield* store.pauseRecording(
                recording.id,
                pausedAt,
                request.requestedBy,
                request.requestedByName,
              );

              return {
                recordingId: recording.id,
                afterCommit: holdPaused({
                  ...recording,
                  pause: Option.some({ pausedAt, pausedBy: request.requestedBy }),
                }).pipe(
                  Effect.andThen(
                    Effect.logInfo("Paused recording").pipe(
                      Effect.annotateLogs({ recordingId: recording.id }),
                    ),
                  ),
                ),
              };
            }),
          resume: (request, recording) =>
            Effect.gen(function* () {
              yield* store.resumeRecording(
                recording.id,
                yield* DateTime.now,
                request.requestedBy,
                request.requestedByName,
              );

              return {
                recordingId: recording.id,
                afterCommit: beginCapture({ ...recording, pause: Option.none() }).pipe(
                  Effect.andThen(
                    Effect.logInfo("Resumed recording").pipe(
                      Effect.annotateLogs({ recordingId: recording.id }),
                    ),
                  ),
                ),
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
            yield* writeStatus;
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

            yield* linkPosts.pipe(Effect.forkScoped);

            const active = yield* store.activeRecording;

            if (Option.isNone(active)) return;

            const now = yield* DateTime.now;

            if (current === "InOffice" && !isOverLimit(active.value, now)) {
              const paused = Option.isSome(active.value.pause);

              yield* store.recoverRecording(active.value.id, now);
              yield* paused ? holdPaused(active.value) : beginCapture(active.value);
              yield* Effect.logInfo("Picked up the recording that was on before the restart").pipe(
                Effect.annotateLogs({ recordingId: active.value.id, paused }),
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

              yield* writeStatus;
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
