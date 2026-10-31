import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Model } from "effect/ai";

import { AiProviders, type ModelLayer, type Providers } from "../../src/ai/AiWriting.ts";
import { withEnv } from "../fakes.ts";

const MODELS = {
  OPENROUTER_MODELS: "a/one:free, a/two:free",
  OPENROUTER_BANTER_MODELS: "b/one:free",
  CLOUDFLARE_MODELS: "@cf/c/one",
};

const OPENROUTER = { OPENROUTER_API_KEY: "openrouter-key" };

const CLOUDFLARE = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "cloudflare-token" };

const modelName = (model: ModelLayer) =>
  Effect.service(Model.ModelName).pipe(Effect.provide(model));

const modelNames = (providers: Providers) =>
  Effect.forEach(providers, (models) => Effect.forEach(models, modelName));

const configuredWith = Effect.fnUntraced(function* (env: Record<string, string>) {
  const { configured } = yield* Effect.service(AiProviders).pipe(
    Effect.provide(AiProviders.layer),
    withEnv(env),
  );

  return yield* Effect.transposeOption(
    Option.map(configured, ({ headlines, banter }) =>
      Effect.all({ headlines: modelNames(headlines), banter: modelNames(banter) }),
    ),
  );
});

describe("AiProviders", () => {
  it.effect("configures nothing without an AI provider's credentials", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* configuredWith(MODELS)));
    }),
  );

  it.effect("lists OpenRouter before Cloudflare, with its own models for banter", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* configuredWith({ ...MODELS, ...OPENROUTER, ...CLOUDFLARE }),
        Option.some({
          headlines: [["a/one:free", "a/two:free"], ["@cf/c/one"]],
          banter: [["b/one:free"], ["@cf/c/one"]],
        }),
      );
    }),
  );

  it.effect("uses the Cloudflare models for everything when only Cloudflare is set up", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* configuredWith({ ...MODELS, ...CLOUDFLARE }),
        Option.some({ headlines: [["@cf/c/one"]], banter: [["@cf/c/one"]] }),
      );
    }),
  );
});
