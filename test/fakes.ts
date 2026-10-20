import { ConfigProvider, DateTime, Duration, Effect, ErrorReporter, Layer, Option, Random, Ref, type Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { ActivityRecorder } from "../src/ActivityRecorder.ts";
import { HeadlineWriter } from "../src/HeadlineWriter.ts";
import { HistoryUnavailable } from "../src/OfficeHistory.ts";
import {
  type OutgoingMessage,
  SlackClient,
  SlackError,
  type SlackErrorReason,
  type SlackProfile,
  type ThreadMessage,
} from "../src/SlackClient.ts";
import {
  type ConsideredMessage,
  type DecisionRecord,
  type LinkedMember,
  type ReactionRecord,
  type ResponderSettings,
  SlackHistory,
  type SlackPost,
} from "../src/SlackHistory.ts";
import { SlackNotifier } from "../src/SlackNotifier.ts";
import { OfficeEvent } from "../src/OfficeEvent.ts";
import type { TimedVoiceEffect } from "../src/VoiceEffect.ts";
import type { VoiceObservation } from "../src/VoiceObservation.ts";

export const SLACK_ENV = {
  SLACK_BOT_TOKEN: "xoxb-bot-secret",
  SLACK_APP_TOKEN: "xapp-app-secret",
  SLACK_CHANNEL_ID: "C-OFFICE",
};

export const opened = OfficeEvent.Opened({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png",
  guildId: "g1",
  channelId: "c1",
  at: DateTime.makeUnsafe(0),
});

// Always picks the first phrasing, so tests can assert exact text.
export const firstVariant = Effect.provideService(Random.Random, {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0,
});

export type Reply = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

export const respond =
  (status: number, body: string, headers: Record<string, string> = {}): Reply =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status, headers })));

export const slackOk = (fields: Readonly<Record<string, Schema.Json>> = {}, headers: Record<string, string> = {}): Reply =>
  respond(200, JSON.stringify({ ok: true, ...fields }), headers);

export const slackError = (error: string, headers: Record<string, string> = {}): Reply =>
  respond(200, JSON.stringify({ ok: false, error }), headers);

export const ok = slackOk({ channel: SLACK_ENV.SLACK_CHANNEL_ID, ts: "1700000000.000100" });

export const networkDown: Reply = (request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "connect ECONNREFUSED",
      }),
    }),
  );

export const hang: Reply = () => Effect.never;

export const requestText = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body instanceof HttpBody.Uint8Array ? new TextDecoder().decode(request.body.body) : "";

export const requestJson = (request: HttpClientRequest.HttpClientRequest): Schema.Json => JSON.parse(requestText(request));

// A fake Slack Web API: serves the scripted replies in order, repeating the
// last one, and records every request so tests can count attempts.
export const makeFakeSlackHttp = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);

  const client = HttpClient.make((request) =>
    Ref.modify(requests, (sent) => [sent.length, [...sent, request]]).pipe(
      Effect.flatMap((index) => (replies[index] ?? replies.at(-1) ?? ok)(request)),
    ),
  );

  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests: Ref.get(requests) };
});

const isPost = (request: HttpClientRequest.HttpClientRequest): boolean =>
  request.url === "https://slack.com/api/chat.postMessage";

export const makeFakeSlack = Effect.fnUntraced(function* (
  replies: ReadonlyArray<Reply>,
  headlines: Layer.Layer<HeadlineWriter> = HeadlineWriter.layerFixed,
  history?: Layer.Layer<SlackHistory>,
) {
  const http = yield* makeFakeSlackHttp(replies);
  const fakeHistory = yield* makeFakeSlackHistory();

  const layer = SlackNotifier.layerNoDeps.pipe(
    Layer.provideMerge(SlackClient.layerNoDeps),
    Layer.provide(http.layer),
    Layer.provide(headlines),
    Layer.provide(history ?? fakeHistory.layer),
  );

  const posts = http.requests.pipe(Effect.map((sent) => sent.filter(isPost)));

  return {
    layer,
    requests: http.requests,
    recordedPosts: fakeHistory.posts,
    postedTexts: posts.pipe(Effect.map((sent) => sent.map((request) => JSON.parse(requestText(request)).text))),
    postedBodies: posts.pipe(Effect.map((sent) => sent.map((request) => JSON.parse(requestText(request))))),
  };
});

// Collects what the program would record, without a database.
export const makeFakeRecorder = Effect.fnUntraced(function* () {
  const recorded = yield* Ref.make<ReadonlyArray<VoiceObservation>>([]);
  const effects = yield* Ref.make<ReadonlyArray<TimedVoiceEffect>>([]);

  const layer = Layer.succeed(
    ActivityRecorder,
    ActivityRecorder.of({
      record: (observation) => Ref.update(recorded, (all) => [...all, observation]),
      recordEffect: (effect) => Ref.update(effects, (all) => [...all, effect]),
    }),
  );

  return { layer, recorded: Ref.get(recorded), recordedEffects: Ref.get(effects) };
});

export const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

export interface Report {
  readonly name: string;
  readonly message: string;
  readonly severity: string;
}

// Collects what would be reported to Sentry.
export const captureReports = () => {
  const reports: Array<Report> = [];

  const layer = ErrorReporter.layer([
    ErrorReporter.make(({ error, severity }) => {
      reports.push({ name: error.name, message: error.message, severity });
    }),
  ]);

  return { reports, layer };
};

export const DEFAULT_SETTINGS: ResponderSettings = {
  enabled: true,
  clefModel: "@cf/cloudflare/clef",
  minConfidence: 0.7,
  maxRepliesPerDay: 20,
  maxReactionsPerDay: 30,
  maxRepliesPerThread: 3,
  staleAfter: Duration.minutes(2),
  clefThreadMessages: 10,
  writerThreadMessages: 50,
  reactionEmoji: ["joy", "eyes", "raised_hands"],
};

export interface FakeHistoryOptions {
  readonly settings?: ResponderSettings | undefined;
  readonly members?: ReadonlyMap<string, LinkedMember> | undefined;
}

// Keeps what would be stored in memory, and counts caps the way the database does.
export const makeFakeSlackHistory = Effect.fnUntraced(function* (options: FakeHistoryOptions = {}) {
  const settings = yield* Ref.make(Option.some(options.settings ?? DEFAULT_SETTINGS));
  const posts = yield* Ref.make<ReadonlyArray<SlackPost>>([]);
  const messages = yield* Ref.make<ReadonlyArray<ConsideredMessage>>([]);
  const decisions = yield* Ref.make<ReadonlyArray<DecisionRecord>>([]);
  const reactions = yield* Ref.make<ReadonlyArray<ReactionRecord>>([]);
  const members = options.members ?? new Map<string, LinkedMember>();

  const replies = Ref.get(posts).pipe(Effect.map((all) => all.filter((post) => post.kind === "Reply")));

  const layer = Layer.succeed(
    SlackHistory,
    SlackHistory.of({
      settings: Ref.get(settings).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.fail(new HistoryUnavailable({ reason: "No settings" })),
          onSome: Effect.succeed,
        })),
      ),
      recordPost: (post) => Ref.update(posts, (all) => [...all, post]),
      recordMessage: (message) => Ref.modify(messages, (all) => [all.length + 1, [...all, message]]),
      recordDecision: (decision) => Ref.update(decisions, (all) => [...all, decision]),
      recordReaction: (reaction) => Ref.update(reactions, (all) => [...all, reaction]),
      repliesSince: (from) =>
        replies.pipe(Effect.map((all) => all.filter((post) => DateTime.isGreaterThanOrEqualTo(post.postedAt, from)).length)),
      reactionsSince: (from) =>
        Ref.get(decisions).pipe(
          Effect.map(
            (all) =>
              all.filter((decision) => decision.outcome === "reacted" && DateTime.isGreaterThanOrEqualTo(decision.decidedAt, from))
                .length,
          ),
        ),
      repliesInThread: (channel, threadTs) =>
        replies.pipe(
          Effect.map((all) => all.filter((post) => post.channel === channel && post.threadTs === threadTs).length),
        ),
      linkMember: (slackUserId) => Effect.succeed(Option.fromUndefinedOr(members.get(slackUserId))),
    }),
  );

  return {
    layer,
    setSettings: (next: Option.Option<ResponderSettings>) => Ref.set(settings, next),
    posts: Ref.get(posts),
    messages: Ref.get(messages),
    decisions: Ref.get(decisions),
    reactions: Ref.get(reactions),
  };
});

export const BOT_USER_ID = "UBOT";

export interface FakeSlackClientOptions {
  readonly threads?: ReadonlyMap<string, ReadonlyArray<ThreadMessage>> | undefined;
  readonly profiles?: ReadonlyMap<string, SlackProfile> | undefined;
  readonly postFailure?: SlackErrorReason | undefined;
}

// Slack in memory: posts land in their thread, so later reads see them.
export const makeFakeSlackClient = Effect.fnUntraced(function* (options: FakeSlackClientOptions = {}) {
  const posts = yield* Ref.make<ReadonlyArray<OutgoingMessage>>([]);
  const reactions = yield* Ref.make<ReadonlyArray<readonly [string, string, string]>>([]);
  const threads = yield* Ref.make(new Map(options.threads ?? []));
  const profiles = options.profiles ?? new Map<string, SlackProfile>();

  const postMessage = (message: OutgoingMessage) =>
    options.postFailure === undefined
      ? Ref.modify(posts, (all) => {
          const ts = `${900 + all.length}.0`;

          return [{ ts, threadTs: message.threadTs ?? ts }, [...all, message]] as const;
        }).pipe(
          Effect.tap(({ ts, threadTs }) =>
            Ref.update(threads, (all) =>
              new Map(all).set(threadTs, [...(all.get(threadTs) ?? []), { ts, userId: BOT_USER_ID, text: message.text }]),
            ),
          ),
          Effect.map(({ ts }) => ({ channel: message.channel, ts })),
        )
      : Effect.fail(new SlackError({ reason: options.postFailure }));

  const layer = Layer.succeed(
    SlackClient,
    SlackClient.of({
      postMessage,
      addReaction: (channel, ts, emoji) => Ref.update(reactions, (all) => [...all, [channel, ts, emoji] as const]),
      threadReplies: (_channel, threadTs) => Ref.get(threads).pipe(Effect.map((all) => all.get(threadTs) ?? [])),
      userProfile: (userId) =>
        Effect.succeed(profiles.get(userId) ?? { displayName: userId, realName: "" }),
      botUserId: Effect.succeed(BOT_USER_ID),
      openConnection: Effect.never,
    }),
  );

  return {
    layer,
    posts: Ref.get(posts),
    reactions: Ref.get(reactions),
    addToThread: (threadTs: string, message: ThreadMessage) =>
      Ref.update(threads, (all) => new Map(all).set(threadTs, [...(all.get(threadTs) ?? []), message])),
  };
});
