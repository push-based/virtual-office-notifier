import { DiscordOAuth } from "activity-sign-in/DiscordOAuth";
import { Sessions } from "activity-sign-in/Sessions";
import { DiscordRefused, SignedInSession, SignInConfig } from "activity-sign-in/SignInApi";
import { SignInSettings } from "activity-sign-in/SignInSettings";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { RecordingApi } from "../src/RecordingApi.ts";
import { HistoryHandlers, RecordingHandlers } from "../src/RecordingHandlers.ts";
import { RecordingHistory } from "../src/RecordingHistory.ts";
import { RecordingRequests } from "../src/RecordingRequests.ts";
import { SignedInLayer, SignInHandlers } from "../src/SignInHandlers.ts";

const ada = { id: "u1", name: "Ada", avatarUrl: null };

const Discord = Layer.succeed(
  DiscordOAuth,
  DiscordOAuth.of({
    exchange: (code) =>
      code === "good-code"
        ? Effect.succeed({ accessToken: "t0k3n", user: ada })
        : Effect.fail(DiscordRefused.make({ status: 400 })),
  }),
);

const Settings = Layer.succeed(
  SignInSettings,
  SignInSettings.of({
    clientId: "client-id",
    clientSecret: Redacted.make("client-secret"),
    sessionSecret: Redacted.make("session-secret"),
  }),
);

const app = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(RecordingApi).pipe(
    Layer.provide([
      SignInHandlers.pipe(Layer.provide(Discord)),
      RecordingHandlers.pipe(Layer.provide(RecordingRequests.layerDisabled)),
      HistoryHandlers.pipe(Layer.provide(RecordingHistory.layerDisabled)),
    ]),
    Layer.provideMerge(SignedInLayer),
    Layer.provide(Sessions.layer),
    Layer.provide(Settings),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);

afterAll(() => app.dispose());

const send = (path: string, init?: RequestInit) =>
  Effect.promise(() => app.handler(new Request(`http://recorder.test${path}`, init)));

const signIn = (body: string) =>
  send("/api/token", { method: "POST", headers: { "content-type": "application/json" }, body });

const bodyOf = (response: Response) => Effect.promise(() => response.text());

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(SignInConfig));

const decodeSignedIn = Schema.decodeEffect(Schema.fromJsonString(SignedInSession));

describe("the sign-in API", () => {
  it.effect("tells the page which Discord application to sign in to", () =>
    Effect.gen(function* () {
      const response = yield* send("/api/config");

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* decodeConfig(yield* bodyOf(response)), {
        clientId: "client-id",
      });
    }),
  );

  it.effect("signs in with a Discord code and accepts the session it issues", () =>
    Effect.gen(function* () {
      const response = yield* signIn('{"code":"good-code"}');

      assert.strictEqual(response.status, 200);

      const signedIn = yield* decodeSignedIn(yield* bodyOf(response));

      assert.strictEqual(signedIn.accessToken, "t0k3n");
      assert.deepStrictEqual(signedIn.user, ada);

      const status = yield* send("/api/status", {
        headers: { authorization: `Bearer ${signedIn.session}` },
      });

      assert.strictEqual(status.status, 503);
    }),
  );

  it.effect("turns away a session it didn't issue", () =>
    Effect.gen(function* () {
      const status = yield* send("/api/status", { headers: { authorization: "Bearer forged" } });

      assert.strictEqual(status.status, 401);
    }),
  );

  it.effect("answers 502 when Discord refuses the code", () =>
    Effect.gen(function* () {
      const response = yield* signIn('{"code":"expired-code"}');

      assert.strictEqual(response.status, 502);
    }),
  );

  it.effect("answers 400 to a body without a code", () =>
    Effect.gen(function* () {
      for (const body of ["{}", '{"code":""}', "not json"]) {
        const response = yield* signIn(body);

        assert.strictEqual(response.status, 400);
      }
    }),
  );

  it.effect("answers 404 to a path the API doesn't declare", () =>
    Effect.gen(function* () {
      const response = yield* send("/api/nothing-here");

      assert.strictEqual(response.status, 404);
    }),
  );
});
