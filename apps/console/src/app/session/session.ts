import { DiscordSDK } from "@discord/embedded-app-sdk";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import type { HttpClient } from "effect/http";

import * as Api from "../api/api.ts";
import type { Presence } from "../recorder/describe-presence.ts";
import { type SignInCode, SignInConfig, SignedInSession } from "../wire.ts";

export type DiscordClient = Pick<DiscordSDK, "ready"> & {
  readonly commands: Pick<
    DiscordSDK["commands"],
    "authorize" | "authenticate" | "setActivity" | "openExternalLink"
  >;
};

export const DiscordClients = Context.Reference<(clientId: string) => DiscordClient>(
  "console/session/DiscordClients",
  { defaultValue: () => (clientId) => new DiscordSDK(clientId) },
);

export class SignInFailure extends Schema.TaggedError<
  SignInFailure,
  { readonly brand: unique symbol }
>()("SignInFailure", {
  reason: Schema.String,
}) {}

export class LinkFailure extends Schema.TaggedError<
  LinkFailure,
  { readonly brand: unique symbol }
>()("LinkFailure", {
  reason: Schema.String,
}) {}

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const fromDiscord = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new SignInFailure({ reason: reasonOf(cause) }),
  });

export class Session extends Context.Service<
  Session,
  {
    readonly signIn: Effect.Effect<void, SignInFailure>;
    readonly showPresence: (presence: Presence) => Effect.Effect<void>;
    readonly openExternalLink: (url: string) => Effect.Effect<void, LinkFailure>;
  }
>()("console/session/Session") {
  static readonly layer = Layer.effect(
    Session,
    Effect.gen(function* () {
      const http = yield* Effect.context<HttpClient.HttpClient | Api.SessionToken>();
      const token = yield* Api.SessionToken;
      const createClient = yield* DiscordClients;
      const linked = yield* Ref.make(Option.none<DiscordClient>());

      const signIn = Effect.gen(function* () {
        const { clientId } = yield* Api.get("/api/config", SignInConfig);

        const discord = yield* Effect.try({
          try: () => createClient(clientId),
          catch: (cause) => new SignInFailure({ reason: reasonOf(cause) }),
        });

        yield* fromDiscord(() => discord.ready());

        const { code } = yield* fromDiscord(() =>
          discord.commands.authorize({
            client_id: clientId,
            response_type: "code",
            state: "",
            prompt: "none",
            scope: ["identify", "rpc.activities.write"],
          }),
        );

        const body: SignInCode = { code };
        const session = yield* Api.post("/api/token", SignedInSession, body);

        yield* Ref.set(token, Option.some(session.session));
        yield* fromDiscord(() =>
          discord.commands.authenticate({ access_token: session.accessToken }),
        );
        yield* Ref.set(linked, Option.some(discord));
      }).pipe(
        Effect.catchTag("ApiFailure", (failure) =>
          Effect.fail(new SignInFailure({ reason: failure.reason })),
        ),
        Effect.provide(http),
      );

      const showPresence = (presence: Presence) =>
        Ref.get(linked).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (discord) =>
                Effect.tryPromise(() => discord.commands.setActivity({ activity: presence })).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Couldn't update the Rich Presence", cause),
                  ),
                ),
            }),
          ),
        );

      const openExternalLink = (url: string) =>
        Ref.get(linked).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (discord) =>
                Effect.tryPromise({
                  try: () => discord.commands.openExternalLink({ url }),
                  catch: (cause) => new LinkFailure({ reason: reasonOf(cause) }),
                }).pipe(Effect.asVoid),
            }),
          ),
        );

      return Session.of({ signIn, showPresence, openExternalLink });
    }),
  );
}
