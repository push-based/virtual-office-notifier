import { Context, DateTime, Duration, Effect, Layer, Redacted, Schema, String } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";

import type { SignedInUser } from "./SignInApi.ts";
import { SignInSettings } from "./SignInSettings.ts";

export const SESSION_LIFETIME = Duration.hours(12);

export class InvalidSession extends Schema.TaggedError<
  InvalidSession,
  { readonly brand: unique symbol }
>()("InvalidSession", {}) {}

const SessionPayload = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        sub: Schema.String,
        name: Schema.String,
        avatarUrl: Schema.NullOr(Schema.String),
        exp: Schema.Finite,
      }),
    ),
  ),
);

const encodePayload = Schema.encodeEffect(SessionPayload);

const decodePayload = Schema.decodeUnknownEffect(SessionPayload);

const encoder = new TextEncoder();

const invalid = () => InvalidSession.make();

export class Sessions extends Context.Service<
  Sessions,
  {
    issue(user: SignedInUser): Effect.Effect<string>;
    verify(session: string): Effect.Effect<SignedInUser, InvalidSession>;
  }
>()("activity-sign-in/Sessions") {
  static readonly make = Effect.fnUntraced(function* (secret: Redacted.Redacted<string>) {
    const mac = yield* Mac.Mac;
    const key = yield* Mac.key(Mac.hmacSha256, encoder.encode(Redacted.value(secret)));

    const issue = Effect.fnUntraced(function* (user: SignedInUser) {
      const now = yield* DateTime.now;

      const payload = yield* encodePayload({
        sub: user.id,
        name: user.name,
        avatarUrl: user.avatarUrl,
        exp: DateTime.toEpochMillis(DateTime.addDuration(now, SESSION_LIFETIME)),
      }).pipe(Effect.orDie);

      const signature = yield* mac.sign(key, encoder.encode(payload)).pipe(Effect.orDie);

      return `${payload}.${Base64Url.encode(signature)}`;
    });

    const verify = Effect.fnUntraced(function* (session: string) {
      const [payload, signature, ...rest] = String.split(session, ".");

      if (payload === undefined || signature === undefined || rest.length > 0)
        return yield* invalid();

      const tag = yield* Effect.fromResult(Base64Url.decode(signature)).pipe(
        Effect.mapError(invalid),
      );

      const signed = yield* mac.verify(key, tag, encoder.encode(payload)).pipe(Effect.orDie);

      if (!signed) return yield* invalid();

      const decoded = yield* decodePayload(payload).pipe(Effect.mapError(invalid));
      const now = yield* DateTime.now;

      if (decoded.exp <= DateTime.toEpochMillis(now)) return yield* invalid();

      const user: SignedInUser = {
        id: decoded.sub,
        name: decoded.name,
        avatarUrl: decoded.avatarUrl,
      };

      return user;
    });

    return Sessions.of({ issue, verify });
  });

  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const { sessionSecret } = yield* SignInSettings;

      return yield* Sessions.make(sessionSecret);
    }),
  ).pipe(
    Layer.orDie,
    Layer.provide(Mac.layerWebCrypto),
    Layer.provide(SecureRandom.layerWebCrypto),
  );
}
