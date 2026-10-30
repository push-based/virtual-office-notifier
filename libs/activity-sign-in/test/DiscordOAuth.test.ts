import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { DiscordOAuth } from "../src/DiscordOAuth.ts";
import { SignInSettings } from "../src/SignInSettings.ts";

interface DiscordReply {
  readonly status: number;
  readonly body: string;
}

const tokenReply: DiscordReply = { status: 200, body: JSON.stringify({ access_token: "t0k3n" }) };

interface DiscordProfile {
  readonly id: string;
  readonly username?: string;
  readonly global_name?: string | null;
  readonly avatar?: string | null;
}

const userReply = (user: DiscordProfile): DiscordReply => ({
  status: 200,
  body: JSON.stringify(user),
});

const Settings = Layer.succeed(
  SignInSettings,
  SignInSettings.of({
    clientId: "client-id",
    clientSecret: Redacted.make("client-secret"),
    sessionSecret: Redacted.make("session-secret"),
  }),
);

const discordAnswering = (
  replies: ReadonlyArray<DiscordReply>,
  sent: Array<HttpClientRequest.HttpClientRequest> = [],
) =>
  DiscordOAuth.layer.pipe(
    Layer.provide(Settings),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const reply = replies[sent.length];

          sent.push(request);

          return reply === undefined
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              )
            : Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(reply.body, { status: reply.status }),
                ),
              );
        }),
      ),
    ),
  );

const refusal = (code: string) =>
  Effect.gen(function* () {
    const discord = yield* DiscordOAuth;

    return yield* discord.exchange(code).pipe(Effect.flip);
  });

describe("DiscordOAuth", () => {
  it.effect("trades the code for a token and reads who signed in", () => {
    const sent: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const discord = yield* DiscordOAuth;
      const grant = yield* discord.exchange("the-code");

      assert.deepStrictEqual(grant, {
        accessToken: "t0k3n",
        user: {
          id: "42",
          name: "Ada Lovelace",
          avatarUrl: "https://cdn.discordapp.com/avatars/42/abc.png?size=128",
        },
      });

      const [token, me] = sent;

      assert.strictEqual(token?.method, "POST");
      assert.strictEqual(token?.url, "https://discord.com/api/oauth2/token");
      assert.strictEqual(
        token?.body._tag === "Uint8Array" ? new TextDecoder().decode(token.body.body) : "",
        "client_id=client-id&client_secret=client-secret&grant_type=authorization_code&code=the-code",
      );
      assert.strictEqual(me?.method, "GET");
      assert.strictEqual(me?.url, "https://discord.com/api/users/@me");
      assert.strictEqual(me?.headers["authorization"], "Bearer t0k3n");
    }).pipe(
      Effect.provide(
        discordAnswering(
          [
            tokenReply,
            userReply({ id: "42", username: "ada", global_name: "Ada Lovelace", avatar: "abc" }),
          ],
          sent,
        ),
      ),
    );
  });

  it.effect("falls back to the username and no avatar", () =>
    Effect.gen(function* () {
      const discord = yield* DiscordOAuth;
      const { user } = yield* discord.exchange("the-code");

      assert.deepStrictEqual(user, { id: "42", name: "ada", avatarUrl: null });
    }).pipe(
      Effect.provide(
        discordAnswering([
          tokenReply,
          userReply({ id: "42", username: "ada", global_name: null, avatar: null }),
        ]),
      ),
    ),
  );

  it.effect("reports the status when Discord refuses the code", () =>
    Effect.gen(function* () {
      const error = yield* refusal("expired-code");

      assert.strictEqual(error._tag, "DiscordRefused");
      assert.strictEqual(error.status, 400);
    }).pipe(Effect.provide(discordAnswering([{ status: 400, body: '{"error":"invalid_grant"}' }]))),
  );

  it.effect("refuses an answer it can't read", () =>
    Effect.gen(function* () {
      const error = yield* refusal("the-code");

      assert.strictEqual(error.status, 200);
    }).pipe(Effect.provide(discordAnswering([tokenReply, userReply({ id: "42" })]))),
  );

  it.effect("refuses with status 0 when Discord can't be reached", () =>
    Effect.gen(function* () {
      const error = yield* refusal("the-code");

      assert.strictEqual(error.status, 0);
    }).pipe(Effect.provide(discordAnswering([]))),
  );
});
