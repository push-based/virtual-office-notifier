import {
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Ref,
  type Schema,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientRequest as Request,
  type HttpClientResponse,
} from "effect/http";
import { HttpApiClient, type HttpApiError, HttpApiMiddleware } from "effect/http-api";
import {
  type EditNotFound,
  type ErasureNotFound,
  type NotAnAdmin,
  type RecordingNotFound,
  RecordingApi,
  type RequestNotFound,
  SignedIn,
  type Unauthorized,
  type WithdrawalNotFound,
} from "office-domain/RecordingApi";
import type { DiscordRefused } from "office-domain/SignInApi";

import {
  describeGatewayFailure,
  type GatewayFailure,
  GatewayFailures,
} from "../telemetry/gateway-failures.ts";

export class SessionToken extends Context.Service<SessionToken, Ref.Ref<Option.Option<string>>>()(
  "console/api/SessionToken",
) {
  static readonly layer = Layer.effect(SessionToken, Ref.make(Option.none<string>()));
}

export interface RetryTimingService {
  readonly retries: number;
  readonly delay: Duration.Duration;
  readonly timeout: Duration.Duration;
}

export const RetryTiming = Context.Reference<RetryTimingService>("console/api/RetryTiming", {
  defaultValue: () => ({
    retries: 3,
    delay: Duration.seconds(2),
    timeout: Duration.seconds(15),
  }),
});

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const unanswered = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });

const gatewayFailureOf = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<GatewayFailure> =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((body) => ({
      path: request.url,
      status: response.status,
      details: describeGatewayFailure({ status: response.status, headers: response.headers, body }),
    })),
  );

const withGatewayRetries = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transform(client, (sent, request) =>
    Effect.gen(function* () {
      const timing = yield* RetryTiming;
      const failures = yield* GatewayFailures;

      const settle = <A>(
        left: number,
        failure: GatewayFailure,
        gaveUp: Effect.Effect<A, HttpClientError.HttpClientError>,
      ): Effect.Effect<
        A | HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError
      > =>
        left > 0
          ? failures
              .retrying(failure)
              .pipe(Effect.andThen(Effect.sleep(timing.delay)), Effect.andThen(attempt(left - 1)))
          : failures.gaveUp(failure).pipe(Effect.andThen(gaveUp));

      const attempt = (
        left: number,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
        sent.pipe(
          Effect.timeoutOrElse({
            duration: timing.timeout,
            orElse: () => Effect.fail(unanswered(request, "timed out")),
          }),
          Effect.matchEffect({
            onFailure: (error) =>
              Predicate.isTagged(error.reason, "TransportError")
                ? settle(
                    left,
                    { path: request.url, status: 0, details: { status: "0" } },
                    Effect.fail(error),
                  )
                : Effect.fail(error),
            onSuccess: (response) =>
              GATEWAY_STATUSES.has(response.status)
                ? gatewayFailureOf(request, response).pipe(
                    Effect.flatMap((failure) => settle(left, failure, Effect.succeed(response))),
                  )
                : Effect.succeed(response),
          }),
        );

      return yield* attempt(request.method === "GET" ? timing.retries : 0);
    }),
  );

export class ConsoleApi extends Context.Service<
  ConsoleApi,
  HttpApiClient.ForApi<typeof RecordingApi>
>()("console/api/ConsoleApi") {
  static readonly layer = Layer.effect(
    ConsoleApi,
    HttpApiClient.make(RecordingApi, { transformClient: withGatewayRetries }),
  );
}

export const bearerSession = HttpApiMiddleware.layerClient(
  SignedIn,
  Effect.gen(function* () {
    const token = yield* SessionToken;

    return ({ next, request }) =>
      Ref.get(token).pipe(
        Effect.flatMap((session) =>
          next(
            Option.match(session, {
              onNone: () => request,
              onSome: (bearer) => Request.bearerToken(request, bearer),
            }),
          ),
        ),
      );
  }),
);

export type ApiFailure =
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | HttpApiError.BadRequest
  | HttpApiError.ServiceUnavailable
  | Unauthorized
  | DiscordRefused
  | RequestNotFound
  | RecordingNotFound
  | EditNotFound
  | WithdrawalNotFound
  | ErasureNotFound
  | NotAnAdmin;

const NOT_THERE = "it isn't there any more";

const clientReason = (error: HttpClientError.HttpClientError): string => {
  const path = error.request.url;

  if (Predicate.isTagged(error.reason, "TransportError")) return `${path} didn't answer`;

  return Option.match(Option.fromNullishOr(error.response), {
    onNone: () => `${path} couldn't be asked`,
    onSome: ({ status }) =>
      status >= 200 && status < 300
        ? `${path} answered with something unexpected`
        : `${path} answered ${status}`,
  });
};

export const reasonOf: (failure: ApiFailure) => string = Match.type<ApiFailure>().pipe(
  Match.tags({
    HttpClientError: clientReason,
    SchemaError: () => "the Worker answered with something unexpected",
    BadRequest: () => "the Worker turned the request down",
    ServiceUnavailable: () => "the bot's records are out of reach",
    Unauthorized: () => "the sign-in ran out, so reopen the Activity",
    DiscordRefused: () => "Discord turned the sign-in down",
    RequestNotFound: () => NOT_THERE,
    RecordingNotFound: () => NOT_THERE,
    EditNotFound: () => NOT_THERE,
    WithdrawalNotFound: () => NOT_THERE,
    ErasureNotFound: () => NOT_THERE,
    NotAnAdmin: () => "only the office admins can see this",
  }),
  Match.exhaustive,
);
