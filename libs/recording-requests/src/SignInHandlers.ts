import { DiscordOAuth } from "activity-sign-in/DiscordOAuth";
import { Sessions } from "activity-sign-in/Sessions";
import { SignInSettings } from "activity-sign-in/SignInSettings";
import { Effect, Layer, Redacted } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import {
  CurrentRequester,
  RecordingApi,
  type Requester,
  SignedIn,
  Unauthorized,
} from "./RecordingApi.ts";

export const SignInHandlers = HttpApiBuilder.group(
  RecordingApi,
  "signIn",
  Effect.fn(function* (handlers) {
    const { clientId } = yield* SignInSettings;
    const discord = yield* DiscordOAuth;
    const sessions = yield* Sessions;

    return handlers.handleAll({
      config: () => Effect.succeed({ clientId }),
      token: ({ payload }) =>
        Effect.gen(function* () {
          const { accessToken, user } = yield* discord.exchange(payload.code);
          const session = yield* sessions.issue(user);

          return { accessToken, session, user };
        }),
    });
  }),
);

export const SignedInLayer = Layer.effect(
  SignedIn,
  Effect.gen(function* () {
    const sessions = yield* Sessions;

    return SignedIn.of({
      session: (httpEffect, { credential }) =>
        sessions.verify(Redacted.value(credential)).pipe(
          Effect.mapError(() => Unauthorized.make()),
          Effect.flatMap(({ id, name }) => {
            const requester: Requester = { id, name };

            return Effect.provideService(httpEffect, CurrentRequester, requester);
          }),
        ),
    });
  }),
);
