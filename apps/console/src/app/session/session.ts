import { DiscordSDK } from "@discord/embedded-app-sdk";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";

import { type ApiFailure, ConsoleApi, reasonOf, SessionToken } from "../api/api.ts";
import type { Presence } from "../recorder/describe-presence.ts";

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

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const askWorker = <A, E extends ApiFailure, R>(asking: Effect.Effect<A, E, R>) =>
  Effect.mapError(asking, (failure) => new SignInFailure({ reason: reasonOf(failure) }));

const fromDiscord = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new SignInFailure({ reason: messageOf(cause) }),
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
      const api = yield* ConsoleApi;
      const token = yield* SessionToken;
      const createClient = yield* DiscordClients;
      const linked = yield* Ref.make(Option.none<DiscordClient>());

      const signIn = Effect.gen(function* () {
        const { clientId } = yield* askWorker(api.signIn.config());

        const discord = yield* Effect.try({
          try: () => createClient(clientId),
          catch: (cause) => new SignInFailure({ reason: messageOf(cause) }),
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

        const session = yield* askWorker(api.signIn.token({ payload: { code } }));

        yield* Ref.set(token, Option.some(session.session));
        yield* fromDiscord(() =>
          discord.commands.authenticate({ access_token: session.accessToken }),
        );
        yield* Ref.set(linked, Option.some(discord));
      });

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
                  catch: (cause) => new LinkFailure({ reason: messageOf(cause) }),
                }).pipe(Effect.asVoid),
            }),
          ),
        );

      return Session.of({ signIn, showPresence, openExternalLink });
    }),
  );
}
