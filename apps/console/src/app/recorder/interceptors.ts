import { HttpErrorResponse, type HttpInterceptorFn } from "@angular/common/http";
import { InjectionToken, inject } from "@angular/core";
import { catchError, retry, tap, throwError, timer } from "rxjs";

import { GATEWAY_FAILURES } from "../telemetry/gateway-failures";
import { RecorderSession } from "./session";

export interface RetryTiming {
  readonly retries: number;
  readonly retryMs: number;
}

export const RETRY_TIMING = new InjectionToken<RetryTiming>("RetryTiming", {
  providedIn: "root",
  factory: () => ({ retries: 3, retryMs: 2000 }),
});

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([0, 502, 503, 504]);

const isGatewayFailure = (error: HttpErrorResponse): boolean => GATEWAY_STATUSES.has(error.status);

export const sessionInterceptor: HttpInterceptorFn = (request, next) => {
  const token = inject(RecorderSession).token();

  return next(
    token === null ? request : request.clone({ setHeaders: { authorization: `Bearer ${token}` } }),
  );
};

export const retryInterceptor: HttpInterceptorFn = (request, next) => {
  const { retries, retryMs } = inject(RETRY_TIMING);
  const failures = inject(GATEWAY_FAILURES);

  const sent =
    request.method === "GET"
      ? next(request).pipe(
          retry({
            count: retries,
            delay: (error) => {
              if (!(error instanceof HttpErrorResponse && isGatewayFailure(error)))
                return throwError(() => error);

              failures.retrying(request.url, error);

              return timer(retryMs);
            },
          }),
        )
      : next(request);

  return sent.pipe(
    tap({
      error: (error) => {
        if (error instanceof HttpErrorResponse && isGatewayFailure(error))
          failures.gaveUp(request.url, error);
      },
    }),
  );
};

export const apiErrorInterceptor: HttpInterceptorFn = (request, next) =>
  next(request).pipe(
    catchError((error) =>
      throwError(() =>
        error instanceof HttpErrorResponse
          ? new Error(
              error.status > 0
                ? `${request.url} answered ${error.status}`
                : `${request.url} didn't answer`,
            )
          : error,
      ),
    ),
  );
