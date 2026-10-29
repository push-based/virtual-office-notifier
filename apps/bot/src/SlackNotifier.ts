import { Context, DateTime, Effect, Layer, Option, Random } from "effect";

import { SlackConfig } from "./Config.ts";
import { HeadlineWriter } from "./HeadlineWriter.ts";
import type { OfficeEvent } from "./OfficeEvent.ts";
import { type PostedMessage, type SlackError, SlackClient } from "./SlackClient.ts";
import { SlackHistory } from "./SlackHistory.ts";
import { formatMessage, type GeneratedHeadline } from "./SlackMessage.ts";

export class SlackNotifier extends Context.Service<
  SlackNotifier,
  {
    notify(event: OfficeEvent): Effect.Effect<boolean, SlackError>;
  }
>()("virtual-office-notifier/SlackNotifier") {
  static readonly layerNoDeps = Layer.effect(
    SlackNotifier,
    Effect.gen(function* () {
      const { channelId } = yield* SlackConfig;
      const slack = yield* SlackClient;
      const headlines = yield* HeadlineWriter;
      const history = yield* SlackHistory;

      const record = Effect.fnUntraced(function* (
        event: OfficeEvent,
        posted: PostedMessage,
        generated: Option.Option<GeneratedHeadline>,
      ) {
        yield* history
          .recordPost({
            channel: posted.channel,
            ts: posted.ts,
            threadTs: null,
            kind: event._tag,
            model: Option.getOrNull(Option.map(generated, ({ model }) => model)),
            postedAt: yield* DateTime.now,
          })
          .pipe(
            Effect.catchTag("HistoryUnavailable", (error) =>
              Effect.logWarning("Couldn't record the Slack post").pipe(Effect.annotateLogs({ reason: error.reason })),
            ),
          );
      });

      const notify = Effect.fn("SlackNotifier.notify")(function* (event: OfficeEvent) {
        const variant = yield* Random.nextInt;

        const generated = yield* headlines.write(event);

        return yield* Option.match(formatMessage(event, variant, generated), {
          onNone: () => Effect.succeed(false),
          onSome: (message) =>
            slack.postMessage({ channel: channelId, ...message }).pipe(
              Effect.flatMap((posted) => record(event, posted, generated)),
              Effect.as(true),
            ),
        });
      });

      return SlackNotifier.of({ notify });
    }),
  );

  static readonly layer = SlackNotifier.layerNoDeps.pipe(
    Layer.provideMerge(SlackClient.layer),
    Layer.provide(HeadlineWriter.layer),
  );
}
