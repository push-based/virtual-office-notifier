import { Array, Cron, DateTime, Effect, ErrorReporter, Layer, Schedule, Stream } from "effect";

import { OFFICE_TIME_ZONE, startOfOfficeDay } from "../office/index.ts";
import { type Engagement, type PostedBanter, SlackClient, SlackHistory } from "../slack/index.ts";

export const tidyingCron = Cron.make({
  minutes: [45],
  hours: [8],
  days: [],
  months: [],
  weekdays: [],
  tz: OFFICE_TIME_ZONE,
});

export type TidyOutcome = "deleted" | "kept" | "failed";

export const isQuiet = ({ reactions, replies }: Engagement): boolean =>
  reactions === 0 && replies === 0;

export const yesterday = (at: DateTime.Utc) => {
  const today = startOfOfficeDay(at);

  return { from: DateTime.subtract(today, { days: 1 }), until: today };
};

const tidyPost = Effect.fnUntraced(
  function* (post: PostedBanter) {
    const slack = yield* SlackClient;
    const history = yield* SlackHistory;

    const engagement = yield* slack.engagement(post.channel, post.ts);

    if (!isQuiet(engagement)) return "kept" satisfies TidyOutcome;

    yield* slack.deleteMessage(post.channel, post.ts);

    yield* history
      .recordDeleted(post, yield* DateTime.now)
      .pipe(
        Effect.catchTag("HistoryUnavailable", (error) =>
          Effect.logWarning("Couldn't record that the banter was deleted").pipe(
            Effect.annotateLogs({ reason: error.reason, ts: post.ts }),
          ),
        ),
      );

    return "deleted" satisfies TidyOutcome;
  },
  (effect) => Effect.withErrorReporting(effect),
  Effect.catchTag("SlackError", (error) =>
    Effect.logWarning("Couldn't tidy a bit of banter, leaving it in Slack").pipe(
      Effect.annotateLogs({ reason: error.reason._tag }),
      Effect.as("failed" satisfies TidyOutcome),
    ),
  ),
);

export const tidyQuietBanter = Effect.fn("QuietBanter.tidy")(
  function* (at: DateTime.Utc) {
    const history = yield* SlackHistory;
    const { from, until } = yesterday(at);

    const posted = yield* history.banterInSlackBetween(from, until);
    const outcomes = yield* Effect.forEach(posted, tidyPost);

    const count = (outcome: TidyOutcome) =>
      Array.filter(outcomes, (each) => each === outcome).length;

    yield* Effect.logInfo("Tidied yesterday's banter").pipe(
      Effect.annotateLogs({
        checked: outcomes.length,
        deleted: count("deleted"),
        kept: count("kept"),
        failed: count("failed"),
      }),
    );

    return outcomes;
  },
  Effect.catchTag("HistoryUnavailable", (error) =>
    Effect.logWarning("Skipped tidying banter, couldn't read the Slack history").pipe(
      Effect.annotateLogs({ reason: error.reason }),
      Effect.as<ReadonlyArray<TidyOutcome>>([]),
    ),
  ),
);

export const tidyEveryMorning = Stream.fromSchedule(Schedule.cron(tidyingCron)).pipe(
  Stream.orDie,
  Stream.runForEach(() => Effect.flatMap(DateTime.now, tidyQuietBanter)),
);

export const QuietBanterLayer = Layer.effectDiscard(
  tidyEveryMorning.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Stopped tidying banter", cause).pipe(
        Effect.andThen(ErrorReporter.report(cause)),
      ),
    ),
    Effect.forkScoped,
  ),
);
