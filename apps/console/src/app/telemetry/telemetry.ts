import * as Sentry from "@sentry/browser";
import { Effect, Schema } from "effect";
import { Telemetry, TUNNEL_PATH } from "office-domain/Telemetry";

import * as Api from "../api/api.ts";

export const sentryOptionsFor = ({
  dsn,
  environment,
  release,
}: Telemetry): Sentry.BrowserOptions => ({
  dsn,
  environment,
  release: release ?? undefined,
  tunnel: TUNNEL_PATH,
  tracesSampleRate: 1,
  dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [] },
  integrations: (defaults) => [
    ...defaults.filter(({ name }) => name !== "Console"),
    Sentry.breadcrumbsIntegration({ dom: false }),
    Sentry.browserTracingIntegration(),
  ],
});

export const startTelemetry = Api.get("/api/telemetry", Schema.NullOr(Telemetry)).pipe(
  Effect.flatMap((telemetry) =>
    telemetry === null ? Effect.void : Effect.sync(() => Sentry.init(sentryOptionsFor(telemetry))),
  ),
  Effect.ignore,
);

export const reportCrash = (error: Error): void => {
  Sentry.captureException(error);
};
