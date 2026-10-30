import {
  Array,
  Cause,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Equal,
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

import { ActionItemList, ActionItemWriter, actionItemsRequest, ownedBy } from "./ActionItems.ts";
import type { BotPresence } from "./BotPresence.ts";
import { ClipArchive, objectPathOf } from "./ClipArchive.ts";
import { ClipAudio } from "./ClipAudio.ts";
import type { Clip } from "./ClipCutter.ts";
import { SlackConfig } from "./Config.ts";
import { reconnectSchedule } from "./Database.ts";
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
import { rewriteNote, type SlackMessage, summaryMessage } from "./SlackMessage.ts";
import { noVoices, speakingAt, startedSpeaking, stoppedSpeaking, type Voices } from "./Speaking.ts";
import { StoreHealth } from "./StoreHealth.ts";
import { SummaryRewriter } from "./SummaryRewriter.ts";
import {
  hasSpeech,
  speakersOf,
  summaryRequest,
  SummaryWriter,
  transcriptText,
} from "./SummaryWriter.ts";
import { Transcriber, type TranscriptionError } from "./Transcriber.ts";
import { type CaptureError, Heard, VoiceCapture } from "./VoiceCapture.ts";

export const POLL_INTERVAL = CHECK_INTERVAL;

export const STATUS_INTERVAL = Duration.seconds(1);

export const FINISH_POLL = Duration.seconds(15);

export const TRANSCRIPTION_IDLE = Duration.seconds(30);

export const REJECTED_CLIP_PAUSE = Duration.seconds(5);

const SAVING_LIMIT = Duration.seconds(30);

const FINISH_RETRY = Duration.minutes(10);

const FINISH_ATTEMPTS = 6;

const UPLOAD_ATTEMPTS = 3;

const REWRITE_RETRY = Duration.minutes(1);

const REWRITE_ATTEMPTS = 5;

interface Capture {
  readonly fiber: Fiber.Fiber<void>;
  readonly stop: Deferred.Deferred<void>;
}

interface Session {
  readonly recording: ActiveRecording;
  readonly capture: Option.Option<Capture>;
}

type Audio = Data.TaggedEnum<{
  Found: { readonly bytes: Uint8Array };
  Missing: {};
  Unavailable: {};
}>;

const Audio = Data.taggedEnum<Audio>();

const found = (bytes: Uint8Array): Audio => Audio.Found({ bytes });

const report = (error: Error) => ErrorReporter.report(Cause.fail(error));

const HANDLING_REQUESTS = "Couldn't handle recording requests";

const APPLYING_EDITS = "Couldn't apply recording edits";

const PUBLISHING_STATUS = "Couldn't update the recording status";

const READING_CLIPS = "Couldn't read the clips to transcribe";

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

const rewriteRetry = Schedule.spaced(REWRITE_RETRY).pipe(
  Schedule.upTo({ times: REWRITE_ATTEMPTS - 1 }),
  Schedule.tap(({ attempt }) =>
    Effect.logWarning("Couldn't rewrite the summary, trying again later").pipe(
      Effect.annotateLogs({ attempt }),
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

const transcriberRetry = reconnectSchedule.pipe(
  Schedule.setInputType<TranscriptionError>(),
  Schedule.tap(({ input, attempt }) =>
    Effect.logWarning("Couldn't reach the transcriber, retrying").pipe(
      Effect.annotateLogs({ reason: input.detail, attempt }),
    ),
  ),
);

const encodeStatusKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const untilTomorrow = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const tomorrow = DateTime.add(DateTime.startOf(now, "day"), { days: 1, minutes: 1 });

  yield* Effect.sleep(DateTime.distance(now, tomorrow));
});

export const startRecorder = Effect.gen(function* () {
  const gateway = yield* DiscordGateway;
  const store = yield* RecordingStore;
  const requests = yield* RecordingRequests;
  const edits = yield* RecordingEdits;
  const voice = yield* VoiceCapture;
  const archive = yield* ClipArchive;
  const transcriber = yield* Transcriber;
  const summaries = yield* SummaryWriter;
  const actionItemWriter = yield* ActionItemWriter;
  const slack = yield* SlackClient;
  const history = yield* SlackHistory;
  const { channelId: slackChannel } = yield* SlackConfig;
  const random = yield* SecureRandom.SecureRandom;

  const runFor = Effect.fnUntraced(function* (office: OfficeLocation) {
    const audio = yield* ClipAudio.make;
    const wake = yield* Queue.dropping<void>(1);
    const session = yield* Ref.make(Option.none<Session>());
    const presence = yield* Ref.make<BotPresence>("Away");
    const started = yield* Ref.make(false);
    const lastStatus = yield* Ref.make("");
    const voices = yield* Ref.make<Voices>(noVoices);
    const statusChanged = yield* Queue.dropping<void>(1);
    const storeHealth = yield* StoreHealth.make;
    const mutex = yield* Semaphore.make(1);
    const updatingPost = yield* Semaphore.make(1);

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
          if (Option.isNone(objectPath)) yield* audio.put(clipId, ogg);

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

    const runCapture = Effect.fn("Recorder.runCapture")(
      function* (recordingId: string, stop: Deferred.Deferred<void>) {
        const clips = yield* Queue.unbounded<Clip, Cause.Done>();

        const saving = yield* Stream.fromQueue(clips).pipe(
          Stream.runForEach((clip) => handleClip(recordingId, clip)),
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

    const finishCapture = ({ fiber, stop }: Capture) =>
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

    const endSessionCapture = (current: Option.Option<Session>) =>
      Option.match(
        Option.flatMap(current, ({ capture }) => capture),
        {
          onNone: () => Effect.void,
          onSome: finishCapture,
        },
      );

    const beginCapture = Effect.fn("Recorder.beginCapture")(function* (recording: ActiveRecording) {
      yield* gateway.setRecording("Capturing");

      const stop = yield* Deferred.make<void>();
      const fiber = yield* runCapture(recording.id, stop).pipe(Effect.forkScoped);

      yield* Ref.set(session, Option.some({ recording, capture: Option.some({ fiber, stop }) }));
    });

    const holdPaused = Effect.fn("Recorder.holdPaused")(function* (recording: ActiveRecording) {
      const current = yield* Ref.getAndSet(
        session,
        Option.some({ recording, capture: Option.none() }),
      );

      yield* endSessionCapture(current);
      yield* gateway.setRecording("Paused");
    });

    const awaitClips = Effect.fn("Recorder.awaitClips")(
      (id: string) =>
        store.outstandingClips(id).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(FINISH_POLL),
            until: (outstanding) => outstanding === 0,
          }),
        ),
      Effect.asVoid,
    );

    const postedMessage = Effect.fn("Recorder.postedMessage")(function* (id: string) {
      const details = yield* store.recordingDetails(id);
      const post = yield* store.summaryPost(id);

      if (Option.isNone(details) || Option.isNone(post)) return Option.none();

      const lines = yield* store.clipsOf(id);
      const actionItems = yield* store.actionItemsOf(id);
      const { startedAt, stoppedAt, startedByName, title } = details.value;
      const { slackChannelId, slackTs, summary, summaryModel, summaryStyle } = post.value;

      return Option.some({
        channel: slackChannelId,
        ts: slackTs,
        message: summaryMessage({
          office,
          startedAt,
          stoppedAt,
          startedByName,
          title,
          speakers: speakersOf(lines),
          summary:
            summary === null || summaryModel === null
              ? Option.none()
              : Option.some({
                  text: summary,
                  model: summaryModel,
                  style: summaryStyle ?? DEFAULT_SUMMARY_STYLE,
                }),
          actionItems,
        }),
      });
    });

    const updatePostUnless = (id: string, unchanged: (message: SlackMessage) => boolean) =>
      updatingPost
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* postedMessage(id);

            if (Option.isNone(current) || unchanged(current.value.message)) return;

            const { channel, ts, message } = current.value;

            yield* slack.updateMessage(channel, ts, message);
            yield* Effect.logInfo("Updated the recording's summary in Slack");
          }),
        )
        .pipe(
          Effect.catchTags({
            SlackError: (error) =>
              Effect.logWarning("Couldn't update the recording's summary in Slack").pipe(
                Effect.annotateLogs({ reason: error.reason._tag }),
                Effect.andThen(report(error)),
              ),
            StoreUnavailable: (error) =>
              Effect.logWarning("Couldn't read the recording to update its summary").pipe(
                Effect.annotateLogs({ reason: error.reason }),
              ),
          }),
          Effect.annotateLogs({ recordingId: id }),
        );

    const updatePost = (id: string) => updatePostUnless(id, () => false);

    const updatePostIfChanged = (id: string, posted: SlackMessage) =>
      updatePostUnless(id, (current) => Equal.equals(current, posted));

    const pullActionItems = Effect.fn("Recorder.pullActionItems")(function* (
      id: string,
      request: string,
    ) {
      const known = yield* store.actionItemsOf(id);

      if (!ActionItemList.$is("NotTried")(known)) return known;

      const members = yield* store.presentDuring(id);
      const pulled = yield* actionItemWriter.pull(actionItemsRequest(members, request));

      yield* store.recordActionItems(
        id,
        Option.map(pulled, ({ value, model }) => ({ model, items: ownedBy(members, value) })),
        yield* DateTime.now,
      );

      return yield* store.actionItemsOf(id);
    });

    const repullActionItems = Effect.fn("Recorder.repullActionItems")(function* (
      id: string,
      request: string,
    ) {
      if (yield* store.actionItemsTouched(id)) return;

      const members = yield* store.presentDuring(id);
      const pulled = yield* actionItemWriter.pull(actionItemsRequest(members, request));

      if (Option.isNone(pulled)) return;

      const { value, model } = pulled.value;

      yield* store.replaceActionItems(
        id,
        { model, items: ownedBy(members, value) },
        yield* DateTime.now,
      );
    });

    const noteRewrite = (id: string, note: SlackMessage) =>
      store.summaryPost(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ slackChannelId, slackTs }) =>
              slack
                .postMessage({ channel: slackChannelId, threadTs: slackTs, ...note })
                .pipe(Effect.asVoid),
          }),
        ),
        Effect.catchTag("SlackError", (error) =>
          Effect.logWarning("Couldn't say in Slack that the summary was rewritten").pipe(
            Effect.annotateLogs({ reason: error.reason._tag }),
            Effect.andThen(report(error)),
          ),
        ),
      );

    const rewriteOnce = Effect.fn("Recorder.rewrite")(
      function* (id: string) {
        const pending = yield* store.pendingRewrite(id);

        if (Option.isNone(pending)) return;

        const { editId, editedByName, previousStyle } = pending.value;
        const details = yield* store.recordingDetails(id);

        if (Option.isNone(details)) {
          yield* store.dropRewrite(id, editId);

          return;
        }

        const lines = yield* store.clipsOf(id);
        const pauses = yield* store.pausesOf(id);
        const transcript = transcriptText(details.value, lines, pauses);
        const style = details.value.summaryStyle;

        const request = summaryRequest(details.value, transcript);
        const summary = yield* summaries.write(request, style);

        if (Option.isNone(summary)) {
          yield* store.dropRewrite(id, editId);
          yield* Effect.logWarning("No AI model could rewrite the summary, so it stays as it was");

          return;
        }

        yield* repullActionItems(id, request);

        yield* store.saveRewrite(id, {
          editId,
          style,
          text: summary.value.text,
          model: summary.value.model,
          writtenAt: yield* DateTime.now,
        });

        yield* updatePost(id);
        yield* noteRewrite(
          id,
          rewriteNote(
            previousStyle === null || previousStyle === style ? Option.none() : Option.some(style),
            editedByName,
          ),
        );
        yield* Effect.logInfo("Rewrote the recording's summary").pipe(
          Effect.annotateLogs({ style, edit: editId }),
        );
      },
      Effect.retry(rewriteRetry),
      Effect.catchTag("StoreUnavailable", (error) =>
        Effect.logError("Gave up rewriting the summary").pipe(
          Effect.annotateLogs({ reason: error.reason }),
        ),
      ),
      (effect, id) => Effect.annotateLogs(effect, { recordingId: id }),
    );

    const { rewrite } = yield* SummaryRewriter.make(rewriteOnce);

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
            writtenWith: {
              summaryStyle: details.value.summaryStyle,
              agenda: details.value.agenda,
            },
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

        const { startedAt, stoppedAt, startedByName, title, agenda, summaryStyle } = details.value;

        const request = summaryRequest(details.value, transcript);
        const summary = yield* summaries.write(request, summaryStyle);
        const actionItems = yield* pullActionItems(id, request);

        const message = summaryMessage({
          office,
          startedAt,
          stoppedAt,
          startedByName,
          title,
          speakers: speakersOf(lines),
          summary,
          actionItems,
        });

        const posted = yield* slack.postMessage({ channel: slackChannel, ...message });

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

        const rewriting = yield* store.finishRecording(id, {
          transcript,
          writtenWith: { summaryStyle, agenda },
          summary: Option.getOrNull(Option.map(summary, ({ text }) => text)),
          summaryModel: Option.getOrNull(Option.map(summary, ({ model }) => model)),
          slackChannelId: posted.channel,
          slackTs: posted.ts,
          slackPermalink: Option.getOrNull(permalink),
          finishedAt: at,
        });

        yield* updatePostIfChanged(id, message);

        if (rewriting) yield* rewrite(id);

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

      yield* endSessionCapture(current);
      yield* gateway.setRecording("Off");
    });

    const stopped = (recordingId: string, reason: StopReason) =>
      Effect.logInfo("Stopped recording").pipe(
        Effect.annotateLogs({ recordingId, reason }),
        Effect.andThen(finish(recordingId).pipe(Effect.forkScoped)),
      );

    const stopRecording = Effect.fn("Recorder.stopRecording")(function* (
      reason: StopReason,
      by: string | null,
    ) {
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
          afterCommit: beginCapture(recording).pipe(
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
          afterCommit: endCapture.pipe(Effect.andThen(stopped(recording.id, "requested"))),
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
      resume: Effect.fn("Recorder.resume")(function* (request, recording) {
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

    const editHandler: EditHandler<StoreUnavailable, Scope.Scope> = {
      apply: Effect.fn("Recorder.apply")(function* (edit) {
        yield* store.applyEdit(edit.recordingId, edit.change);

        if (!rewritesSummary(edit.change))
          return {
            afterCommit: updatePost(edit.recordingId).pipe(Effect.forkScoped, Effect.asVoid),
          };

        const rewriting = yield* store.requestRewrite(edit.recordingId, edit.id);

        return { afterCommit: rewriting ? rewrite(edit.recordingId) : Effect.void };
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
        const current = yield* Ref.get(session);
        const now = yield* DateTime.now;

        if (Option.isSome(current) && isOverLimit(current.value.recording, now))
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
        const unfinished = yield* store.unfinishedRecordings;

        for (const id of unfinished) yield* finish(id).pipe(Effect.forkScoped);

        yield* linkPosts.pipe(Effect.forkScoped);

        for (const id of yield* store.pendingRewrites) yield* rewrite(id);

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

    const audioFor = Effect.fn("Recorder.audioFor")(function* (clip: PendingClip) {
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
        Effect.withSpan("Recorder.transcribe"),
      );
    }).pipe(
      Effect.annotateLogs({ worker: "transcription" }),
      Effect.catchTag("StoreUnavailable", (error) =>
        storeHealth
          .issue(READING_CLIPS)(error)
          .pipe(Effect.andThen(Effect.sleep(TRANSCRIPTION_IDLE))),
      ),
    );

    yield* Effect.forever(transcribeNext).pipe(Effect.forkScoped);
    yield* publishStatuses.pipe(Effect.forkScoped);

    const follow = Stream.runForEach(gateway.botPresence, onPresence);
    const poll = Effect.schedule(tick, Schedule.spaced(POLL_INTERVAL));

    yield* Effect.raceFirst(follow, poll);
  }, Effect.scoped);

  return yield* Option.match(gateway.office, {
    onNone: () => Effect.logInfo("No office voice channel, so recording is off"),
    onSome: runFor,
  }).pipe(Effect.forkScoped);
});

export const RecorderLayer = Layer.effectDiscard(startRecorder);
