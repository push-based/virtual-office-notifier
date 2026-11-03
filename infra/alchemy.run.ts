import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GCP from "@alchemy.run/gcp";
import { RemovalPolicy, Stack } from "alchemy";
import { Config, Effect, Layer } from "effect";

import { SUPABASE_ROOT_CA } from "../apps/bot/src/database/SupabaseCa.ts";

const SUPABASE_POOLER = "aws-0-eu-west-1.pooler.supabase.com";

const SUPABASE_PROJECT = "hebglmbkqnypytihrwyr";

const VM_SERVICE_ACCOUNT = "132656138437-compute@developer.gserviceaccount.com";

const VM_SCOPES = [
  "https://www.googleapis.com/auth/devstorage.read_only",
  "https://www.googleapis.com/auth/logging.write",
  "https://www.googleapis.com/auth/monitoring.write",
  "https://www.googleapis.com/auth/pubsub",
  "https://www.googleapis.com/auth/service.management.readonly",
  "https://www.googleapis.com/auth/servicecontrol",
  "https://www.googleapis.com/auth/trace.append",
  "https://www.googleapis.com/auth/devstorage.read_write",
];

const officeMachine = Effect.gen(function* () {
  const recordings = yield* GCP.Storage.Bucket("Recordings", {
    bucketName: "virtual-office-notifier-recordings",
    location: "US-CENTRAL1",
    storageClass: "STANDARD",
    uniformBucketLevelAccess: true,
    versioning: false,
    forceDestroy: false,
  }).pipe(RemovalPolicy.retain());

  const vm = yield* GCP.Compute.Instance("Vm", {
    instanceName: "virtual-office-notifier",
    zone: "us-central1-a",
    machineType: "e2-micro",
    serviceAccount: VM_SERVICE_ACCOUNT,
    oauthScopes: VM_SCOPES,
    metadata: { "enable-oslogin": "TRUE" },
    associatePublicIp: true,
    deletionProtection: true,
  }).pipe(RemovalPolicy.retain());

  for (const [id, role] of [
    ["VmWritesClips", "roles/storage.objectCreator"],
    ["VmReadsClips", "roles/storage.objectViewer"],
  ] as const) {
    yield* GCP.IAM.Member(id, {
      kind: "storage.bucket",
      name: recordings.bucketName,
      role,
      member: `serviceAccount:${VM_SERVICE_ACCOUNT}`,
    });
  }

  return { vm: vm.instanceName, recordings: recordings.bucketName };
});

export default Stack(
  "virtual-office",
  { providers: Layer.mergeAll(Cloudflare.providers(), GCP.providers()), state: Cloudflare.state() },
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

    const office = live ? yield* officeMachine : undefined;

    return { console: console.url, ...office };
  }),
);
