import { Context, DateTime, Effect, Layer } from "effect";

import {
  type OutgoingMessage,
  type PostedMessage,
  SlackClient,
  type SlackError,
} from "./SlackClient.ts";
import { type PostKind, SlackHistory } from "./SlackHistory.ts";

export class BotPosts extends Context.Service<
  BotPosts,
  {
    post(
      kind: PostKind,
      message: OutgoingMessage,
      model: string | null,
    ): Effect.Effect<PostedMessage, SlackError>;
  }
>()("bot/slack/BotPosts") {
  static readonly layer = Layer.effect(
    BotPosts,
    Effect.gen(function* () {
      const slack = yield* SlackClient;
      const history = yield* SlackHistory;

      const keep = Effect.fnUntraced(function* (
        kind: PostKind,
        message: OutgoingMessage,
        posted: PostedMessage,
        model: string | null,
      ) {
        yield* history
          .recordPost({
            channel: posted.channel,
            ts: posted.ts,
            threadTs: message.threadTs ?? null,
            kind,
            model,
            postedAt: yield* DateTime.now,
          })
          .pipe(
            Effect.catchTag("HistoryUnavailable", (error) =>
              Effect.logWarning("Couldn't record the Slack post").pipe(
                Effect.annotateLogs({ reason: error.reason, kind }),
              ),
            ),
          );
      });

      const post = Effect.fn("BotPosts.post")(function* (
        kind: PostKind,
        message: OutgoingMessage,
        model: string | null,
      ) {
        const posted = yield* slack.postMessage(message);

        yield* keep(kind, message, posted, model);

        return posted;
      });

      return BotPosts.of({ post });
    }),
  );
}
