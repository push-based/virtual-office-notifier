import { HttpClient } from "@angular/common/http";
import {
  type EnvironmentProviders,
  ErrorHandler,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from "@angular/core";
import * as Sentry from "@sentry/angular";

export interface Telemetry {
  readonly dsn: string;
  readonly environment: string;
  readonly release: string | null;
}

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

export const provideTelemetry = (): EnvironmentProviders =>
  makeEnvironmentProviders([
    { provide: ErrorHandler, useValue: Sentry.createErrorHandler() },
    provideAppInitializer(() => {
      inject(HttpClient)
        .get<Telemetry | null>("/api/telemetry")
        .subscribe({
          next: (telemetry) => {
            if (telemetry !== null) Sentry.init(sentryOptionsFor(telemetry));
          },
          error: () => undefined,
        });
    }),
  ]);
