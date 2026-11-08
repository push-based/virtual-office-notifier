import { PgClient } from "@effect/sql-pg";
import * as Sentry from "@sentry/cloudflare";
import { env } from "cloudflare:workers";
import { DiscordOAuth } from "activity-sign-in/DiscordOAuth";
import { Sessions } from "activity-sign-in/Sessions";
import { SignInSettings } from "activity-sign-in/SignInSettings";
import { ConfigProvider, Function, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { ConsentHandlers, ErasureAdminHandlers } from "recording-requests/ConsentHandlers";
import { ConsentRequests } from "recording-requests/ConsentRequests";
import { OfficeStatsReader } from "recording-requests/OfficeStats";
import { RecordingApi } from "recording-requests/RecordingApi";
import {
  EditHandlers,
  HistoryHandlers,
  RecordingHandlers,
} from "recording-requests/RecordingHandlers";
import { RecordingEdits } from "recording-requests/RecordingEdits";
import { RecordingHistory } from "recording-requests/RecordingHistory";
import { RecordingRequests } from "recording-requests/RecordingRequests";
import { SignedInLayer, SignInHandlers } from "recording-requests/SignInHandlers";
import { StatsHandlers } from "recording-requests/StatsHandlers";
import { columnNaming } from "recording-requests/SqlNaming";

import {
  ObservabilityLayer,
  RouteSpanNames,
  type SentryEnv,
  sentryOptions,
  telemetryFrom,
} from "./Observability.ts";
import { TelemetryRoutes } from "./Telemetry.ts";

declare global {
  namespace Cloudflare {
    interface Env extends SentryEnv {
      readonly DISCORD_CLIENT_ID: string;
      readonly DISCORD_CLIENT_SECRET: string;
      readonly DATABASE: Hyperdrive;
      readonly SESSION_SECRET: string;
    }
  }
}

declare const __SENTRY_RELEASE__: string;

type Env = Cloudflare.Env;

const connectionTo = (env: Env) =>
  PgClient.layer({
    url: Redacted.make(env.DATABASE.connectionString),
    ssl: false,
    maxConnections: 1,
    applicationName: "virtual-office-console",
    ...columnNaming,
  });

const api = (env: Env) =>
  HttpApiBuilder.layer(RecordingApi).pipe(
    Layer.provide([
      SignInHandlers.pipe(Layer.provide(DiscordOAuth.layer)),
      RecordingHandlers.pipe(Layer.provide(RecordingRequests.layerPerCall(connectionTo(env)))),
      StatsHandlers.pipe(Layer.provide(OfficeStatsReader.layerPerCall(connectionTo(env)))),
      HistoryHandlers.pipe(Layer.provide(RecordingHistory.layerPerCall(connectionTo(env)))),
      EditHandlers.pipe(Layer.provide(RecordingEdits.layerPerCall(connectionTo(env)))),
      ConsentHandlers.pipe(Layer.provide(ConsentRequests.layerPerCall(connectionTo(env)))),
      ErasureAdminHandlers.pipe(Layer.provide(ConsentRequests.layerPerCall(connectionTo(env)))),
    ]),
    Layer.provideMerge(SignedInLayer),
    Layer.provide(Sessions.layer),
    Layer.provide(SignInSettings.layerConfig),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

const routes = (env: Env) =>
  Layer.mergeAll(api(env), TelemetryRoutes(telemetryFrom(env, __SENTRY_RELEASE__))).pipe(
    Layer.provide([RouteSpanNames.layer, FetchHttpClient.layer, HttpServer.layerServices]),
    Layer.provideMerge(ObservabilityLayer),
  );

const appFor = Function.memoize((bindings: Env) =>
  HttpRouter.toWebHandler(routes(bindings), { disableLogger: true }),
);

export default Sentry.withSentry<Env>((bindings) => sentryOptions(bindings, __SENTRY_RELEASE__), {
  fetch: (request) => appFor(env).handler(request),
});
