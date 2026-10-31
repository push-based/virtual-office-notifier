import { Context, Effect, Layer, Option, Random } from "effect";

import { BotPosts, SlackClient, type SlackError } from "../slack/index.ts";
import { SlackConfig } from "../Config.ts";
import { HeadlineWriter } from "./HeadlineWriter.ts";
import type { OfficeEvent } from "../office/index.ts";
import { formatMessage } from "./Announcement.ts";

export class SlackNotifier extends Context.Service<
  SlackNotifier,
  {
    notify(event: OfficeEvent): Effect.Effect<boolean, SlackError>;
  }
>()("bot/announcing/SlackNotifier") {
  static readonly layerNoDeps = Layer.effect(
    SlackNotifier,
    Effect.gen(function* () {
      const { channelId } = yield* SlackConfig;
      const headlines = yield* HeadlineWriter;
      const posts = yield* BotPosts;

      const notify = Effect.fn("SlackNotifier.notify")(function* (event: OfficeEvent) {
        const variant = yield* Random.nextInt;

        const generated = yield* headlines.write(event);

        return yield* Option.match(formatMessage(event, variant, generated), {
          onNone: () => Effect.succeed(false),
          onSome: (message) =>
            posts
              .post(
                event._tag,
                { channel: channelId, ...message },
                Option.getOrNull(Option.map(generated, ({ model }) => model)),
              )
              .pipe(Effect.as(true)),
        });
      });

      return SlackNotifier.of({ notify });
    }),
  );

  static readonly layer = SlackNotifier.layerNoDeps.pipe(
    Layer.provideMerge(BotPosts.layer),
    Layer.provideMerge(SlackClient.layer),
    Layer.provide(HeadlineWriter.layer),
  );
}
