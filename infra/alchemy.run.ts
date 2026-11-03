import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack } from "alchemy";
import { Config, Effect } from "effect";

const CONSOLE_DATABASE = "09613040911943369f00c74637e7d3a5";

export default Stack(
  "virtual-office",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    const console = yield* Cloudflare.Website.Vite("Console", {
      name: stage === "prod" ? "virtual-office-recorder" : `virtual-office-recorder-${stage}`,
      rootDir: "../apps/console",
      main: "worker/index.ts",
      compatibility: { date: "2026-10-24", flags: ["nodejs_compat"] },
      assets: { runWorkerFirst: ["/api/*"] },
      observability: { enabled: true },
      env: {
        DATABASE: Cloudflare.Hyperdrive.lookup("ConsoleDatabase", {
          hyperdriveId: CONSOLE_DATABASE,
        }),
        DISCORD_CLIENT_ID: yield* Config.Redacted("DISCORD_CLIENT_ID"),
        DISCORD_CLIENT_SECRET: yield* Config.Redacted("DISCORD_CLIENT_SECRET"),
        SESSION_SECRET: yield* Config.Redacted("SESSION_SECRET"),
        SENTRY_DSN: yield* Config.Redacted("SENTRY_CONSOLE_DSN"),
        SENTRY_ENVIRONMENT: "production",
        SENTRY_RELEASE: yield* Config.String("GITHUB_SHA").pipe(Config.withDefault("local")),
      },
    });

    return { console: console.url };
  }),
);
