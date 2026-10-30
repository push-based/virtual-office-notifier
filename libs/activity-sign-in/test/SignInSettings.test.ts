import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";

import { SignInSettings } from "../src/SignInSettings.ts";

const settingsFrom = (env: Readonly<Record<string, string>>) =>
  Effect.service(SignInSettings).pipe(
    Effect.provide(
      SignInSettings.layerConfig.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    ),
  );

const complete = {
  DISCORD_CLIENT_ID: "client",
  DISCORD_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "session-secret",
};

describe("SignInSettings.layerConfig", () => {
  it.effect("reads the client id and both secrets", () =>
    Effect.gen(function* () {
      const settings = yield* settingsFrom(complete);

      assert.strictEqual(settings.clientId, "client");
      assert.strictEqual(Redacted.value(settings.clientSecret), "client-secret");
      assert.strictEqual(Redacted.value(settings.sessionSecret), "session-secret");
    }),
  );

  it.effect("fails instead of signing sessions with a missing or empty secret", () =>
    Effect.gen(function* () {
      const { SESSION_SECRET: _, ...missing } = complete;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(settingsFrom(missing))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(settingsFrom({ ...complete, SESSION_SECRET: "" }))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(settingsFrom({ ...complete, DISCORD_CLIENT_SECRET: "" })),
        ),
      );
    }),
  );
});
