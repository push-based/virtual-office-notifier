import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Digest } from "effect/crypto";

import { type Release, releaseFingerprint } from "../../scripts/Release.ts";

const encoder = new TextEncoder();

const release: Release = {
  bundle: encoder.encode("console.log('office')"),
  sourceMap: encoder.encode('{"version":3}'),
  nativeVersion: "0.1.12",
  unit: "[Service]\nExecStart=/usr/bin/node main.js",
  env: [
    "DISCORD_BOT_TOKEN=secret",
    "SLACK_CHANNEL_ID=C123",
    "SENTRY_ENVIRONMENT=production",
    "SENTRY_RELEASE=abc123",
  ],
};

const fingerprint = (of: Release) =>
  releaseFingerprint(of).pipe(Effect.provide(Digest.layerWebCrypto));

describe("the release fingerprint", () => {
  it.effect("is the same for the same release", () =>
    Effect.gen(function* () {
      const first = yield* fingerprint(release);
      const again = yield* fingerprint({ ...release });

      assert.strictEqual(again, first);
      assert.match(first, /^[0-9a-f]{64}$/);
    }),
  );

  it.effect("ignores which commit the release was built from", () =>
    Effect.gen(function* () {
      const rebuilt = { ...release, env: [...release.env.slice(0, -1), "SENTRY_RELEASE=def456"] };

      assert.strictEqual(yield* fingerprint(rebuilt), yield* fingerprint(release));
    }),
  );

  it.effect("changes with the bundle, its source map, the add-on, the unit and the settings", () =>
    Effect.gen(function* () {
      const changed: ReadonlyArray<Release> = [
        { ...release, bundle: encoder.encode("console.log('kitchen')") },
        { ...release, sourceMap: encoder.encode('{"version":4}') },
        { ...release, nativeVersion: "0.1.13" },
        { ...release, unit: `${release.unit}\nRestart=always` },
        { ...release, env: ["DISCORD_BOT_TOKEN=rotated", ...release.env.slice(1)] },
      ];

      const original = yield* fingerprint(release);

      for (const other of changed) {
        assert.notStrictEqual(yield* fingerprint(other), original);
      }
    }),
  );

  it.effect("tells apart content that only moved between parts", () =>
    Effect.gen(function* () {
      const moved = {
        ...release,
        bundle: encoder.encode("console.log('office')\n"),
        sourceMap: encoder.encode('"version":3}'),
      };

      assert.notStrictEqual(yield* fingerprint(moved), yield* fingerprint(release));
    }),
  );
});
