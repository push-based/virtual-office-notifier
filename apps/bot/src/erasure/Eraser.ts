import {
  Array,
  Cause,
  Context,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";

import { type ArchiveError, ClipArchive, type StoreUnavailable } from "../recording/index.ts";
import {
  InvalidPayload,
  isRetryable,
  type SlackError,
  SlackClient,
  type FetchedMessage,
} from "../slack/index.ts";
import { type Erased, ErasureStore, type Subject } from "./ErasureStore.ts";
import type { Scrubber } from "./Scrub.ts";

export type PrepareError = StoreUnavailable | ArchiveError | SlackError;

const unchangeable = (error: SlackError): boolean => Schema.is(InvalidPayload)(error.reason);

const unreadable = (error: SlackError): boolean => !isRetryable(error.reason);

const audioRetry = Schedule.exponential("2 seconds").pipe(Schedule.upTo({ times: 4 }));

export class Eraser extends Context.Service<
  Eraser,
  {
    prepare(userId: string): Effect.Effect<void, PrepareError>;
    erase(userId: string): Effect.Effect<Erased, StoreUnavailable>;
    removeAudio(paths: ReadonlyArray<string>): Effect.Effect<void>;
    sweep(userId: string): Effect.Effect<void>;
  }
>()("bot/erasure/Eraser") {
  static readonly layerNoDeps = Layer.effect(
    Eraser,
    Effect.gen(function* () {
      const store = yield* ErasureStore;
      const slack = yield* SlackClient;
      const archive = yield* ClipArchive;

      const mentionsIn = (scrubber: Scrubber, post: FetchedMessage): boolean =>
        scrubber.mentions(post.text) || Option.exists(post.blocks, scrubber.touches);

      const rewrite = (scrubber: Scrubber, channel: string, post: FetchedMessage) =>
        slack
          .rewriteMessage(
            channel,
            post.ts,
            scrubber.text(post.text),
            Option.map(post.blocks, scrubber.blocks),
          )
          .pipe(
            Effect.as(1),
            Effect.catchIf(unchangeable, (error) =>
              Effect.logError("Couldn't take a name out of a Slack post").pipe(
                Effect.annotateLogs({ reason: error.reason._tag, channel, ts: post.ts }),
                Effect.andThen(ErrorReporter.report(Cause.fail(error))),
                Effect.as(0),
              ),
            ),
          );

      const scrubPosts = (
        scrubber: Scrubber,
        botUserId: string,
        channel: string,
        posts: Stream.Stream<FetchedMessage, SlackError>,
      ) =>
        posts.pipe(
          Stream.filter((post) => post.userId === botUserId && mentionsIn(scrubber, post)),
          Stream.mapEffect((post) => rewrite(scrubber, channel, post)),
          Stream.runFold(
            () => 0,
            (total, rewritten) => total + rewritten,
          ),
          Effect.catchIf(unreadable, (error) =>
            Effect.logError("Couldn't read the bot's Slack posts to take a name out").pipe(
              Effect.annotateLogs({ reason: error.reason._tag, channel }),
              Effect.andThen(ErrorReporter.report(Cause.fail(error))),
              Effect.as(0),
            ),
          ),
        );

      const scrubSlack = Effect.fn("Eraser.scrubSlack")(function* (subject: Subject) {
        if (!Array.isReadonlyArrayNonEmpty(subject.scrubber.needles)) return;

        const botUserId = yield* slack.botUserId;
        const { channels, threads } = yield* store.botPostings;

        const inChannels = yield* Effect.forEach(channels, (channel) =>
          scrubPosts(subject.scrubber, botUserId, channel, slack.channelPosts(channel)),
        );

        const inThreads = yield* Effect.forEach(threads, ({ channel, ts }) =>
          scrubPosts(subject.scrubber, botUserId, channel, slack.threadPosts(channel, ts)),
        );

        yield* Effect.logInfo("Took a name out of the bot's Slack posts").pipe(
          Effect.annotateLogs({
            rewritten: Array.reduce([...inChannels, ...inThreads], 0, (total, n) => total + n),
          }),
        );
      });

      const removeEach = (paths: ReadonlyArray<string>) =>
        Effect.forEach(paths, archive.remove, { concurrency: 4, discard: true });

      const prepare = Effect.fn("Eraser.prepare")(function* (userId: string) {
        const subject = yield* store.subject(userId);

        yield* scrubSlack(subject);
        yield* removeEach(subject.objectPaths);
      });

      const erase = Effect.fn("Eraser.erase")(function* (userId: string) {
        return yield* store.erase(yield* store.subject(userId));
      });

      const removeAudio = (paths: ReadonlyArray<string>) =>
        Effect.forEach(
          paths,
          (path) =>
            archive.remove(path).pipe(
              Effect.retry(audioRetry),
              Effect.catchTag("ArchiveError", (error) =>
                Effect.logError("Couldn't delete audio found while erasing someone's data").pipe(
                  Effect.annotateLogs({ reason: error.reason, path }),
                  Effect.andThen(ErrorReporter.report(Cause.fail(error))),
                ),
              ),
            ),
          { concurrency: 4, discard: true },
        );

      const sweep = (userId: string) =>
        store
          .sweep(userId)
          .pipe(
            Effect.catchTag("StoreUnavailable", (error) =>
              Effect.logError("Couldn't sweep up after erasing someone's data").pipe(
                Effect.annotateLogs({ reason: error.reason }),
                Effect.andThen(ErrorReporter.report(Cause.fail(error))),
              ),
            ),
          );

      return Eraser.of({ prepare, erase, removeAudio, sweep });
    }),
  );

  static readonly layer = Eraser.layerNoDeps.pipe(Layer.provide(ClipArchive.layer));
}
