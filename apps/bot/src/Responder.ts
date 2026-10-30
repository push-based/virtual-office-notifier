import {
  Array,
  Cause,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  pipe,
  Queue,
  Redacted,
  Ref,
  Schedule,
  Stream,
  String,
} from "effect";

import { isBanterTime, periodRange, startOfOfficeDay } from "./Banter.ts";
import { SlackConfig } from "./Config.ts";
import type { BanterContext } from "./OfficeEvent.ts";
import { OfficeHistory } from "./OfficeHistory.ts";
import { type ClefState, ReplyDecider } from "./ReplyDecider.ts";
import { type ThreadLine, ReplyWriter } from "./ReplyWriter.ts";
import { isRetryable, type SlackError, SlackClient, type ThreadMessage } from "./SlackClient.ts";
import {
  type ActivityContext,
  eligibleActivity,
  type Envelope,
  SlackActivity,
} from "./SlackEvent.ts";
import {
  type ClefVerdict,
  type DecisionReason,
  type Outcome,
  type ResponderSettings,
  SlackHistory,
} from "./SlackHistory.ts";
import { replyMessage } from "./SlackMessage.ts";
import { SlackSocket } from "./SlackSocket.ts";

export const MAX_MESSAGE_LENGTH = 1000;

const MAX_RETRY_DELAY = Duration.minutes(5);

type IncomingMessage = Extract<SlackActivity, { readonly _tag: "Message" }>;

interface Pending {
  readonly message: IncomingMessage;
  readonly receivedAt: DateTime.Utc;
}

interface Considered {
  readonly messageId: number;
  readonly who: string;
}

interface Verdict {
  readonly outcome: Outcome;
  readonly reason: DecisionReason;
  readonly clef: Option.Option<ClefVerdict>;
}

const verdictOf = (
  outcome: Outcome,
  reason: DecisionReason,
  clef: Option.Option<ClefVerdict> = Option.none(),
): Verdict => ({
  outcome,
  reason,
  clef,
});

const mailboxOf = ({ threadTs, isMention }: IncomingMessage): string =>
  isMention ? `${threadTs}/mention` : threadTs;

const truncate = (text: string): string =>
  text.length > MAX_MESSAGE_LENGTH ? `${pipe(text, String.slice(0, MAX_MESSAGE_LENGTH))}…` : text;

const isBefore = (ts: string, than: string): boolean => Number(ts) < Number(than);

const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<SlackError>(),
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, MAX_RETRY_DELAY))),
  Schedule.tap(({ input, attempt }) =>
    Effect.logWarning("Couldn't find out who the Slack bot is, retrying").pipe(
      Effect.annotateLogs({ reason: input.reason._tag, attempt }),
      Effect.andThen(ErrorReporter.report(Cause.fail(input))),
    ),
  ),
);

const logSlackError = (error: SlackError) =>
  (isRetryable(error.reason)
    ? Effect.logWarning("Gave up answering on Slack after retries", error.reason)
    : Effect.logError("Slack rejected the answer", error.reason)
  ).pipe(
    Effect.annotateLogs({ outcome: "failed", reason: error.reason._tag }),
    Effect.andThen(ErrorReporter.report(Cause.fail(error))),
  );

export const respondToSlack = Effect.gen(function* () {
  const { channelId } = yield* SlackConfig;
  const slack = yield* SlackClient;
  const socket = yield* SlackSocket;
  const history = yield* SlackHistory;
  const decider = yield* ReplyDecider;
  const writer = yield* ReplyWriter;
  const office = yield* OfficeHistory;

  const botUserId = yield* slack.botUserId.pipe(Effect.retry(retrySchedule), Effect.orDie);
  const activityContext: ActivityContext = { botUserId, officeChannelId: channelId };

  const waiting = yield* Ref.make<ReadonlyMap<string, Pending>>(new Map());
  const wake = yield* Queue.dropping<void>(1);

  const enabledSettings = history.settings.pipe(
    Effect.map((settings) => (settings.enabled ? Option.some(settings) : Option.none())),
    Effect.catchTag("HistoryUnavailable", (error) =>
      Effect.logWarning("Couldn't read the responder settings, so not responding").pipe(
        Effect.annotateLogs({ reason: error.reason }),
        Effect.as(Option.none<ResponderSettings>()),
      ),
    ),
  );

  const nameOf = Effect.fnUntraced(function* (userId: string) {
    const profile = yield* slack
      .userProfile(userId)
      .pipe(Effect.orElseSucceed(() => ({ displayName: userId, realName: "" })));

    const linked = yield* history
      .linkMember(userId, profile.realName)
      .pipe(Effect.orElseSucceed(() => Option.none()));

    return { displayName: profile.displayName, linked };
  });

  const consider = Effect.fnUntraced(function* (pending: Pending) {
    const { message, receivedAt } = pending;
    const { displayName, linked } = yield* nameOf(message.userId);

    const messageId = yield* history.recordMessage({
      channel: message.channel,
      ts: message.ts,
      threadTs: message.threadTs,
      userId: message.userId,
      displayName,
      memberUserId: Option.getOrNull(Option.map(linked, ({ memberUserId }) => memberUserId)),
      text: message.text,
      isMention: message.isMention,
      receivedAt,
    });

    return {
      messageId,
      who: Option.match(linked, { onNone: () => displayName, onSome: ({ name }) => name }),
    };
  });

  const recordDecision = Effect.fn("Responder.recordDecision")(function* (
    considered: Considered,
    settings: ResponderSettings,
    verdict: Verdict,
  ) {
    yield* history.recordDecision({
      messageId: considered.messageId,
      decidedAt: yield* DateTime.now,
      clef: verdict.clef,
      minConfidence: settings.minConfidence,
      maxRepliesPerDay: settings.maxRepliesPerDay,
      maxReactionsPerDay: settings.maxReactionsPerDay,
      maxRepliesPerThread: settings.maxRepliesPerThread,
      outcome: verdict.outcome,
      reason: verdict.reason,
    });

    yield* Effect.logInfo("Considered a Slack message").pipe(
      Effect.annotateLogs({ outcome: verdict.outcome, reason: verdict.reason }),
    );
  });

  const lineFor = Effect.fnUntraced(function* (
    { userId, text }: ThreadMessage,
    botName: string,
    names: Map<string, string>,
  ) {
    if (userId === botUserId) return { who: botName, text: truncate(text) };

    const known = names.get(userId);

    if (known !== undefined) return { who: known, text: truncate(text) };

    const { displayName, linked } = yield* nameOf(userId);
    const who = Option.match(linked, { onNone: () => displayName, onSome: ({ name }) => name });

    names.set(userId, who);

    return { who, text: truncate(text) };
  });

  const linesFor = (
    messages: ReadonlyArray<ThreadMessage>,
    botName: string,
    names: Map<string, string>,
  ) => Effect.forEach(messages, (message) => lineFor(message, botName, names));

  const readThread = Effect.fnUntraced(function* (message: IncomingMessage) {
    const all = yield* slack.threadReplies(message.channel, message.threadTs);
    const earlier = Array.filter(all, ({ ts }) => isBefore(ts, message.ts));
    const [first, ...rest] = earlier;

    return first?.ts === message.threadTs
      ? { root: Option.some(first), rest }
      : { root: Option.none(), rest: earlier };
  });

  const officeNow = Effect.fnUntraced(function* (at: DateTime.Utc) {
    const { from, until } = periodRange("ThisWeek", at);
    const activity = yield* office.latestActivityBetween(from, until);
    const present = yield* office.presentSinceBotStarted;

    return {
      at,
      period: "ThisWeek",
      activityOldestFirst: activity.entriesOldestFirst,
      olderEntriesLeftOut: activity.olderEntriesLeftOut,
      present,
    } satisfies BanterContext;
  });

  const messageLine = (message: IncomingMessage, who: string): ThreadLine => ({
    who,
    text: truncate(pipe(message.text, String.replaceAll(`<@${botUserId}>`, ""), String.trim)),
  });

  const reply = Effect.fnUntraced(function* (
    message: IncomingMessage,
    who: string,
    settings: ResponderSettings,
    at: DateTime.Utc,
  ) {
    const names = new Map<string, string>();
    const { root, rest } = yield* readThread(message);
    const kept = rest.slice(Math.max(0, rest.length - settings.writerThreadMessages));

    const written = yield* writer.write({
      office: yield* officeNow(at),
      thread: yield* linesFor([...Option.toArray(root), ...kept], "You", names),
      earlierLeftOut: rest.length - kept.length,
      message: messageLine(message, who),
    });

    if (Option.isNone(written)) return false;

    const { text, model } = written.value;

    const posted = yield* slack.postMessage({
      channel: message.channel,
      threadTs: message.threadTs,
      ...replyMessage(text, model),
    });

    yield* history.recordPost({
      channel: posted.channel,
      ts: posted.ts,
      threadTs: message.threadTs,
      kind: "Reply",
      model,
      postedAt: yield* DateTime.now,
    });

    return true;
  });

  const clefState = Effect.fnUntraced(function* (
    message: IncomingMessage,
    who: string,
    settings: ResponderSettings,
  ) {
    const names = new Map<string, string>();
    const { root, rest } = yield* readThread(message);
    const [botPost] = yield* linesFor(Option.toArray(root), "the bot", names);

    return {
      botPost: botPost ?? { who: "the bot", text: "" },
      earlier: yield* linesFor(
        rest.slice(Math.max(0, rest.length - settings.clefThreadMessages)),
        "the bot",
        names,
      ),
      message: messageLine(message, who),
    } satisfies ClefState;
  });

  const replied = (
    succeeded: boolean,
    reason: DecisionReason,
    clef: Option.Option<ClefVerdict> = Option.none(),
  ) => (succeeded ? verdictOf("replied", reason, clef) : verdictOf("ignored", "no_model", clef));

  const decide = Effect.fnUntraced(function* (
    pending: Pending,
    who: string,
    settings: ResponderSettings,
  ) {
    const { message, receivedAt } = pending;
    const now = yield* DateTime.now;

    if (!isBanterTime(now)) return verdictOf("ignored", "outside_hours");

    if (Duration.isGreaterThan(DateTime.distance(receivedAt, now), settings.staleAfter)) {
      return verdictOf("ignored", "stale");
    }

    const today = startOfOfficeDay(now);
    const repliesToday = yield* history.repliesSince(today);
    const reactionsToday = yield* history.reactionsSince(today);
    const repliesInThread = yield* history.repliesInThread(message.channel, message.threadTs);

    const replyBlocked: Option.Option<DecisionReason> =
      repliesToday >= settings.maxRepliesPerDay
        ? Option.some("daily_cap")
        : repliesInThread >= settings.maxRepliesPerThread
          ? Option.some("thread_cap")
          : Option.none();

    const canReact = reactionsToday < settings.maxReactionsPerDay;

    if (message.isMention) {
      return Option.isSome(replyBlocked)
        ? verdictOf("ignored", replyBlocked.value)
        : replied(yield* reply(message, who, settings, now), "mention");
    }

    if (Option.isSome(replyBlocked) && !canReact) return verdictOf("ignored", "daily_cap");

    const decided = yield* decider.decide(yield* clefState(message, who, settings), settings).pipe(
      Effect.asSome,
      Effect.catchTag("ClefFailed", (error) =>
        Effect.logWarning("Clef couldn't decide, so ignoring the message").pipe(
          Effect.annotateLogs({ reason: error.reason }),
          Effect.andThen(
            error.reason === "NotConfigured"
              ? Effect.void
              : ErrorReporter.report(Cause.fail(error)),
          ),
          Effect.as(Option.none()),
        ),
      ),
    );

    if (Option.isNone(decided)) return verdictOf("ignored", "clef_failed");

    const { verdict, judgement } = decided.value;
    const clef = Option.some(verdict);

    switch (judgement.act) {
      case "ignore":
        return verdictOf("ignored", judgement.reason, clef);
      case "react":
        if (!canReact) return verdictOf("ignored", "daily_cap", clef);

        yield* slack.addReaction(message.channel, message.ts, verdict.reaction);

        return verdictOf("reacted", "clef", clef);
      case "reply":
        return Option.isSome(replyBlocked)
          ? verdictOf("ignored", replyBlocked.value, clef)
          : replied(yield* reply(message, who, settings, now), "clef", clef);
    }
  });

  const handle = Effect.fn("Responder.handle")(
    function* (pending: Pending) {
      const settings = yield* enabledSettings;

      if (Option.isNone(settings)) return;

      const considered = yield* consider(pending);
      const verdict = yield* decide(pending, considered.who, settings.value);

      yield* recordDecision(considered, settings.value, verdict);
    },
    Effect.catchTags({
      SlackError: logSlackError,
      HistoryUnavailable: (error) =>
        Effect.logWarning("Couldn't use the database, so skipped a Slack message").pipe(
          Effect.annotateLogs({ reason: error.reason }),
        ),
    }),
    Effect.catchCause((cause) =>
      Effect.logError("Couldn't handle a Slack message", cause).pipe(
        Effect.andThen(ErrorReporter.report(cause)),
      ),
    ),
    (effect, pending) =>
      Effect.annotateLogs(effect, { slackUserId: Redacted.make(pending.message.userId) }),
  );

  const skipSuperseded = Effect.fn("Responder.skipSuperseded")(
    function* (pending: Pending) {
      const settings = yield* enabledSettings;

      if (Option.isNone(settings)) return;

      const considered = yield* consider(pending);

      yield* recordDecision(considered, settings.value, verdictOf("ignored", "superseded"));
    },
    Effect.catchTag("HistoryUnavailable", (error) =>
      Effect.logWarning("Couldn't record a superseded Slack message").pipe(
        Effect.annotateLogs({ reason: error.reason }),
      ),
    ),
  );

  const enqueue = Effect.fnUntraced(function* (message: IncomingMessage) {
    const pending: Pending = { message, receivedAt: yield* DateTime.now };
    const key = mailboxOf(message);

    const displaced = yield* Ref.modify(waiting, (all) => [
      Option.fromUndefinedOr(all.get(key)),
      new Map(all).set(key, pending),
    ]);

    yield* Queue.offer(wake, undefined);

    if (Option.isSome(displaced)) yield* skipSuperseded(displaced.value);
  });

  const recordReaction = Effect.fnUntraced(function* (
    reaction: Extract<SlackActivity, { readonly _tag: "Reaction" }>,
  ) {
    const settings = yield* enabledSettings;

    if (Option.isNone(settings)) return;

    yield* history
      .recordReaction({
        channel: reaction.channel,
        itemTs: reaction.itemTs,
        userId: reaction.userId,
        emoji: reaction.emoji,
        added: reaction.added,
        eventTs: reaction.eventTs,
        receivedAt: yield* DateTime.now,
      })
      .pipe(
        Effect.catchTag("HistoryUnavailable", (error) =>
          Effect.logWarning("Couldn't record a Slack reaction").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          ),
        ),
      );
  });

  const route = (envelope: Envelope) =>
    Option.match(eligibleActivity(envelope, activityContext), {
      onNone: () => Effect.void,
      onSome: SlackActivity.$match({ Message: enqueue, Reaction: recordReaction }),
    });

  const nextWaiting = Ref.modify(
    waiting,
    (all): readonly [Option.Option<Pending>, ReadonlyMap<string, Pending>] => {
      const first = all.entries().next();

      if (first.done === true) return [Option.none(), all];

      const [key, pending] = first.value;
      const rest = new Map(all);

      rest.delete(key);

      return [Option.some(pending), rest];
    },
  );

  const drain: Effect.Effect<void> = nextWaiting.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (pending) => handle(pending).pipe(Effect.andThen(drain)),
      }),
    ),
  );

  const lane = Queue.take(wake).pipe(Effect.andThen(drain), Effect.forever);

  yield* Effect.logInfo("Listening to Slack");

  yield* Effect.all([lane, Stream.runForEach(socket.envelopes, route)], {
    concurrency: "unbounded",
    discard: true,
  });
});

export const ResponderLayer = Layer.effectDiscard(
  respondToSlack.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Stopped responding on Slack", cause).pipe(
        Effect.andThen(ErrorReporter.report(cause)),
      ),
    ),
    Effect.forkScoped,
  ),
).pipe(Layer.provide(Layer.mergeAll(SlackSocket.layer, ReplyDecider.layer, ReplyWriter.layer)));
