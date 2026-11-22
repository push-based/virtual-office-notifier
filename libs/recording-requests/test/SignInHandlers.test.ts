import { afterAll, assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SignedInSession, SignInConfig } from "office-domain/SignInApi";

import { ada, bodyOf, serveApi } from "./api.ts";

const { send, dispose } = serveApi();

afterAll(dispose);

const signIn = (body: string) =>
  send("/api/token", { method: "POST", headers: { "content-type": "application/json" }, body });

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
});
