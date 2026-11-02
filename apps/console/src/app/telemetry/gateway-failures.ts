import type { HttpErrorResponse } from "@angular/common/http";
import { InjectionToken } from "@angular/core";
import * as Sentry from "@sentry/angular";

export const BODY_LIMIT = 200;

const SAFE_HEADERS = ["retry-after", "cf-ray", "server", "via", "content-type"] as const;

export type FailureDetails = Readonly<Record<string, string>>;

const bodyOf = (error: HttpErrorResponse): string | null => {
  const body: unknown = error.error;

  if (body === null || body === undefined || body instanceof ProgressEvent) return null;

  return body instanceof Object ? JSON.stringify(body) : String(body);
};

export const describeGatewayFailure = (error: HttpErrorResponse): FailureDetails => {
  const headers = SAFE_HEADERS.flatMap((name) => {
    const value = error.headers.get(name);

    return value === null ? [] : [[name, value] as const];
  });

  const body = bodyOf(error);

  return Object.fromEntries([
    ["status", String(error.status)],
    ["statusText", error.statusText],
    ...headers,
    ...(body === null ? [] : [["body", body.slice(0, BODY_LIMIT)] as const]),
  ]);
};

export interface GatewayFailures {
  retrying(url: string, error: HttpErrorResponse): void;
  gaveUp(url: string, error: HttpErrorResponse): void;
}

export const sentryGatewayFailures: GatewayFailures = {
  retrying: (url, error) => {
    Sentry.addBreadcrumb({
      category: "http.retry",
      level: "warning",
      message: `${url} answered ${error.status}, asking again`,
      data: describeGatewayFailure(error),
    });
  },
  gaveUp: (url, error) => {
    Sentry.captureMessage(`${url} kept answering ${error.status}`, {
      level: "warning",
      fingerprint: ["gateway-failure", String(error.status)],
      contexts: { response: describeGatewayFailure(error) },
    });
  },
};

export const GATEWAY_FAILURES = new InjectionToken<GatewayFailures>("GatewayFailures", {
  providedIn: "root",
  factory: () => sentryGatewayFailures,
});
