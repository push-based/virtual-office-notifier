import { NodeHttpClient } from "@effect/platform-node";
import {
  Array,
  Context,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  type LogLevel,
  Match,
  Option,
  Redacted,
  Schedule,
  Schema,
  String,
} from "effect";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/http";

import { SlackConfig } from "./Config.ts";
import type { SlackMessage } from "./SlackMessage.ts";

export class RateLimited extends Schema.TaggedError<
  RateLimited,
  { readonly brand: unique symbol }
>()("RateLimited", {
  retryAfter: Schema.Duration,
}) {}

export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", {
  status: Schema.Int,
}) {}

export class Transport extends Schema.TaggedError<Transport, { readonly brand: unique symbol }>()(
  "Transport",
  {
    cause: Schema.String,
  },
) {}

export class AccessRevoked extends Schema.TaggedError<
  AccessRevoked,
  { readonly brand: unique symbol }
>()("AccessRevoked", {
  error: Schema.String,
}) {}

export class InvalidPayload extends Schema.TaggedError<
  InvalidPayload,
  { readonly brand: unique symbol }
>()("InvalidPayload", {
  error: Schema.String,
}) {}

export const SlackErrorReason = Schema.Union([
  RateLimited,
  Unavailable,
  Transport,
  AccessRevoked,
  InvalidPayload,
]);

export type SlackErrorReason = typeof SlackErrorReason.Type;

export const isRetryable = Match.typeTags<SlackErrorReason, boolean>()({
  RateLimited: () => true,
  Unavailable: () => true,
  Transport: () => true,
  AccessRevoked: () => false,
  InvalidPayload: () => false,
});

export class SlackError extends Schema.TaggedError<SlackError, { readonly brand: unique symbol }>()(
  "SlackError",
  {
    reason: SlackErrorReason,
  },
) {
  override get message(): string {
    return isRetryable(this.reason)
      ? `Gave up posting to Slack after retries: ${this.reason._tag}`
      : `Slack rejected the post: ${this.reason._tag}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return isRetryable(this.reason) ? "Warn" : "Error";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason._tag };
  }
}

const REVOKED_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "channel_not_found",
  "not_in_channel",
]);

const DEFAULT_RETRY_AFTER = Duration.seconds(1);

const REQUEST_TIMEOUT = Duration.seconds(10);

const decodeRetryAfterSeconds = Schema.decodeUnknownOption(
  Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)),
);

const retryAfter = (headers: Headers.Headers): Duration.Duration =>
  Headers.get(headers, "retry-after").pipe(
    Option.flatMap(decodeRetryAfterSeconds),
    Option.match({ onNone: () => DEFAULT_RETRY_AFTER, onSome: Duration.seconds }),
  );

const reasonForError = (error: string, headers: Headers.Headers): SlackErrorReason => {
  if (error === "ratelimited") return RateLimited.make({ retryAfter: retryAfter(headers) });

  return REVOKED_ERRORS.has(error) ? AccessRevoked.make({ error }) : InvalidPayload.make({ error });
};

const failWith = (reason: SlackErrorReason) => Effect.fail(SlackError.make({ reason }));

const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ ok: Schema.Literal(true) }),
      Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
    ]),
  ),
);

const checkResponse =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse): Effect.Effect<S["Type"], SlackError> =>
    Effect.gen(function* () {
      const { status, headers } = response;

      if (status === 429)
        return yield* failWith(RateLimited.make({ retryAfter: retryAfter(headers) }));

      if (status >= 500) return yield* failWith(Unavailable.make({ status }));

      if (status < 200 || status >= 300)
        return yield* failWith(InvalidPayload.make({ error: `http_${status}` }));

      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

      const envelope = yield* decodeEnvelope(body).pipe(
        Effect.catch(() => failWith(InvalidPayload.make({ error: "unexpected_response" }))),
      );

      if (!envelope.ok) return yield* failWith(reasonForError(envelope.error, headers));

      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch(() => failWith(InvalidPayload.make({ error: "unexpected_response" }))),
      );
    });

const describeHttpError = ({ reason }: HttpClientError.HttpClientError): string =>
  reason.description === undefined ? reason._tag : `${reason._tag}: ${reason.description}`;

const transportError = (cause: string) => SlackError.make({ reason: Transport.make({ cause }) });

const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.setInputType<SlackError>(),
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(Schema.is(RateLimited)(input.reason) ? input.reason.retryAfter : duration),
  ),
  Schedule.while(({ input }) => isRetryable(input.reason)),
  Schedule.upTo({ times: 4 }),
  Schedule.tap(({ input, attempt, duration }) =>
    Effect.logInfo("Retrying Slack call").pipe(
      Effect.annotateLogs({
        reason: input.reason._tag,
        attempt,
        delayMs: Duration.toMillis(duration),
      }),
    ),
  ),
);

export interface OutgoingMessage extends SlackMessage {
  readonly channel: string;
  readonly threadTs?: string | undefined;
}

export interface PostedMessage {
  readonly channel: string;
  readonly ts: string;
}

export interface ThreadMessage {
  readonly ts: string;
  readonly userId: string;
  readonly text: string;
}

export interface SlackProfile {
  readonly displayName: string;
  readonly realName: string;
}

const Posted = Schema.Struct({ channel: Schema.String, ts: Schema.String });

const Nothing = Schema.Struct({});

const Replies = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      ts: Schema.String,
      user: Schema.optional(Schema.String),
      subtype: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
});

const UserInfo = Schema.Struct({
  user: Schema.Struct({
    real_name: Schema.optional(Schema.String),
    profile: Schema.optional(
      Schema.Struct({
        display_name: Schema.optional(Schema.String),
        real_name: Schema.optional(Schema.String),
      }),
    ),
  }),
});

const AuthTest = Schema.Struct({ user_id: Schema.String });

const ConnectionUrl = Schema.Struct({ url: Schema.String });

const UploadUrl = Schema.Struct({ upload_url: Schema.String, file_id: Schema.String });

export interface FileUpload {
  readonly channel: string;
  readonly threadTs: string;
  readonly filename: string;
  readonly title: string;
  readonly content: Uint8Array;
}

const THREAD_LIMIT = "1000";

interface PostBody extends SlackMessage {
  readonly channel: string;
  thread_ts?: string;
}

interface ReactionBody {
  readonly channel: string;
  readonly timestamp: string;
  readonly name: string;
}

interface CompleteUploadBody {
  readonly files: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly channel_id: string;
  readonly thread_ts: string;
}

type WriteBody = PostBody | ReactionBody | CompleteUploadBody | Readonly<Record<string, never>>;

const postBody = (message: OutgoingMessage): PostBody => {
  const body: PostBody = { channel: message.channel, text: message.text, blocks: message.blocks };

  if (message.threadTs !== undefined) body.thread_ts = message.threadTs;

  return body;
};

const nonEmpty = (...names: ReadonlyArray<string | undefined>): string =>
  Array.findFirst(
    names,
    (name): name is string => name !== undefined && String.trim(name) !== "",
  ).pipe(Option.getOrElse(() => ""));

export class SlackClient extends Context.Service<
  SlackClient,
  {
    postMessage(message: OutgoingMessage): Effect.Effect<PostedMessage, SlackError>;
    addReaction(channel: string, ts: string, emoji: string): Effect.Effect<void, SlackError>;
    uploadFile(upload: FileUpload): Effect.Effect<void, SlackError>;
    threadReplies(
      channel: string,
      threadTs: string,
    ): Effect.Effect<ReadonlyArray<ThreadMessage>, SlackError>;
    userProfile(userId: string): Effect.Effect<SlackProfile, SlackError>;
    readonly botUserId: Effect.Effect<string, SlackError>;
    readonly openConnection: Effect.Effect<string, SlackError>;
  }
>()("bot/SlackClient") {
  static readonly layerNoDeps = Layer.effect(
    SlackClient,
    Effect.gen(function* () {
      const { botToken, appToken } = yield* SlackConfig;
      const client = yield* HttpClient.HttpClient;

      const send = <S extends Schema.Decoder<unknown>>(
        method: string,
        request: HttpClientRequest.HttpClientRequest,
        token: Redacted.Redacted<string>,
        schema: S,
      ) =>
        request.pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          client.execute,
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.catchTags({
            HttpClientError: (error) => Effect.fail(error.pipe(describeHttpError, transportError)),
            TimeoutError: () => Effect.fail(transportError("Timed out after 10 seconds")),
          }),
          Effect.flatMap(checkResponse(schema)),
          Effect.retry(retrySchedule),
          Effect.withSpan(`SlackClient.${method}`),
        );

      const write = <S extends Schema.Decoder<unknown>>(
        method: string,
        body: WriteBody,
        schema: S,
      ) =>
        send(
          method,
          HttpClientRequest.post(`https://slack.com/api/${method}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
          botToken,
          schema,
        );

      const read = <S extends Schema.Decoder<unknown>>(
        method: string,
        params: Record<string, string>,
        schema: S,
      ) =>
        send(
          method,
          HttpClientRequest.get(`https://slack.com/api/${method}`).pipe(
            HttpClientRequest.setUrlParams(params),
          ),
          botToken,
          schema,
        );

      const postMessage = (message: OutgoingMessage) =>
        write("chat.postMessage", postBody(message), Posted).pipe(
          Effect.map(({ channel, ts }): PostedMessage => ({ channel, ts })),
        );

      const addReaction = (channel: string, ts: string, emoji: string) =>
        write("reactions.add", { channel, timestamp: ts, name: emoji }, Nothing).pipe(
          Effect.asVoid,
          Effect.catchIf(
            (error) =>
              Schema.is(InvalidPayload)(error.reason) && error.reason.error === "already_reacted",
            () => Effect.void,
          ),
        );

      // Slack's external upload: ask for a URL, put the bytes there, then tell
      // Slack which channel and thread the file belongs in.
      const uploadFile = Effect.fn("SlackClient.uploadFile")(function* (upload: FileUpload) {
        const { upload_url, file_id } = yield* read(
          "files.getUploadURLExternal",
          { filename: upload.filename, length: `${upload.content.length}` },
          UploadUrl,
        );

        yield* HttpClientRequest.post(upload_url).pipe(
          HttpClientRequest.setBody(
            HttpBody.uint8Array(upload.content, "application/octet-stream"),
          ),
          client.execute,
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.catchTags({
            HttpClientError: (error) => Effect.fail(error.pipe(describeHttpError, transportError)),
            TimeoutError: () => Effect.fail(transportError("Timed out after 10 seconds")),
          }),
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.void
              : response.status >= 500
                ? failWith(Unavailable.make({ status: response.status }))
                : failWith(InvalidPayload.make({ error: `upload_http_${response.status}` })),
          ),
          Effect.retry(retrySchedule),
        );

        yield* write(
          "files.completeUploadExternal",
          {
            files: [{ id: file_id, title: upload.title }],
            channel_id: upload.channel,
            thread_ts: upload.threadTs,
          },
          Nothing,
        );
      });

      const threadReplies = (channel: string, threadTs: string) =>
        read("conversations.replies", { channel, ts: threadTs, limit: THREAD_LIMIT }, Replies).pipe(
          Effect.map(({ messages }) =>
            Array.flatMap(messages, ({ ts, user, subtype, text }): ReadonlyArray<ThreadMessage> =>
              subtype === undefined && user !== undefined
                ? [{ ts, userId: user, text: text ?? "" }]
                : [],
            ),
          ),
        );

      const userProfile = (userId: string) =>
        read("users.info", { user: userId }, UserInfo).pipe(
          Effect.map(({ user }): SlackProfile => {
            const realName = nonEmpty(user.profile?.real_name, user.real_name);

            return {
              displayName: nonEmpty(user.profile?.display_name, realName, userId),
              realName,
            };
          }),
        );

      const botUserId = write("auth.test", {}, AuthTest).pipe(Effect.map(({ user_id }) => user_id));

      const openConnection = send(
        "apps.connections.open",
        HttpClientRequest.post("https://slack.com/api/apps.connections.open"),
        appToken,
        ConnectionUrl,
      ).pipe(Effect.map(({ url }) => url));

      return SlackClient.of({
        postMessage,
        addReaction,
        uploadFile,
        threadReplies,
        userProfile,
        botUserId,
        openConnection,
      });
    }),
  );

  static readonly layer = SlackClient.layerNoDeps.pipe(Layer.provide(NodeHttpClient.layerUndici));
}
