import {
  Array,
  Cause,
  DateTime,
  Duration,
  Effect,
  Equal,
  ErrorReporter,
  Option,
  pipe,
  Schedule,
  Scope,
  Semaphore,
  String,
} from "effect";
import { DEFAULT_SUMMARY_STYLE } from "recording-requests/wire";

import { ActionItemList } from "./ActionItems.ts";
import { BotPosts } from "../BotPosts.ts";
import type { OfficeLocation } from "../OfficeEvent.ts";
import {
  type PostedSummary,
  type RecordingDetails,
  RecordingStore,
  type StoreUnavailable,
  type UnlinkedPost,
} from "./RecordingStore.ts";
import { slackDidNotAct, type PostedMessage, SlackClient } from "../SlackClient.ts";
import type { SlackMessage } from "../SlackMessage.ts";
import { rewriteNote, summaryMessage } from "./SummaryPost.ts";
import { SummaryRewriter } from "./SummaryRewriter.ts";
import { RecordingWriter, type RecordingToWrite } from "./RecordingWriter.ts";
import { hasSpeech, speakersOf, transcriptText, type WrittenSummary } from "./SummaryWriter.ts";

export const FINISH_POLL = Duration.seconds(15);

export const FINISH_RETRY = Duration.minutes(10);

const FINISH_ATTEMPTS = 6;

const REWRITE_RETRY = Duration.minutes(1);

const REWRITE_ATTEMPTS = 5;

export interface Publication {
  readonly finish: (recordingId: string) => Effect.Effect<void>;
  readonly rewrite: (recordingId: string) => Effect.Effect<void>;
  readonly refresh: (recordingId: string) => Effect.Effect<void>;
  readonly catchUp: Effect.Effect<void, StoreUnavailable>;
}

interface Draft {
  readonly details: RecordingDetails;
  readonly speakers: number;
  readonly transcript: string;
  readonly summary: Option.Option<WrittenSummary>;
  readonly message: SlackMessage;
  readonly post: Option.Option<PostedSummary>;
  readonly at: DateTime.Utc;
}

const report = (error: Error) => ErrorReporter.report(Cause.fail(error));

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

export interface PublishTo {
  readonly office: OfficeLocation;
  readonly slackChannel: string;
}

const make = Effect.fnUntraced(function* ({ office, slackChannel }: PublishTo) {
  const scope = yield* Scope.Scope;
  const store = yield* RecordingStore;
  const writer = yield* RecordingWriter;
  const slack = yield* SlackClient;
  const posts = yield* BotPosts;
  const updatingPost = yield* Semaphore.make(1);

  const awaitClips = Effect.fn("Publication.awaitClips")(
    (id: string) =>
      store.outstandingClips(id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(FINISH_POLL),
          until: (outstanding) => outstanding === 0,
        }),
      ),
    Effect.asVoid,
  );

  const postedMessage = Effect.fn("Publication.postedMessage")(function* (id: string) {
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

  const refresh = (id: string) => updatePostUnless(id, () => false);

  const refreshIfChanged = (id: string, posted: SlackMessage) =>
    updatePostUnless(id, (current) => Equal.equals(current, posted));

  const pullActionItems = Effect.fn("Publication.pullActionItems")(function* (
    id: string,
    recording: RecordingToWrite,
  ) {
    const known = yield* store.actionItemsOf(id);

    if (!ActionItemList.$is("NotTried")(known)) return known;

    const pulled = yield* writer.pullActionItems(recording, yield* store.presentDuring(id));

    yield* store.recordActionItems(id, pulled, yield* DateTime.now);

    return yield* store.actionItemsOf(id);
  });

  const repullActionItems = Effect.fn("Publication.repullActionItems")(function* (
    id: string,
    recording: RecordingToWrite,
  ) {
    if (yield* store.actionItemsTouched(id)) return;

    const pulled = yield* writer.pullActionItems(recording, yield* store.presentDuring(id));

    if (Option.isNone(pulled)) return;

    yield* store.replaceActionItems(id, pulled.value, yield* DateTime.now);
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

  const rewriteOnce = Effect.fn("Publication.rewrite")(
    function* (id: string) {
      const pending = yield* store.pendingRewrite(id);

      if (Option.isNone(pending)) return;

      const { editId, editedByName, previousStyle } = pending.value;
      const details = yield* store.recordingDetails(id);

      if (Option.isNone(details)) {
        yield* store.dropRewrite(id, editId);

        return;
      }

      const recording: RecordingToWrite = {
        details: details.value,
        lines: yield* store.clipsOf(id),
        pauses: yield* store.pausesOf(id),
      };

      const style = details.value.summaryStyle;
      const summary = yield* writer.summarize(recording);

      if (Option.isNone(summary)) {
        yield* store.dropRewrite(id, editId);
        yield* Effect.logWarning("No AI model could rewrite the summary, so it stays as it was");

        return;
      }

      yield* repullActionItems(id, recording);

      yield* store.saveRewrite(id, {
        editId,
        style,
        text: summary.value.text,
        model: summary.value.model,
        writtenAt: yield* DateTime.now,
      });

      yield* refresh(id);
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

  const draftSummary = Effect.fn("Publication.draftSummary")(function* (id: string) {
    yield* awaitClips(id);

    const details = yield* store.recordingDetails(id);

    if (Option.isNone(details)) {
      yield* Effect.logWarning("The recording to finish wasn't found");

      return Option.none<Draft>();
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

      return Option.none<Draft>();
    }

    const { startedAt, stoppedAt, startedByName, title } = details.value;

    const recording: RecordingToWrite = { details: details.value, lines, pauses };
    const summary = yield* writer.summarize(recording);
    const actionItems = yield* pullActionItems(id, recording);
    const speakers = speakersOf(lines);

    const message = summaryMessage({
      office,
      startedAt,
      stoppedAt,
      startedByName,
      title,
      speakers,
      summary,
      actionItems,
    });

    return Option.some<Draft>({
      details: details.value,
      speakers: speakers.length,
      transcript,
      summary,
      message,
      post: yield* store.postedSummary(id),
      at,
    });
  });

  const postSummary = Effect.fn("Publication.postSummary")(function* (id: string, draft: Draft) {
    const posted = yield* posts
      .post(
        "Recording",
        { channel: slackChannel, ...draft.message },
        Option.getOrNull(Option.map(draft.summary, ({ model }) => model)),
      )
      .pipe(Effect.retry({ schedule: finishRetry, while: slackDidNotAct }));

    yield* store
      .recordSummaryPost(id, { slackChannelId: posted.channel, slackTs: posted.ts })
      .pipe(Effect.retry(finishRetry));

    yield* slack
      .uploadFile({
        channel: posted.channel,
        threadTs: posted.ts,
        filename: `office-recording-${fileDate(draft.details.startedAt)}.txt`,
        title: "Transcript",
        content: new TextEncoder().encode(draft.transcript),
      })
      .pipe(
        Effect.catchTag("SlackError", (error) =>
          Effect.logWarning("Couldn't attach the transcript to the summary").pipe(
            Effect.annotateLogs({ reason: error.reason._tag }),
            Effect.andThen(report(error)),
          ),
        ),
      );

    return posted;
  });

  const repostSummary = (post: PostedSummary, draft: Draft) =>
    slack.updateMessage(post.slackChannelId, post.slackTs, draft.message).pipe(
      Effect.andThen(Effect.logInfo("Updated the summary that was already posted")),
      Effect.catchTag("SlackError", (error) =>
        Effect.logWarning("Couldn't update the recording's summary in Slack").pipe(
          Effect.annotateLogs({ reason: error.reason._tag }),
          Effect.andThen(report(error)),
        ),
      ),
      Effect.as<PostedMessage>({ channel: post.slackChannelId, ts: post.slackTs }),
    );

  const publishSummary = (id: string, draft: Draft) =>
    Option.match(draft.post, {
      onNone: () => postSummary(id, draft),
      onSome: (post) => repostSummary(post, draft),
    });

  const completeFinish = Effect.fn("Publication.completeFinish")(function* (
    id: string,
    draft: Draft,
    posted: PostedMessage,
  ) {
    const { summaryStyle, agenda } = draft.details;

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
      transcript: draft.transcript,
      writtenWith: { summaryStyle, agenda },
      summary: Option.getOrNull(Option.map(draft.summary, ({ text }) => text)),
      summaryModel: Option.getOrNull(Option.map(draft.summary, ({ model }) => model)),
      slackChannelId: posted.channel,
      slackTs: posted.ts,
      slackPermalink: Option.getOrNull(permalink),
      finishedAt: draft.at,
    });

    yield* refreshIfChanged(id, draft.message);

    if (rewriting) yield* rewrite(id);

    yield* Effect.logInfo("Posted the recording summary").pipe(
      Effect.annotateLogs({
        speakers: draft.speakers,
        summarized: Option.isSome(draft.summary),
      }),
    );
  });

  const finish = Effect.fn("Publication.finish")(
    function* (id: string) {
      const draft = yield* draftSummary(id).pipe(Effect.retry(finishRetry));

      if (Option.isNone(draft)) return;

      const posted = yield* publishSummary(id, draft.value);

      yield* completeFinish(id, draft.value, posted).pipe(Effect.retry(finishRetry));
    },
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
    Effect.withSpan("Publication.linkPosts"),
  );

  const catchUp = Effect.gen(function* () {
    for (const id of yield* store.unfinishedRecordings) yield* Effect.forkIn(finish(id), scope);

    yield* Effect.forkIn(linkPosts, scope);

    for (const id of yield* store.pendingRewrites) yield* rewrite(id);
  });

  return { finish, rewrite, refresh, catchUp } satisfies Publication;
});

export const Publication = { make };
