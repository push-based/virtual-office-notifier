import {
  Array,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import { SecureRandom } from "effect/crypto";
import type { StopReason } from "recording-requests/Recording";
import { rewritesSummary } from "recording-requests/RecordingEdit";
import { type EditHandler, RecordingEdits } from "recording-requests/RecordingEdits";
import {
  type ActiveRecording,
  CHECK_INTERVAL,
  isOverLimit,
} from "recording-requests/RecordingRequest";
import {
  type RequestHandler,
  RecordingRequests,
  type StatusUpdate,
} from "recording-requests/RecordingRequests";
import { DEFAULT_SUMMARY_STYLE } from "recording-requests/wire";

import type { BotPresence } from "./BotPresence.ts";
import { Capture } from "./Capture.ts";
import { SlackConfig } from "./Config.ts";
import { DiscordGateway } from "./DiscordGateway.ts";
import type { OfficeLocation } from "./OfficeEvent.ts";
import { Publication } from "./Publication.ts";
import { RecordingStore, type StoreUnavailable } from "./RecordingStore.ts";
import { StoreHealth } from "./StoreHealth.ts";
import { Transcription } from "./Transcription.ts";

export const POLL_INTERVAL = CHECK_INTERVAL;

export const STATUS_INTERVAL = Duration.seconds(1);

const HANDLING_REQUESTS = "Couldn't handle recording requests";

const APPLYING_EDITS = "Couldn't apply recording edits";

const PUBLISHING_STATUS = "Couldn't update the recording status";

const encodeStatusKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const startRecorder = Effect.gen(function* () {
  const gateway = yield* DiscordGateway;
  const store = yield* RecordingStore;
  const requests = yield* RecordingRequests;
  const edits = yield* RecordingEdits;
  const random = yield* SecureRandom.SecureRandom;
  const { channelId: slackChannel } = yield* SlackConfig;

  const runFor = Effect.fnUntraced(function* (office: OfficeLocation) {
    const presence = yield* Ref.make<BotPresence>("Away");
    const started = yield* Ref.make(false);
    const lastStatus = yield* Ref.make("");
    const statusChanged = yield* Queue.dropping<void>(1);
    const storeHealth = yield* StoreHealth.make;
    const mutex = yield* Semaphore.make(1);

    const statusChange = Queue.offer(statusChanged, undefined).pipe(Effect.asVoid);

    const transcription = yield* Transcription.make;
    const capture = yield* Capture.make(office, transcription, statusChange);
    const publication = yield* Publication.make({ office, slackChannel });

    const writeStatus = Effect.gen(function* () {
      const current = yield* capture.current;
      const inOffice = (yield* Ref.get(presence)) === "InOffice";
      const speaking = yield* capture.speaking;

      const occupants = Array.map(yield* gateway.occupants, (member) => ({
        ...member,
        speaking: speaking.has(member.userId),
      }));

      const status: StatusUpdate = {
        recordingId: Option.getOrNull(Option.map(current, ({ id }) => id)),
        botInOffice: inOffice,
        occupants,
      };

      const key = yield* encodeStatusKey(status).pipe(Effect.orDie);

      if (key !== (yield* Ref.get(lastStatus)))
        yield* requests
          .publishStatus(status)
          .pipe(
            Effect.andThen(Ref.set(lastStatus, key)),
            Effect.andThen(storeHealth.ok(PUBLISHING_STATUS)),
            Effect.catchTag("RecordingUnavailable", storeHealth.issue(PUBLISHING_STATUS)),
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

    const stopped = (recordingId: string, reason: StopReason) =>
      Effect.logInfo("Stopped recording").pipe(
        Effect.annotateLogs({ recordingId, reason }),
        Effect.andThen(publication.finish(recordingId).pipe(Effect.forkScoped)),
      );

    const stopRecording = Effect.fn("Recorder.stopRecording")(function* (
      reason: StopReason,
      by: string | null,
    ) {
      const ended = yield* capture.end;

      if (Option.isNone(ended)) return;

      yield* store.stopRecording(ended.value.id, yield* DateTime.now, reason, by);
      yield* stopped(ended.value.id, reason);
    });

    const requestHandler: RequestHandler<StoreUnavailable, Scope.Scope> = {
      situation: Effect.gen(function* () {
        const occupants = new Set(
          Array.map(yield* gateway.occupants, (occupant) => occupant.userId),
        );

        return { occupants, active: yield* capture.current };
      }),
      start: Effect.fn("Recorder.start")(function* (request) {
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
          title: request.title,
          agenda: request.agenda,
          summaryStyle: request.summaryStyle ?? DEFAULT_SUMMARY_STYLE,
        });

        return {
          recordingId: recording.id,
          afterCommit: capture
            .begin(recording)
            .pipe(
              Effect.andThen(
                Effect.logInfo("Started recording").pipe(
                  Effect.annotateLogs({ recordingId: recording.id }),
                ),
              ),
            ),
        };
      }),
      stop: Effect.fn("Recorder.stop")(function* (request, recording) {
        yield* store.stopRecording(
          recording.id,
          yield* DateTime.now,
          "requested",
          request.requestedBy,
        );

        return {
          recordingId: recording.id,
          afterCommit: capture.end.pipe(Effect.andThen(stopped(recording.id, "requested"))),
        };
      }),
      pause: Effect.fn("Recorder.pause")(function* (request, recording) {
        const pausedAt = yield* DateTime.now;

        yield* store.pauseRecording(
          recording.id,
          pausedAt,
          request.requestedBy,
          request.requestedByName,
        );

        return {
          recordingId: recording.id,
          afterCommit: capture
            .hold({
              ...recording,
              pause: Option.some({ pausedAt, pausedBy: request.requestedBy }),
            })
            .pipe(
              Effect.andThen(
                Effect.logInfo("Paused recording").pipe(
                  Effect.annotateLogs({ recordingId: recording.id }),
                ),
              ),
            ),
        };
      }),
      resume: Effect.fn("Recorder.resume")(function* (request, recording) {
        yield* store.resumeRecording(
          recording.id,
          yield* DateTime.now,
          request.requestedBy,
          request.requestedByName,
        );

        return {
          recordingId: recording.id,
          afterCommit: capture
            .begin({ ...recording, pause: Option.none() })
            .pipe(
              Effect.andThen(
                Effect.logInfo("Resumed recording").pipe(
                  Effect.annotateLogs({ recordingId: recording.id }),
                ),
              ),
            ),
        };
      }),
    };

    const editHandler: EditHandler<StoreUnavailable, Scope.Scope> = {
      apply: Effect.fn("Recorder.apply")(function* (edit) {
        yield* store.applyEdit(edit.recordingId, edit.change);

        if (!rewritesSummary(edit.change))
          return {
            afterCommit: publication
              .refresh(edit.recordingId)
              .pipe(Effect.forkScoped, Effect.asVoid),
          };

        const rewriting = yield* store.requestRewrite(edit.recordingId, edit.id);

        return { afterCommit: rewriting ? publication.rewrite(edit.recordingId) : Effect.void };
      }),
    };

    const applyEdits = edits
      .handlePending(editHandler)
      .pipe(
        Effect.andThen(storeHealth.ok(APPLYING_EDITS)),
        Effect.catchTag(
          ["StoreUnavailable", "RecordingUnavailable"],
          storeHealth.issue(APPLYING_EDITS),
        ),
      );

    const tick = mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* capture.current;
        const now = yield* DateTime.now;

        if (Option.isSome(current) && isOverLimit(current.value, now))
          yield* stopRecording("time_limit", null);

        yield* requests.handlePending(requestHandler);
        yield* storeHealth.ok(HANDLING_REQUESTS);
        yield* statusChange;
      }).pipe(
        Effect.catchTag(
          ["StoreUnavailable", "RecordingUnavailable"],
          storeHealth.issue(HANDLING_REQUESTS),
        ),
        Effect.andThen(applyEdits),
      ),
    );

    const reconcileStartup = Effect.fn("Recorder.reconcileStartup")(
      function* (current: BotPresence) {
        yield* publication.catchUp;

        const active = yield* store.activeRecording;

        if (Option.isNone(active)) return;

        const now = yield* DateTime.now;

        if (current === "InOffice" && !isOverLimit(active.value, now)) {
          const paused = Option.isSome(active.value.pause);

          yield* store.recoverRecording(active.value.id, now);
          yield* paused ? capture.hold(active.value) : capture.begin(active.value);
          yield* Effect.logInfo("Picked up the recording that was on before the restart").pipe(
            Effect.annotateLogs({ recordingId: active.value.id, paused }),
          );

          return;
        }

        yield* store.stopRecording(active.value.id, now, "bot_restarted", null);
        yield* Effect.logInfo("Ended the recording that was on before the restart").pipe(
          Effect.annotateLogs({ recordingId: active.value.id }),
        );
        yield* publication.finish(active.value.id).pipe(Effect.forkScoped);
      },
      Effect.catchTag(
        "StoreUnavailable",
        StoreHealth.report("Couldn't check for a recording in progress"),
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
                StoreHealth.report("Couldn't record the end of the recording"),
              ),
            );
          }

          yield* statusChange;
        }),
      );

    const follow = Stream.runForEach(gateway.botPresence, onPresence);
    const poll = Effect.schedule(tick, Schedule.spaced(POLL_INTERVAL));

    yield* Effect.all([transcription.run, publishStatuses, Effect.raceFirst(follow, poll)], {
      concurrency: "unbounded",
      discard: true,
    });
  }, Effect.scoped);

  return yield* Option.match(gateway.office, {
    onNone: () => Effect.logInfo("No office voice channel, so recording is off"),
    onSome: runFor,
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Stopped recording the office", cause).pipe(
        Effect.andThen(ErrorReporter.report(cause)),
      ),
    ),
    Effect.forkScoped,
  );
});

export const RecorderLayer = Layer.effectDiscard(startRecorder);
