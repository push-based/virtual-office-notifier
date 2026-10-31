import { NodeHttpClient } from "@effect/platform-node";
import { Buffer } from "node:buffer";

import { Array, Context, Duration, Effect, Layer, Option, Redacted, Schema, String } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { AiConfig, RecordingConfig } from "../Config.ts";

export const TranscriptionFailure = Schema.Literals([
  "DailyLimit",
  "Unavailable",
  "Rejected",
  "Unreadable",
]);

export type TranscriptionFailure = typeof TranscriptionFailure.Type;

export class TranscriptionError extends Schema.TaggedError<
  TranscriptionError,
  { readonly brand: unique symbol }
>()("TranscriptionError", {
  failure: TranscriptionFailure,
  detail: Schema.String,
}) {}

export interface Transcript {
  readonly text: string;
  readonly model: string;
}

const REQUEST_TIMEOUT = Duration.minutes(2);

const CLOUDFLARE_DAILY_LIMIT = 4006;

const CloudflareCode = Schema.Union([Schema.Finite, Schema.FiniteFromString]);

const RunResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ code: CloudflareCode, message: Schema.optional(Schema.String) })),
  ),
  result: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
});

type RunResponse = typeof RunResponse.Type;

const decodeRunResponse = HttpClientResponse.schemaBodyJson(RunResponse);

const failure = (failure: TranscriptionFailure, detail: string) =>
  Effect.fail(TranscriptionError.make({ failure, detail }));

const excerpt = String.slice(0, 200);

const bodyOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(Effect.orElseSucceed(() => ""));

const dailyLimitReached = (run: Option.Option<RunResponse>): boolean =>
  Option.exists(run, ({ errors }) =>
    Array.some(errors ?? [], ({ code }) => code === CLOUDFLARE_DAILY_LIMIT),
  );

const refusal = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, TranscriptionError> {
  const body = yield* bodyOf(response);
  const run = yield* decodeRunResponse(response).pipe(Effect.option);
  const { status } = response;

  if (dailyLimitReached(run))
    return yield* failure("DailyLimit", "Workers AI's daily allocation is used up");

  if (status === 429 || status >= 500) return yield* failure("Unavailable", `HTTP ${status}`);

  return yield* failure("Rejected", `HTTP ${status}: ${excerpt(body)}`);
});

const unreadable = (response: HttpClientResponse.HttpClientResponse) =>
  bodyOf(response).pipe(Effect.flatMap((body) => failure("Unreadable", excerpt(body))));

const transcribed = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<string, TranscriptionError> {
  const run = yield* decodeRunResponse(response).pipe(Effect.catch(() => unreadable(response)));

  if (!run.success) return yield* refusal(response);

  const text = run.result?.text;

  if (text === undefined) return yield* failure("Unreadable", "The reply has no text");

  return text;
});

const readTranscript = HttpClientResponse.matchStatus({
  "2xx": transcribed,
  orElse: refusal,
});

export interface TranscriberOptions {
  readonly accountId: Redacted.Redacted<string>;
  readonly apiToken: Redacted.Redacted<string>;
  readonly model: string;
  readonly language: string;
}

export class Transcriber extends Context.Service<
  Transcriber,
  {
    transcribe(audio: Uint8Array): Effect.Effect<Transcript, TranscriptionError>;
  }
>()("bot/recording/Transcriber") {
  static readonly layerOptions = (options: TranscriberOptions) =>
    Layer.effect(
      Transcriber,
      Effect.gen(function* () {
        const client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.bearerToken(options.apiToken)),
        );

        const url = `https://api.cloudflare.com/client/v4/accounts/${Redacted.value(options.accountId)}/ai/run/${options.model}`;

        const transcribe = Effect.fn("Transcriber.transcribe")(function* (audio: Uint8Array) {
          const text = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              audio: Buffer.from(audio).toString("base64"),
              task: "transcribe",
              language: options.language,
            }),
            client.execute,
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError((error) =>
              TranscriptionError.make({ failure: "Unavailable", detail: globalThis.String(error) }),
            ),
            Effect.flatMap(readTranscript),
          );

          return { text: String.trim(text), model: options.model };
        });

        return Transcriber.of({ transcribe });
      }),
    );

  static readonly layerNone = Layer.succeed(
    Transcriber,
    Transcriber.of({
      transcribe: () =>
        Effect.fail(
          TranscriptionError.make({
            failure: "Unavailable",
            detail: "No transcriber is configured",
          }),
        ),
    }),
  );

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { cloudflare } = yield* AiConfig;
      const { whisperModel, language } = yield* RecordingConfig;

      return Option.match(
        Option.all({ accountId: cloudflare.accountId, apiToken: cloudflare.apiToken }),
        {
          onNone: () =>
            Layer.effectDiscard(
              Effect.logInfo("Cloudflare isn't configured, so recordings aren't transcribed"),
            ).pipe(Layer.provideMerge(Transcriber.layerNone)),
          onSome: ({ accountId, apiToken }) =>
            Transcriber.layerOptions({ accountId, apiToken, model: whisperModel, language }),
        },
      );
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici));
}
