import { Array, Data, Effect, Match, Predicate, Record, Redacted, Schema } from "effect";
import { AiError, type Decision, DecisionModel } from "effect/ai";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export interface CloudflareDecisionOptions {
  readonly accountId: Redacted.Redacted<string>;
  readonly apiToken: Redacted.Redacted<string>;
  readonly model: string;
}

type ClefDecision = Exclude<Decision.Any, Decision.Locate>;

export type ClefQuestion =
  | {
      readonly type: "choice";
      readonly instructions: Decision.Description;
      readonly criteria: { readonly [label: string]: Decision.Description | null };
    }
  | {
      readonly type: "score";
      readonly instructions: Decision.Description;
      readonly criteria: ReadonlyArray<Decision.Description>;
    }
  | {
      readonly type: "noul";
      readonly instructions: Decision.Description;
      readonly criteria?:
        | { readonly true: Decision.Description; readonly false: Decision.Description }
        | undefined;
    };

export interface ClefRequest {
  readonly state: Schema.Json;
  readonly questions: { readonly [name: string]: ClefQuestion };
}

const question = (decision: ClefDecision): ClefQuestion =>
  Match.valueTags(decision, {
    Classify: ({ instructions, criteria }): ClefQuestion => ({
      type: "choice",
      instructions,
      criteria,
    }),
    Rate: ({ instructions, criteria }): ClefQuestion => ({
      type: "score",
      instructions,
      criteria: Array.map(criteria, (level) => level.description),
    }),
    Probability: ({ instructions, criteria }): ClefQuestion =>
      criteria === undefined
        ? { type: "noul", instructions }
        : { type: "noul", instructions, criteria },
  });

export const clefRequest = (
  state: Schema.Json,
  decisions: Record.ReadonlyRecord<string, ClefDecision>,
): ClefRequest => ({
  state,
  questions: Record.map(decisions, (decision) => question(decision)),
});

const Probabilities = Schema.Record(Schema.String, Schema.Finite);

const Answer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: Probabilities,
    confidence: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Finite,
    probabilities: Probabilities,
    confidence: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Finite }),
]);

const RunResponse = Schema.Struct({
  result: Schema.Struct({
    answers: Schema.Record(Schema.String, Answer),
    usage: Schema.optional(
      Schema.Struct({
        input_tokens: Schema.optional(Schema.Finite),
        output_tokens: Schema.optional(Schema.Finite),
      }),
    ),
  }),
});

const decodeRunResponse = HttpClientResponse.schemaBodyJson(RunResponse);

const ProviderAnswer = Data.taggedEnum<DecisionModel.ProviderAnswer>();

const aiError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "CloudflareDecisionModel", method: "decide", reason });

const providerAnswer = (
  answer: typeof Answer.Type,
  decision: ClefDecision | undefined,
): DecisionModel.ProviderAnswer => {
  switch (answer.type) {
    case "noul":
      return ProviderAnswer.Probability({ probability: answer.noul });
    case "choice":
      return ProviderAnswer.Classify({
        label: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      });
    case "score": {
      const levels =
        decision !== undefined && Predicate.isTagged(decision, "Rate")
          ? Array.map(decision.criteria, (level) => level.label)
          : [];

      return ProviderAnswer.Rate({
        rating: answer.score,
        probabilities: Record.fromEntries(
          Array.flatMap(levels, (label, index): ReadonlyArray<readonly [string, number]> => {
            const probability = answer.probabilities[String(index)];

            return probability === undefined ? [] : [[label, probability]];
          }),
        ),
        confidence: answer.confidence,
      });
    }
  }
};

interface HttpDetails {
  readonly body: string;
}

const refuse =
  (reason: (http: HttpDetails, status: number) => AiError.AiErrorReason) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((body) => Effect.fail(aiError(reason({ body }, response.status)))),
    );

const readResponse = HttpClientResponse.matchStatus({
  "2xx": (response) =>
    decodeRunResponse(response).pipe(
      Effect.mapError(() =>
        aiError(AiError.InvalidOutputError.make({ description: "Clef's reply couldn't be read" })),
      ),
    ),
  401: refuse((http) => AiError.AuthenticationError.make({ kind: "InvalidKey", http })),
  403: refuse((http) =>
    AiError.AuthenticationError.make({ kind: "InsufficientPermissions", http }),
  ),
  429: refuse((http) => AiError.RateLimitError.make({ http })),
  "5xx": refuse((http, status) =>
    AiError.InternalProviderError.make({ description: `HTTP ${status}`, http }),
  ),
  orElse: refuse((http, status) =>
    AiError.InvalidRequestError.make({ description: `HTTP ${status}`, http }),
  ),
});

export const make = Effect.fnUntraced(function* (options: CloudflareDecisionOptions) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(options.apiToken)),
  );

  const url = `https://api.cloudflare.com/client/v4/accounts/${Redacted.value(options.accountId)}/ai/run/${options.model}`;

  return yield* DecisionModel.make({
    probabilityPrecision: 4,
    decide: ({ state, decisions }) =>
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyJsonUnsafe(clefRequest(state, decisions)),
        client.execute,
        Effect.mapError((error) =>
          aiError(
            AiError.NetworkError.make({
              reason: "TransportError",
              method: "POST",
              url,
              description: error.reason._tag,
            }),
          ),
        ),
        Effect.flatMap(readResponse),
        Effect.map(({ result }) => ({
          answers: Record.map(result.answers, (answer, name) =>
            providerAnswer(answer, decisions[name]),
          ),
          usage: {
            inputTokens: result.usage?.input_tokens,
            outputTokens: result.usage?.output_tokens,
          },
        })),
      ),
  });
});

export const CloudflareDecisionModel = { make };
