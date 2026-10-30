import { PgClient } from "@effect/sql-pg";
import { DiscordOAuth } from "activity-sign-in/DiscordOAuth";
import { Sessions } from "activity-sign-in/Sessions";
import { SignInSettings } from "activity-sign-in/SignInSettings";
import { Layer, Redacted } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { RecordingApi } from "recording-requests/RecordingApi";
import { HistoryHandlers, RecordingHandlers } from "recording-requests/RecordingHandlers";
import { RecordingHistory } from "recording-requests/RecordingHistory";
import { RecordingRequests } from "recording-requests/RecordingRequests";
import { SignedInLayer, SignInHandlers } from "recording-requests/SignInHandlers";
import { columnNaming } from "recording-requests/SqlNaming";

interface Env {
  readonly DISCORD_CLIENT_ID: string;
  readonly DISCORD_CLIENT_SECRET: string;
  readonly DATABASE: Hyperdrive;
  readonly SESSION_SECRET: string;
}

const settingsFrom = (env: Env) =>
  Layer.succeed(
    SignInSettings,
    SignInSettings.of({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: Redacted.make(env.DISCORD_CLIENT_SECRET),
      sessionSecret: Redacted.make(env.SESSION_SECRET),
    }),
  );

const connectionTo = (env: Env) =>
  PgClient.layer({
    url: Redacted.make(env.DATABASE.connectionString),
    ssl: false,
    maxConnections: 1,
    applicationName: "virtual-office-recorder",
    ...columnNaming,
  });

const routes = (env: Env) =>
  HttpApiBuilder.layer(RecordingApi).pipe(
    Layer.provide([
      SignInHandlers.pipe(Layer.provide(DiscordOAuth.layer)),
      RecordingHandlers.pipe(Layer.provide(RecordingRequests.layerPerCall(connectionTo(env)))),
      HistoryHandlers.pipe(Layer.provide(RecordingHistory.layerPerCall(connectionTo(env)))),
    ]),
    Layer.provideMerge(SignedInLayer),
    Layer.provide(Sessions.layer),
    Layer.provide([settingsFrom(env), FetchHttpClient.layer]),
    Layer.provide(HttpServer.layerServices),
  );

const makeApp = (env: Env) => HttpRouter.toWebHandler(routes(env), { disableLogger: true });

const apps = new WeakMap<Env, ReturnType<typeof makeApp>>();

const appFor = (env: Env) => {
  const existing = apps.get(env);

  if (existing !== undefined) return existing;

  const app = makeApp(env);

  apps.set(env, app);

  return app;
};

export default {
  fetch: (request: Request, env: Env): Promise<Response> => appFor(env).handler(request),
};
