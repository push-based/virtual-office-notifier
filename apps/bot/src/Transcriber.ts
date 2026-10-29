import { NodeHttpClient } from "@effect/platform-node";
import { Buffer } from "node:buffer";

import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { AiConfig, RecordingConfig } from "./Config.ts";

export const TranscriptionFailure = Schema.Literals(["DailyLimit", "Unavailable", "Rejected", "Unreadable"]);

export type TranscriptionFailure = typeof TranscriptionFailure.Type;

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()("TranscriptionError", {
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
  errors: Schema.optional(Schema.Array(Schema.Struct({ code: CloudflareCode, message: Schema.optional(Schema.String) }))),
  result: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
});

const decodeRunResponse = Schema.decodeUnknownOption(Schema.fromJsonString(RunResponse));

const failure = (failure: TranscriptionFailure, detail: string) =>
  Effect.fail(new TranscriptionError({ failure, detail }));

const failureForStatus = (status: number, body: string): TranscriptionError => {
  const decoded = decodeRunResponse(body);
  const dailyLimit = Option.isSome(decoded) && (decoded.value.errors ?? []).some(({ code }) => code === CLOUDFLARE_DAILY_LIMIT);

  if (dailyLimit) return new TranscriptionError({ failure: "DailyLimit", detail: "Workers AI's daily allocation is used up" });

  if (status === 429 || status >= 500) return new TranscriptionError({ failure: "Unavailable", detail: `HTTP ${status}` });

  return new TranscriptionError({ failure: "Rejected", detail: `HTTP ${status}: ${body.slice(0, 200)}` });
};

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
>()("virtual-office-notifier/Transcriber") {
  static readonly layerOptions = (options: TranscriberOptions) =>
    Layer.effect(
      Transcriber,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const url = `https://api.cloudflare.com/client/v4/accounts/${Redacted.value(options.accountId)}/ai/run/${options.model}`;

        const transcribe = Effect.fn("Transcriber.transcribe")(function* (audio: Uint8Array) {
          const response = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.bearerToken(Redacted.value(options.apiToken)),
            HttpClientRequest.bodyJsonUnsafe({
              audio: Buffer.from(audio).toString("base64"),
              task: "transcribe",
              language: options.language,
            }),
            client.execute,
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError((error) => new TranscriptionError({ failure: "Unavailable", detail: String(error) })),
          );

          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

          if (response.status < 200 || response.status >= 300) return yield* failureForStatus(response.status, body);

          const decoded = decodeRunResponse(body);

          if (Option.isNone(decoded)) return yield* failure("Unreadable", body.slice(0, 200));

          if (!decoded.value.success) return yield* failureForStatus(response.status, body);

          const text = decoded.value.result?.text;

          if (text === undefined) return yield* failure("Unreadable", "The reply has no text");

          return { text: text.trim(), model: options.model };
        });

        return Transcriber.of({ transcribe });
      }),
    );

  static readonly layerNone = Layer.succeed(
    Transcriber,
    Transcriber.of({
      transcribe: () => Effect.fail(new TranscriptionError({ failure: "Unavailable", detail: "No transcriber is configured" })),
    }),
  );

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { cloudflare } = yield* AiConfig;
      const { whisperModel, language } = yield* RecordingConfig;

      return Option.match(Option.all({ accountId: cloudflare.accountId, apiToken: cloudflare.apiToken }), {
        onNone: () =>
          Layer.effectDiscard(Effect.logInfo("Cloudflare isn't configured, so recordings aren't transcribed")).pipe(
            Layer.provideMerge(Transcriber.layerNone),
          ),
        onSome: ({ accountId, apiToken }) => Transcriber.layerOptions({ accountId, apiToken, model: whisperModel, language }),
      });
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici));
}
