import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy, Stack } from "alchemy";
import { Config, Effect } from "effect";

import { SUPABASE_ROOT_CA } from "../apps/bot/src/database/SupabaseCa.ts";

const SUPABASE_POOLER = "aws-0-eu-west-1.pooler.supabase.com";

const SUPABASE_PROJECT = "hebglmbkqnypytihrwyr";

export default Stack(
  "virtual-office",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const live = stage === "prod";

    const supabaseCa = yield* Cloudflare.MtlsCertificate.MtlsCertificate("SupabaseCa", {
      name: live ? "supabase-root-2021" : `supabase-root-2021-${stage}`,
      ca: true,
      certificates: SUPABASE_ROOT_CA,
    }).pipe(RemovalPolicy.retain(live));

    const database = yield* Cloudflare.Hyperdrive.Connection("ConsoleDatabase", {
      name: live ? "virtual-office-recorder-db" : `virtual-office-recorder-db-${stage}`,
      origin: {
        scheme: "postgresql",
        host: SUPABASE_POOLER,
        port: 5432,
        database: "postgres",
        user: `activity.${SUPABASE_PROJECT}`,
        password: yield* Config.Redacted("ACTIVITY_DATABASE_PASSWORD"),
      },
      caching: { disabled: true },
      mtls: { caCertificateId: supabaseCa.mtlsCertificateId, sslmode: "verify-full" },
      originConnectionLimit: 20,
    }).pipe(RemovalPolicy.retain(live));

    const console = yield* Cloudflare.Website.Vite("Console", {
      name: live ? "virtual-office-recorder" : `virtual-office-recorder-${stage}`,
      rootDir: "../apps/console",
      main: "worker/index.ts",
      compatibility: { date: "2026-10-24", flags: ["nodejs_compat"] },
      assets: { runWorkerFirst: ["/api/*"] },
      observability: { enabled: true },
      env: {
        DATABASE: database,
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
