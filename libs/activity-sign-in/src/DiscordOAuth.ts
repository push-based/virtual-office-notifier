import { Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { DiscordRefused, type SignedInUser } from "./SignInApi.ts";
import { SignInSettings } from "./SignInSettings.ts";

const DISCORD_API = "https://discord.com/api";

const DiscordToken = Schema.Struct({ access_token: Schema.String });

const DiscordUser = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  global_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
});

type DiscordUser = typeof DiscordUser.Type;

export interface DiscordGrant {
  readonly accessToken: string;
  readonly user: SignedInUser;
}

const refused = (response: HttpClientResponse.HttpClientResponse) =>
  DiscordRefused.make({ status: response.status });

const readBody = <A>(
  decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError>,
) =>
  HttpClientResponse.matchStatus({
    "2xx": (response) => decode(response).pipe(Effect.mapError(() => refused(response))),
    orElse: (response) => Effect.fail(refused(response)),
  });

const readToken = readBody(HttpClientResponse.schemaBodyJson(DiscordToken));

const readUser = readBody(HttpClientResponse.schemaBodyJson(DiscordUser));

const avatarUrlOf = (user: DiscordUser): string | null =>
  user.avatar === null || user.avatar === undefined
    ? null
    : `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;

const signedInUserOf = (user: DiscordUser): SignedInUser => ({
  id: user.id,
  name: user.global_name ?? user.username,
  avatarUrl: avatarUrlOf(user),
});

export class DiscordOAuth extends Context.Service<
  DiscordOAuth,
  {
    exchange(code: string): Effect.Effect<DiscordGrant, DiscordRefused>;
  }
>()("activity-sign-in/DiscordOAuth") {
  static readonly layer = Layer.effect(
    DiscordOAuth,
    Effect.gen(function* () {
      const { clientId, clientSecret } = yield* SignInSettings;

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(DISCORD_API)),
      );

      const send = (request: HttpClientRequest.HttpClientRequest) =>
        client.execute(request).pipe(Effect.mapError(() => DiscordRefused.make({ status: 0 })));

      const exchange = Effect.fn("DiscordOAuth.exchange")(function* (code: string) {
        const { access_token } = yield* HttpClientRequest.post("/oauth2/token").pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: clientId,
            client_secret: Redacted.value(clientSecret),
            grant_type: "authorization_code",
            code,
          }),
          send,
          Effect.flatMap(readToken),
        );

        const user = yield* HttpClientRequest.get("/users/@me").pipe(
          HttpClientRequest.bearerToken(access_token),
          send,
          Effect.flatMap(readUser),
        );

        const grant: DiscordGrant = { accessToken: access_token, user: signedInUserOf(user) };

        return grant;
      });

      return DiscordOAuth.of({ exchange });
    }),
  );
}
