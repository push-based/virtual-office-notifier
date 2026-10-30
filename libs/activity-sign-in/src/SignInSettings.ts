import { Config, Context, Effect, Layer, type Redacted, Schema } from "effect";

const secret = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export class SignInSettings extends Context.Service<
  SignInSettings,
  {
    readonly clientId: string;
    readonly clientSecret: Redacted.Redacted<string>;
    readonly sessionSecret: Redacted.Redacted<string>;
  }
>()("activity-sign-in/SignInSettings") {
  static readonly layerConfig = Layer.effect(
    SignInSettings,
    Effect.gen(function* () {
      const settings = yield* Config.all({
        clientId: Config.NonEmptyString("DISCORD_CLIENT_ID"),
        clientSecret: secret("DISCORD_CLIENT_SECRET"),
        sessionSecret: secret("SESSION_SECRET"),
      });

      return SignInSettings.of(settings);
    }),
  );
}
