import type { BrowserOptions } from "@sentry/browser";
import { Array, Effect } from "effect";
import { type Telemetry, TUNNEL_PATH } from "office-domain/Telemetry";

import { ConsoleApi } from "../api/api.ts";
import { loadSentry, type SentryModule } from "./sentry.ts";

export const sentryOptionsFor = (
  Sentry: SentryModule,
  { dsn, environment, release }: Telemetry,
): BrowserOptions => ({
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
    telemetry === null
      ? Effect.void
      : Effect.promise(loadSentry).pipe(
          Effect.map((Sentry) => Sentry.init(sentryOptionsFor(Sentry, telemetry))),
        ),
  ),
  Effect.ignore,
);

export const reportCrash = (error: Error): Promise<void> =>
  loadSentry().then((Sentry) => {
    Sentry.captureException(error);
  });
