import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/http-api";

export class DiscordRefused extends Schema.TaggedError<
  DiscordRefused,
  { readonly brand: unique symbol }
>()("DiscordRefused", { status: Schema.Finite }, { httpApiStatus: 502 }) {}

export const SignedInUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});

export type SignedInUser = typeof SignedInUser.Type;

export const SignInConfig = Schema.Struct({ clientId: Schema.String });

export const SignInCode = Schema.Struct({ code: Schema.NonEmptyString });

export const SignedInSession = Schema.Struct({
  accessToken: Schema.String,
  session: Schema.String,
  user: SignedInUser,
});

export class SignInGroup extends HttpApiGroup.make("signIn").add(
  HttpApiEndpoint.get("config", "/config", { success: SignInConfig }),
  HttpApiEndpoint.post("token", "/token", {
    payload: SignInCode,
    success: SignedInSession,
    error: [DiscordRefused, HttpApiError.BadRequest],
  }),
) {}
