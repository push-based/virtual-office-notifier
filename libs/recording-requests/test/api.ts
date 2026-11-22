import { DiscordOAuth } from "activity-sign-in/DiscordOAuth";
import { Sessions } from "activity-sign-in/Sessions";
import { SignInSettings } from "activity-sign-in/SignInSettings";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { RecordingApi } from "office-domain/RecordingApi";
import { DiscordRefused } from "office-domain/SignInApi";

import { ConsentHandlers, ErasureAdminHandlers } from "../src/ConsentHandlers.ts";
import { ConsentRequests } from "../src/ConsentRequests.ts";
import { OfficeStatsReader } from "../src/OfficeStats.ts";
import { EditHandlers, HistoryHandlers, RecordingHandlers } from "../src/RecordingHandlers.ts";
import { RecordingEdits } from "../src/RecordingEdits.ts";
import { RecordingHistory } from "../src/RecordingHistory.ts";
import { RecordingRequests } from "../src/RecordingRequests.ts";
import { SignedInLayer, SignInHandlers } from "../src/SignInHandlers.ts";
import { StatsHandlers } from "../src/StatsHandlers.ts";
import { TelemetryHandlers } from "../src/TelemetryHandlers.ts";

export const ada = { id: "u1", name: "Ada", avatarUrl: null };

const Discord = Layer.succeed(
  DiscordOAuth,
  DiscordOAuth.of({
    exchange: (code) =>
      code === "good-code"
        ? Effect.succeed({ accessToken: "t0k3n", user: ada })
        : Effect.fail(DiscordRefused.make({ status: 400 })),
  }),
);

const Settings = Layer.succeed(
  SignInSettings,
  SignInSettings.of({
    clientId: "client-id",
    clientSecret: Redacted.make("client-secret"),
    sessionSecret: Redacted.make("session-secret"),
  }),
);

interface Backends {
  readonly history?: Layer.Layer<RecordingHistory>;
  readonly edits?: Layer.Layer<RecordingEdits>;
  readonly admins?: Layer.Layer<ConsentRequests>;
}

export const serveApi = ({
  history = RecordingHistory.layerDisabled,
  edits = RecordingEdits.layerDisabled,
  admins = ConsentRequests.layerDisabled,
}: Backends = {}) => {
  const app = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(RecordingApi).pipe(
      Layer.provide([
        SignInHandlers.pipe(Layer.provide(Discord)),
        RecordingHandlers.pipe(Layer.provide(RecordingRequests.layerDisabled)),
        TelemetryHandlers(Option.none()),
        StatsHandlers.pipe(Layer.provide(OfficeStatsReader.layerDisabled)),
        HistoryHandlers.pipe(Layer.provide(history)),
        EditHandlers.pipe(Layer.provide(edits)),
        ConsentHandlers.pipe(Layer.provide(ConsentRequests.layerDisabled)),
        ErasureAdminHandlers.pipe(Layer.provide(admins)),
      ]),
      Layer.provideMerge(SignedInLayer),
      Layer.provide(Sessions.layer),
      Layer.provide(Settings),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  const send = (path: string, init?: RequestInit) =>
    Effect.promise(() => app.handler(new Request(`http://recorder.test${path}`, init)));

  return { send, dispose: () => app.dispose() };
};

export const bodyOf = (response: Response) => Effect.promise(() => response.text());
