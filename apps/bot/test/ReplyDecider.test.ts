import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { type ClefState, judge, ReplyDecider } from "../src/ReplyDecider.ts";
import type { ClefVerdict } from "../src/SlackHistory.ts";
import {
  DEFAULT_SETTINGS,
  hang,
  makeFakeSlackHttp,
  type Reply,
  requestJson,
  requestText,
  respond,
  withEnv,
} from "./fakes.ts";

const CLOUDFLARE_ENV = { CLOUDFLARE_ACCOUNT_ID: "account-1", CLOUDFLARE_API_TOKEN: "cf-secret" };

const state: ClefState = {
  botPost: { who: "the bot", text: "🐦 Sam was first in every day this week." },
  earlier: [{ who: "Grace", text: "Sam lives there now" }],
  message: { who: "Ada", text: "haha Sam is a machine" },
};

const verdict = (overrides: Partial<ClefVerdict> = {}): ClefVerdict => ({
  model: "@cf/cloudflare/clef",
  request: { state: {}, questions: {} },
  action: "react",
  actionProbabilities: { reply: 0.03, react: 0.86, ignore: 0.11 },
  actionConfidence: 0.81,
  reaction: "joy",
  reactionProbabilities: { joy: 0.96, eyes: 0.02, raised_hands: 0.02 },
  reactionConfidence: 0.89,
  latencyMs: 200,
  ...overrides,
});

const clefSays = respond(
  200,
  JSON.stringify({
    result: {
      answers: {
        action: {
          type: "choice",
          choice: "react",
          probabilities: { reply: 0.0272, react: 0.8587, ignore: 0.1141 },
          confidence: 0.7267,
        },
        reaction: {
          type: "choice",
          choice: "joy",
          probabilities: { joy: 0.9638, eyes: 0.0169, raised_hands: 0.0193 },
          confidence: 0.8942,
        },
      },
      usage: { input_tokens: 269, output_tokens: 0 },
    },
    success: true,
  }),
);

const makeDecider = Effect.fnUntraced(function* (
  replies: ReadonlyArray<Reply>,
  env = CLOUDFLARE_ENV,
) {
  const http = yield* makeFakeSlackHttp(replies);

  const decider = yield* Effect.service(ReplyDecider).pipe(
    Effect.provide(ReplyDecider.layerNoDeps.pipe(Layer.provide(http.layer))),
    withEnv(env),
  );

  return { decider, requests: http.requests };
});

describe("judge", () => {
  it("acts on Clef's choice when it's confident enough", () => {
    assert.deepStrictEqual(judge(verdict({ actionConfidence: 0.7 }), 0.7), {
      act: "react",
      reason: "clef",
    });
  });

  it("ignores the message when Clef isn't confident enough", () => {
    assert.deepStrictEqual(judge(verdict({ actionConfidence: 0.69 }), 0.7), {
      act: "ignore",
      reason: "low_confidence",
    });
  });

  it("ignores the message when Clef chose to, however confident", () => {
    assert.deepStrictEqual(judge(verdict({ action: "ignore", actionConfidence: 0.99 }), 0.7), {
      act: "ignore",
      reason: "clef",
    });
  });
});

describe("ReplyDecider", () => {
  it.effect("asks the configured Clef model, offering the configured emoji", () =>
    Effect.gen(function* () {
      const { decider, requests } = yield* makeDecider([clefSays]);

      const decided = yield* decider.decide(state, {
        ...DEFAULT_SETTINGS,
        clefModel: "@cf/cloudflare/clef-flash",
      });

      const [request] = yield* requests;
      assert.include(request?.url, "/ai/run/@cf/cloudflare/clef-flash");

      const body = requestJson(request!);
      assert.strictEqual(JSON.stringify(decided.verdict.request), requestText(request!));
      assert.deepNestedInclude(body, {
        "state.message": { who: "Ada", text: "haha Sam is a machine" },
      });
      assert.deepNestedInclude(body, {
        "questions.reaction.criteria": { joy: null, eyes: null, raised_hands: null },
      });
      assert.deepNestedInclude(body, { "questions.action.type": "choice" });
    }),
  );

  it.effect("keeps everything Clef said, and acts on the action's confidence", () =>
    Effect.gen(function* () {
      const { decider } = yield* makeDecider([clefSays]);

      const decided = yield* decider.decide(state, DEFAULT_SETTINGS);

      assert.strictEqual(decided.verdict.action, "react");
      assert.strictEqual(decided.verdict.actionConfidence, 0.7267);
      assert.strictEqual(decided.verdict.reaction, "joy");
      assert.strictEqual(decided.verdict.reactionConfidence, 0.8942);
      assert.deepStrictEqual(decided.judgement, { act: "react", reason: "clef" });

      const doubtful = yield* decider.decide(state, { ...DEFAULT_SETTINGS, minConfidence: 0.8 });

      assert.deepStrictEqual(doubtful.judgement, { act: "ignore", reason: "low_confidence" });
    }),
  );

  it.effect("fails with the reason when Clef can't be asked", () =>
    Effect.gen(function* () {
      const { decider } = yield* makeDecider([respond(500, "")]);

      const error = yield* decider.decide(state, DEFAULT_SETTINGS).pipe(Effect.flip);

      assert.strictEqual(error.reason, "InternalProviderError");
    }),
  );

  it.effect("gives up on Clef after 15 seconds", () =>
    Effect.gen(function* () {
      const { decider } = yield* makeDecider([hang]);

      const fiber = yield* decider
        .decide(state, DEFAULT_SETTINGS)
        .pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("15 seconds");

      assert.strictEqual((yield* Fiber.join(fiber)).reason, "Timeout");
    }),
  );

  it.effect("can't decide anything without Cloudflare configured", () =>
    Effect.gen(function* () {
      const { decider, requests } = yield* makeDecider([clefSays], {});

      const error = yield* decider.decide(state, DEFAULT_SETTINGS).pipe(Effect.flip);

      assert.strictEqual(error.reason, "NotConfigured");
      assert.deepStrictEqual(yield* requests, []);
    }),
  );
});
