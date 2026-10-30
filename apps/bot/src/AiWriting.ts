import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import {
  Array,
  type Cause,
  type Config,
  Effect,
  ExecutionPlan,
  Layer,
  Match,
  Option,
  Random,
  Redacted,
  Schema,
} from "effect";
import { AiError, LanguageModel, Model, type Response } from "effect/ai";
import type { HttpClient } from "effect/http";

import { AiConfig } from "./Config.ts";

const MODEL_TIMEOUT = "1 minute";

export class UnusableHeadline extends Schema.TaggedError<
  UnusableHeadline,
  { readonly brand: unique symbol }
>()("UnusableHeadline", {
  text: Schema.String,
}) {}

export type WritingError = AiError.AiError | Cause.TimeoutError | UnusableHeadline;

export interface Brief<A> {
  readonly prompt: string;
  readonly request: string;
  readonly reply: Schema.Decoder<A>;
  readonly maxOutputTokens?: number;
}

export interface Written<A> {
  readonly value: A;
  readonly model: string;
}

const decodeOpenRouterDailyLimit = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        metadata: Schema.Struct({ limit_source: Schema.Literal("openrouter_free_tier_daily") }),
      }),
    }),
  ),
);

const CLOUDFLARE_DAILY_LIMIT = 4006;

const CloudflareCode = Schema.Union([Schema.Finite, Schema.FiniteFromString]);

const decodeCloudflareDailyLimit = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ errors: Schema.Array(Schema.Struct({ code: CloudflareCode })) }),
      Schema.Struct({ error: Schema.Struct({ code: CloudflareCode }) }),
    ]),
  ),
);

const isCloudflareDailyLimit = (body: string): boolean =>
  Option.match(decodeCloudflareDailyLimit(body), {
    onNone: () => false,
    onSome: (decoded) =>
      "errors" in decoded
        ? Array.some(decoded.errors, ({ code }) => code === CLOUDFLARE_DAILY_LIMIT)
        : decoded.error.code === CLOUDFLARE_DAILY_LIMIT,
  });

const httpBody = (error: AiError.AiError): string | undefined =>
  "http" in error.reason ? error.reason.http?.body : undefined;

export const isDailyLimit = (error: WritingError): boolean => {
  if (!Schema.is(AiError.AiError)(error)) return false;

  const body = httpBody(error);

  if (body === undefined) return false;

  return (
    (Schema.is(AiError.RateLimitError)(error.reason) &&
      Option.isSome(decodeOpenRouterDailyLimit(body))) ||
    isCloudflareDailyLimit(body)
  );
};

export const failureReason = Match.typeTags<WritingError, string>()({
  AiError: (error) => (isDailyLimit(error) ? "DailyLimit" : error.reason._tag),
  TimeoutError: () => "Timeout",
  UnusableHeadline: () => "UnusableHeadline",
});

const respondingModel = (content: ReadonlyArray<Response.AnyPart>, requested: string): string =>
  Array.findFirst(
    content,
    (part): part is Response.ResponseMetadataPart => part.type === "response-metadata",
  ).pipe(
    Option.flatMap((part) => Option.fromUndefinedOr(part.modelId)),
    Option.getOrElse(() => requested),
  );

const logFailure = Effect.fnUntraced(function* (error: WritingError) {
  const model = yield* Model.ModelName;

  yield* Effect.logWarning("AI model couldn't write it").pipe(
    Effect.annotateLogs({ model, reason: failureReason(error) }),
  );
});

const writeWithModel = Effect.fnUntraced(function* <A>(brief: Brief<A>) {
  const model = yield* Model.ModelName;

  const generate = LanguageModel.generateText({
    prompt: [
      { role: "system", content: brief.prompt },
      { role: "user", content: brief.request },
    ],
  });

  const response = yield* (
    brief.maxOutputTokens === undefined
      ? generate
      : OpenAiLanguageModel.withConfigOverride(generate, {
          max_output_tokens: brief.maxOutputTokens,
        })
  ).pipe(Effect.timeout(MODEL_TIMEOUT));

  const value = yield* Schema.decodeEffect(brief.reply)(response.text).pipe(
    Effect.mapError(() => UnusableHeadline.make({ text: response.text })),
  );

  return { value, model: respondingModel(response.content, model) };
}, Effect.tapError(logFailure));

export type ModelLayer = Layer.Layer<
  LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName
>;

export type Providers = Array.NonEmptyReadonlyArray<Array.NonEmptyReadonlyArray<ModelLayer>>;

export const orderModels = Effect.fnUntraced(function* <A>(models: Array.NonEmptyReadonlyArray<A>) {
  const first = (yield* Random.nextBoolean) ? models[0] : yield* Random.choice(models);

  return Array.prepend(
    yield* Random.shuffle(Array.filter(models, (model) => model !== first)),
    first,
  );
});

interface ModelStep {
  readonly provide: ModelLayer;
  readonly while: (error: WritingError) => boolean;
}

const providerSteps = (models: Array.NonEmptyReadonlyArray<ModelLayer>) =>
  Array.map(models, (provide, index): ModelStep => ({
    provide,
    while: (error) => index === 0 || !isDailyLimit(error),
  }));

export const writeWithProviders = Effect.fnUntraced(function* <A>(
  brief: Brief<A>,
  providersInOrder: Providers,
): Effect.fn.Return<Written<A>, WritingError> {
  const ordered = yield* Effect.all(Array.map(providersInOrder, orderModels));

  const plan = ExecutionPlan.make<Array.NonEmptyReadonlyArray<ModelStep>>(
    ...Array.flatMap(ordered, providerSteps),
  );

  return yield* writeWithModel(brief).pipe(Effect.withExecutionPlan(plan));
});

const CLOUDFLARE_MODEL_CONFIG = {
  temperature: 1,
  max_output_tokens: 300,
  chat_template_kwargs: { enable_thinking: false },
};

const withClient = Effect.fnUntraced(function* <P extends string, C>(
  models: Array.NonEmptyReadonlyArray<Model.Model<P, LanguageModel.LanguageModel, C>>,
  client: Layer.Layer<C, never, HttpClient.HttpClient>,
) {
  const context = yield* Layer.build(client);

  return yield* Effect.all(Array.map(models, (model) => model.captureRequirements)).pipe(
    Effect.provideContext(context),
  );
});

export const openRouterProvider = (
  apiKey: Redacted.Redacted<string>,
  models: Array.NonEmptyReadonlyArray<string>,
) =>
  withClient(
    Array.map(models, (model) => OpenRouterLanguageModel.model(model, { temperature: 1 })),
    OpenRouterClient.layer({ apiKey, siteTitle: "Virtual Office Notifier" }),
  );

export const cloudflareProvider = (
  accountId: Redacted.Redacted<string>,
  apiToken: Redacted.Redacted<string>,
  models: Array.NonEmptyReadonlyArray<string>,
) =>
  withClient(
    Array.map(models, (model) => OpenAiLanguageModel.model(model, CLOUDFLARE_MODEL_CONFIG)),
    OpenAiClient.layer({
      apiKey: apiToken,
      apiUrl: `https://api.cloudflare.com/client/v4/accounts/${Redacted.value(accountId)}/ai/v1`,
    }),
  );

export const configuredProviders = Effect.fnUntraced(function* (
  openRouterModels: (
    config: Config.Success<typeof AiConfig>,
  ) => Array.NonEmptyReadonlyArray<string>,
) {
  const config = yield* AiConfig;
  const { openRouter, cloudflare } = config;

  return yield* Effect.all([
    ...Option.toArray(
      Option.map(openRouter.apiKey, (apiKey) =>
        openRouterProvider(apiKey, openRouterModels(config)),
      ),
    ),
    ...Option.toArray(
      Option.map(
        Option.all({ accountId: cloudflare.accountId, apiToken: cloudflare.apiToken }),
        ({ accountId, apiToken }) => cloudflareProvider(accountId, apiToken, cloudflare.models),
      ),
    ),
  ]);
});
