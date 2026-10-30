import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

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

const decodeDiscordToken = Schema.decodeUnknownEffect(Schema.fromJsonString(DiscordToken));

const decodeDiscordUser = Schema.decodeUnknownEffect(Schema.fromJsonString(DiscordUser));

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
      const client = yield* HttpClient.HttpClient;

      const read = <A>(decode: (body: string) => Effect.Effect<A, Schema.SchemaError>) =>
        Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
          const response = yield* client
            .execute(request)
            .pipe(Effect.mapError(() => DiscordRefused.make({ status: 0 })));

          const refused = () => DiscordRefused.make({ status: response.status });

          if (response.status < 200 || response.status >= 300) return yield* refused();

          const body = yield* response.text.pipe(Effect.mapError(refused));

          return yield* decode(body).pipe(Effect.mapError(refused));
        });

      const exchange = Effect.fn("DiscordOAuth.exchange")(function* (code: string) {
        const { access_token } = yield* read(decodeDiscordToken)(
          HttpClientRequest.post(`${DISCORD_API}/oauth2/token`).pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: clientId,
              client_secret: Redacted.value(clientSecret),
              grant_type: "authorization_code",
              code,
            }),
          ),
        );

        const user = yield* read(decodeDiscordUser)(
          HttpClientRequest.get(`${DISCORD_API}/users/@me`).pipe(
            HttpClientRequest.bearerToken(access_token),
          ),
        );

        const grant: DiscordGrant = { accessToken: access_token, user: signedInUserOf(user) };

        return grant;
      });

      return DiscordOAuth.of({ exchange });
    }),
  );
}
