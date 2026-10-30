import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Redacted, Result, String } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { TestClock } from "effect/testing";

import { SESSION_LIFETIME, Sessions } from "../src/Sessions.ts";
import type { SignedInUser } from "../src/SignInApi.ts";
import { SignInSettings } from "../src/SignInSettings.ts";

const ada: SignedInUser = { id: "u1", name: "Ada", avatarUrl: null };

const settingsWith = (sessionSecret: string) =>
  Layer.succeed(
    SignInSettings,
    SignInSettings.of({
      clientId: "client",
      clientSecret: Redacted.make("client-secret"),
      sessionSecret: Redacted.make(sessionSecret),
    }),
  );

const SessionsWith = (sessionSecret: string) =>
  Sessions.layer.pipe(Layer.provide(settingsWith(sessionSecret)));

const SessionsAndMac = Layer.mergeAll(
  SessionsWith("secret"),
  Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
);

const rejected = (session: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const error = yield* sessions.verify(session).pipe(Effect.flip);

    assert.strictEqual(error._tag, "InvalidSession");
  });

const issued = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.issue(ada);
  const [payload, signature = ""] = String.split(session, ".");

  return { session, payload, signature };
});

describe("Sessions", () => {
  it.effect("verifies a session it issued as the person it was issued to", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const { session } = yield* issued;

      assert.deepStrictEqual(yield* sessions.verify(session), ada);
    }).pipe(Effect.provide(SessionsWith("secret"))),
  );

  it.effect("keeps a session valid until just before twelve hours have passed", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const { session } = yield* issued;

      yield* TestClock.adjust(Duration.subtract(SESSION_LIFETIME, Duration.millis(1)));

      assert.deepStrictEqual(yield* sessions.verify(session), ada);
    }).pipe(Effect.provide(SessionsWith("secret"))),
  );

  it.effect("rejects an expired session", () =>
    Effect.gen(function* () {
      const { session } = yield* issued;

      yield* TestClock.adjust(SESSION_LIFETIME);

      yield* rejected(session);
    }).pipe(Effect.provide(SessionsWith("secret"))),
  );

  it.effect("rejects a tampered payload", () =>
    Effect.gen(function* () {
      const { payload, signature } = yield* issued;
      const decoded = Result.getOrThrow(Base64Url.decodeString(payload));
      const forged = Base64Url.encode(String.replace("Ada", "Eve")(decoded));

      assert.notStrictEqual(forged, payload);

      yield* rejected(`${forged}.${signature}`);
    }).pipe(Effect.provide(SessionsWith("secret"))),
  );

  it.effect("rejects a tampered signature", () =>
    Effect.gen(function* () {
      const { payload, signature } = yield* issued;
      const first = String.startsWith("A")(signature) ? "B" : "A";
      const forged = `${first}${String.slice(1)(signature)}`;

      yield* rejected(`${payload}.${forged}`);
    }).pipe(Effect.provide(SessionsWith("secret"))),
  );

  it.effect("rejects a session signed with another secret", () =>
    Effect.gen(function* () {
      const elsewhere = yield* Sessions.make(Redacted.make("another secret"));
      const session = yield* elsewhere.issue(ada);

      yield* rejected(session);
    }).pipe(Effect.provide(SessionsAndMac)),
  );

  it.effect("rejects a malformed token", () =>
    Effect.gen(function* () {
      const { session } = yield* issued;

      for (const malformed of ["", "garbage", ".", "a.", ".b", `${session}.extra`, "!!!.###"])
        yield* rejected(malformed);
    }).pipe(Effect.provide(SessionsWith("secret"))),
  );

  it.effect("rejects a correctly signed payload that isn't a session", () =>
    Effect.gen(function* () {
      const mac = yield* Mac.Mac;
      const key = yield* Mac.key(Mac.hmacSha256, new TextEncoder().encode("secret"));
      const payload = Base64Url.encode('{"sub":"u1"}');
      const signature = yield* mac.sign(key, new TextEncoder().encode(payload));

      yield* rejected(`${payload}.${Base64Url.encode(signature)}`);
    }).pipe(Effect.provide(SessionsAndMac)),
  );
});
