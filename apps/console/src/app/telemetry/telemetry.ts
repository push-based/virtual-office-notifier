import * as Sentry from "@sentry/browser";
import { Array, Effect } from "effect";
import { type Telemetry, TUNNEL_PATH } from "office-domain/Telemetry";

import { ConsoleApi } from "../api/api.ts";

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
    ...Array.filter(defaults, ({ name }) => name !== "Console"),
    Sentry.breadcrumbsIntegration({ dom: false }),
    Sentry.browserTracingIntegration(),
  ],
});

export const startTelemetry = ConsoleApi.use((api) => api.telemetry.config()).pipe(
  Effect.flatMap((telemetry) =>
    telemetry === null ? Effect.void : Effect.sync(() => Sentry.init(sentryOptionsFor(telemetry))),
  ),
  Effect.ignore,
);

export const reportCrash = (error: Error): void => {
  Sentry.captureException(error);
};
