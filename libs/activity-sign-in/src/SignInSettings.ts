import { Context, type Redacted } from "effect";

export class SignInSettings extends Context.Service<
  SignInSettings,
  {
    readonly clientId: string;
    readonly clientSecret: Redacted.Redacted<string>;
    readonly sessionSecret: Redacted.Redacted<string>;
  }
>()("activity-sign-in/SignInSettings") {}
