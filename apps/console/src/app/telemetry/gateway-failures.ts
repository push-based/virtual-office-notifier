import { Array, Context, Effect, pipe, Record, String } from "effect";

import { loadSentry } from "./sentry.ts";

export const BODY_LIMIT = 200;

const SAFE_HEADERS = ["retry-after", "cf-ray", "server", "via", "content-type"] as const;

type FailureDetails = Readonly<Record<string, string>>;

interface FailedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export const describeGatewayFailure = (response: FailedResponse): FailureDetails => {
  const headers = Array.flatMap(SAFE_HEADERS, (name) => {
    const value = response.headers[name];

    return value === undefined ? [] : [[name, value] as const];
  });

  return Record.fromEntries([
    ["status", `${response.status}`] as const,
    ...headers,
    ...(response.body === ""
      ? []
      : [["body", pipe(response.body, String.slice(0, BODY_LIMIT))] as const]),
  ]);
};

export interface GatewayFailure {
  readonly path: string;
  readonly status: number;
  readonly details: FailureDetails;
}

interface GatewayFailuresService {
  readonly retrying: (failure: GatewayFailure) => Effect.Effect<void>;
  readonly gaveUp: (failure: GatewayFailure) => Effect.Effect<void>;
}

const sentryGatewayFailures: GatewayFailuresService = {
  retrying: (failure) =>
    Effect.promise(loadSentry).pipe(
      Effect.map((Sentry) =>
        Sentry.addBreadcrumb({
          category: "http.retry",
          level: "warning",
          message: `${failure.path} answered ${failure.status}, asking again`,
          data: failure.details,
        }),
      ),
    ),
  gaveUp: (failure) =>
    Effect.promise(loadSentry).pipe(
      Effect.map((Sentry) => {
        Sentry.captureMessage(`${failure.path} kept answering ${failure.status}`, {
          level: "warning",
          fingerprint: ["gateway-failure", `${failure.status}`],
          contexts: { response: failure.details },
        });
      }),
    ),
};

export const GatewayFailures = Context.Reference<GatewayFailuresService>(
  "console/telemetry/GatewayFailures",
  { defaultValue: () => sentryGatewayFailures },
);
