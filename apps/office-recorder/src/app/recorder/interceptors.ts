import { HttpErrorResponse, type HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { catchError, throwError } from "rxjs";

import { RecorderSession } from "./session";

export const sessionInterceptor: HttpInterceptorFn = (request, next) => {
  const token = inject(RecorderSession).token();

  return next(
    token === null ? request : request.clone({ setHeaders: { authorization: `Bearer ${token}` } }),
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
