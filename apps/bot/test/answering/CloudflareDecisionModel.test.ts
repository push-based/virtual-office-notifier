import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Result, Schema } from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";

import { CloudflareDecisionModel } from "../../src/answering/CloudflareDecisionModel.ts";
import { makeFakeSlackHttp, type Reply, requestJson, respond } from "../fakes.ts";

const Moment = Decision.make({
  input: Schema.Struct({ message: Schema.String }),
  decisions: {
    action: Decision.classify({
      instructions: "What should the bot do?",
      criteria: { reply: "Answer it", react: "React to it", ignore: null },
    }),
  },
});

const clef = (answers: Record<string, Record<string, string | number | Record<string, number>>>) =>
  respond(
    200,
    JSON.stringify({
      result: { model: "clef", answers, usage: { input_tokens: 269, output_tokens: 0 } },
      success: true,
      errors: [],
      messages: [],
    }),
  );

const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decide = Effect.fnUntraced(function* (reply: Reply) {
  const http = yield* makeFakeSlackHttp([reply]);

  const model = yield* CloudflareDecisionModel.make({
    accountId: Redacted.make("account-1"),
    apiToken: Redacted.make("cf-secret"),
    model: "@cf/cloudflare/clef",
  }).pipe(Effect.provide(http.layer));

  const response = yield* DecisionModel.decide(Moment, { input: { message: "haha" } }).pipe(
    Effect.provideService(DecisionModel.DecisionModel, model),
    Effect.result,
  );

  const [request] = yield* http.requests;

  return { response, request: request! };
});

describe("CloudflareDecisionModel", () => {
  it.effect("asks Clef on Workers AI and reads its answers", () =>
    Effect.gen(function* () {
      const { response, request } = yield* decide(
        clef({
          action: {
            type: "choice",
            choice: "react",
            probabilities: { reply: 0.0272, react: 0.8587, ignore: 0.1141 },
            confidence: 0.6267,
          },
        }),
      );

      assert.strictEqual(
        request.url,
        "https://api.cloudflare.com/client/v4/accounts/account-1/ai/run/@cf/cloudflare/clef",
      );
      assert.strictEqual(request.headers["authorization"], "Bearer cf-secret");
      assert.deepStrictEqual(requestJson(request), {
        state: { message: "haha" },
        questions: {
          action: {
            type: "choice",
            instructions: "What should the bot do?",
            criteria: { reply: "Answer it", react: "React to it", ignore: null },
          },
        },
      });

      assert.isTrue(Result.isSuccess(response));

      if (Result.isSuccess(response)) {
        assert.strictEqual(response.success.answers.action.label, "react");
        assert.strictEqual(response.success.answers.action.confidence, 0.6267);
        assert.closeTo(response.success.answers.action.probabilities.react, 0.8587, 0.001);
        assert.strictEqual(response.success.usage.inputTokens, 269);
      }
    }),
  );

  it.effect("rejects an answer with a label it wasn't offered", () =>
    Effect.gen(function* () {
      const { response } = yield* decide(
        clef({
          action: {
            type: "choice",
            choice: "shrug",
            probabilities: { reply: 0.5, react: 0.5, ignore: 0 },
          },
        }),
      );

      assert.isTrue(Result.isFailure(response));

      if (Result.isFailure(response))
        assert.instanceOf(response.failure.reason, AiError.InvalidOutputError);
    }),
  );

  it.effect("rejects probabilities that don't add up", () =>
    Effect.gen(function* () {
      const { response } = yield* decide(
        clef({
          action: {
            type: "choice",
            choice: "react",
            probabilities: { reply: 0.5, react: 0.9, ignore: 0.1 },
          },
        }),
      );

      assert.isTrue(Result.isFailure(response));

      if (Result.isFailure(response))
        assert.instanceOf(response.failure.reason, AiError.InvalidOutputError);
    }),
  );

  it.effect("rejects a reply it can't read", () =>
    Effect.gen(function* () {
      const { response } = yield* decide(
        respond(200, yield* toJson({ result: { nonsense: true }, success: true })),
      );

      assert.isTrue(Result.isFailure(response));

      if (Result.isFailure(response))
        assert.instanceOf(response.failure.reason, AiError.InvalidOutputError);
    }),
  );

  it.effect(
    "reports a rate limit with Cloudflare's body, so a spent daily allocation can be recognised",
    () =>
      Effect.gen(function* () {
        const body = yield* toJson({
          success: false,
          errors: [{ code: 4006, message: "daily free allocation" }],
        });

        const { response } = yield* decide(respond(429, body));

        assert.isTrue(Result.isFailure(response));

        if (Result.isFailure(response)) {
          assert.instanceOf(response.failure.reason, AiError.RateLimitError);
          assert.strictEqual(response.failure.reason.http?.body, body);
          assert.notInclude(yield* toJson(response.failure), "cf-secret");
        }
      }),
  );

  it.effect("reports a bad token as an authentication error", () =>
    Effect.gen(function* () {
      const { response } = yield* decide(
        respond(401, yield* toJson({ success: false, errors: [] })),
      );

      assert.isTrue(Result.isFailure(response));

      if (Result.isFailure(response))
        assert.instanceOf(response.failure.reason, AiError.AuthenticationError);
    }),
  );
});
