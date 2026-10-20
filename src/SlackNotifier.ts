import { Context, Effect, Layer, Option, Random } from "effect";

import { SlackConfig } from "./Config.ts";
import { HeadlineWriter } from "./HeadlineWriter.ts";
import type { OfficeEvent } from "./OfficeEvent.ts";
import { type SlackError, SlackClient } from "./SlackClient.ts";
import { formatMessage } from "./SlackMessage.ts";

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

      const notify = Effect.fn("SlackNotifier.notify")(function* (event: OfficeEvent) {
        const variant = yield* Random.nextInt;

        const generated = yield* headlines.write(event);

        return yield* Option.match(formatMessage(event, variant, generated), {
          onNone: () => Effect.succeed(false),
          onSome: (message) => slack.postMessage({ channel: channelId, ...message }).pipe(Effect.as(true)),
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
