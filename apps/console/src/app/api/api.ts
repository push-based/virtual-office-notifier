import { Context, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { describeGatewayFailure, GatewayFailures } from "../telemetry/gateway-failures.ts";

export class ApiFailure extends Schema.TaggedError<ApiFailure, { readonly brand: unique symbol }>()(
  "ApiFailure",
  {
    path: Schema.String,
    status: Schema.Number,
    reason: Schema.String,
    details: Schema.Record(Schema.String, Schema.String),
  },
) {}

export class SessionToken extends Context.Service<SessionToken, Ref.Ref<Option.Option<string>>>()(
  "console/api/SessionToken",
) {
  static readonly layer = Layer.effect(SessionToken, Ref.make(Option.none<string>()));
}

export interface RetryTimingService {
  readonly retries: number;
  readonly delay: Duration.Duration;
}

export const RetryTiming = Context.Reference<RetryTimingService>("console/api/RetryTiming", {
  defaultValue: () => ({ retries: 3, delay: Duration.seconds(2) }),
});

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([0, 502, 503, 504]);

export const isGatewayFailure = (failure: ApiFailure): boolean =>
  GATEWAY_STATUSES.has(failure.status);

const unanswered = (path: string): ApiFailure =>
  new ApiFailure({ path, status: 0, reason: `${path} didn't answer`, details: { status: "0" } });

const refused = (path: string, response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((body) =>
      Effect.fail(
        new ApiFailure({
          path,
          status: response.status,
          reason: `${path} answered ${response.status}`,
          details: describeGatewayFailure({
            status: response.status,
            headers: response.headers,
            body,
          }),
        }),
      ),
    ),
  );

const send = Effect.fnUntraced(function* (
  path: string,
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  const token = yield* Ref.get(yield* SessionToken);

  const authorized = Option.match(token, {
    onNone: () => request,
    onSome: (session) => HttpClientRequest.bearerToken(request, session),
  });

  const response = yield* client
    .execute(authorized)
    .pipe(Effect.catchTag("HttpClientError", () => Effect.fail(unanswered(path))));

  if (response.status < 200 || response.status >= 300) return yield* refused(path, response);

  return response;
});

const withRetries = <A, R>(
  path: string,
  attempt: Effect.Effect<A, ApiFailure, R>,
  retries: number,
): Effect.Effect<A, ApiFailure, R> =>
  Effect.gen(function* () {
    const timing = yield* RetryTiming;
    const failures = yield* GatewayFailures;

    const retry = (left: number): Effect.Effect<A, ApiFailure, R> =>
      attempt.pipe(
        Effect.catchIf(
          (failure) => left > 0 && isGatewayFailure(failure),
          (failure) =>
            failures
              .retrying({ path, status: failure.status, details: failure.details })
              .pipe(Effect.andThen(Effect.sleep(timing.delay)), Effect.andThen(retry(left - 1))),
        ),
      );

    return yield* retry(retries).pipe(
      Effect.tapError((failure) =>
        isGatewayFailure(failure)
          ? failures.gaveUp({ path, status: failure.status, details: failure.details })
          : Effect.void,
      ),
    );
  });

const decoded = <S extends Schema.Constraint>(path: string, schema: S) =>
  Effect.flatMap((response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
      Effect.mapError(
        () =>
          new ApiFailure({
            path,
            status: response.status,
            reason: `${path} answered with something unexpected`,
            details: { status: String(response.status) },
          }),
      ),
    ),
  );

export const get = <S extends Schema.Constraint>(
  path: string,
  schema: S,
  query: Readonly<Record<string, string>> = {},
): Effect.Effect<
  S["Type"],
  ApiFailure,
  HttpClient.HttpClient | SessionToken | S["DecodingServices"]
> =>
  Effect.gen(function* () {
    const timing = yield* RetryTiming;
    const request = HttpClientRequest.get(path).pipe(HttpClientRequest.setUrlParams(query));

    return yield* withRetries(path, send(path, request), timing.retries);
  }).pipe(decoded(path, schema));

export const post = <S extends Schema.Constraint>(
  path: string,
  schema: S,
  body?: Schema.Json,
): Effect.Effect<
  S["Type"],
  ApiFailure,
  HttpClient.HttpClient | SessionToken | S["DecodingServices"]
> => {
  const request = HttpClientRequest.post(path).pipe(
    body === undefined ? (empty) => empty : HttpClientRequest.bodyJsonUnsafe(body),
  );

  return withRetries(path, send(path, request), 0).pipe(decoded(path, schema));
};
