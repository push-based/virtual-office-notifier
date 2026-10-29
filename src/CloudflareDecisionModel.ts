import { Data, Effect, Match, Predicate, Redacted, Schema } from "effect";
import { AiError, type Decision, DecisionModel } from "effect/ai";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

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
      readonly criteria?: { readonly true: Decision.Description; readonly false: Decision.Description } | undefined;
    };

export interface ClefRequest {
  readonly state: Schema.Json;
  readonly questions: { readonly [name: string]: ClefQuestion };
}

const question = (decision: ClefDecision): ClefQuestion =>
  Match.valueTags(decision, {
    Classify: ({ instructions, criteria }): ClefQuestion => ({ type: "choice", instructions, criteria }),
    Rate: ({ instructions, criteria }): ClefQuestion => ({
      type: "score",
      instructions,
      criteria: criteria.map((level) => level.description),
    }),
    Probability: ({ instructions, criteria }): ClefQuestion =>
      criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria },
  });

export const clefRequest = (state: Schema.Json, decisions: Readonly<Record<string, ClefDecision>>): ClefRequest => ({
  state,
  questions: Object.fromEntries(Object.entries(decisions).map(([name, decision]) => [name, question(decision)])),
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

const decodeRunResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RunResponse));

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
      const levels = decision !== undefined && Predicate.isTagged(decision, "Rate") ? decision.criteria.map((level) => level.label) : [];

      return ProviderAnswer.Rate({
        rating: answer.score,
        probabilities: Object.fromEntries(
          levels.flatMap((label, index) => {
            const probability = answer.probabilities[String(index)];

            return probability === undefined ? [] : [[label, probability]];
          }),
        ),
        confidence: answer.confidence,
      });
    }
  }
};

const failureFor = (status: number, body: string): AiError.AiErrorReason => {
  const http = { body };

  if (status === 429) return new AiError.RateLimitError({ http });

  if (status === 401) return new AiError.AuthenticationError({ kind: "InvalidKey", http });

  if (status === 403) return new AiError.AuthenticationError({ kind: "InsufficientPermissions", http });

  if (status >= 500) return new AiError.InternalProviderError({ description: `HTTP ${status}`, http });

  return new AiError.InvalidRequestError({ description: `HTTP ${status}`, http });
};

export const make = Effect.fnUntraced(function* (options: CloudflareDecisionOptions) {
  const client = yield* HttpClient.HttpClient;
  const url = `https://api.cloudflare.com/client/v4/accounts/${Redacted.value(options.accountId)}/ai/run/${options.model}`;

  const readResponse = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

      if (response.status < 200 || response.status >= 300) {
        return yield* aiError(failureFor(response.status, body));
      }

      return yield* decodeRunResponse(body).pipe(
        Effect.mapError(() => aiError(new AiError.InvalidOutputError({ description: "Clef's reply couldn't be read" }))),
      );
    });

  return yield* DecisionModel.make({
    probabilityPrecision: 4,
    decide: ({ state, decisions }) =>
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(Redacted.value(options.apiToken)),
        HttpClientRequest.bodyJsonUnsafe(clefRequest(state, decisions)),
        client.execute,
        Effect.mapError((error) =>
          aiError(
            new AiError.NetworkError({
              reason: "TransportError",
              method: "POST",
              url,
              description: error.reason._tag,
            }),
          ),
        ),
        Effect.flatMap(readResponse),
        Effect.map(({ result }) => ({
          answers: Object.fromEntries(
            Object.entries(result.answers).map(([name, answer]) => [name, providerAnswer(answer, decisions[name])]),
          ),
          usage: { inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens },
        })),
      ),
  });
});

export const CloudflareDecisionModel = { make };
