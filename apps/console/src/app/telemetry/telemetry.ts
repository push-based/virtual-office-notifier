import * as Sentry from "@sentry/browser";
import { Effect, Schema } from "effect";

import * as Api from "../api/api.ts";

export const Telemetry = Schema.Struct({
  dsn: Schema.String,
  environment: Schema.String,
  release: Schema.NullOr(Schema.String),
});

export type Telemetry = typeof Telemetry.Type;

export const TUNNEL = "/api/sentry";

export const sentryOptionsFor = ({
  dsn,
  environment,
  release,
}: Telemetry): Sentry.BrowserOptions => ({
  dsn,
  environment,
  release: release ?? undefined,
  tunnel: TUNNEL,
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
