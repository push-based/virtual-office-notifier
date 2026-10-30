import { Array, Effect, Option, Record, Schema, String } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { type Telemetry, TUNNEL_PATH } from "./Observability.ts";

const RATE_LIMIT_HEADERS = ["retry-after", "x-sentry-rate-limits"];

const decodeEnvelopeHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ dsn: Schema.String })),
);

const ingestUrl = (dsn: string) => {
  const { protocol, host, pathname } = new URL(dsn);

  return `${protocol}//${host}/api${pathname}/envelope/`;
};

const rateLimitsOf = (headers: Headers.Headers) =>
  Record.getSomes(
    Record.fromIterableWith(RATE_LIMIT_HEADERS, (name) => [name, Headers.get(headers, name)]),
  );

const isFor = (telemetry: Telemetry, envelope: string) =>
  Option.exists(
    decodeEnvelopeHeader(Array.headNonEmpty(String.split(envelope, "\n"))),
    ({ dsn }) => dsn === telemetry.dsn,
  );

const forwardEnvelope = Effect.fn("forwardEnvelope")(
  function* (
    client: HttpClient.HttpClient,
    telemetry: Telemetry,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const envelope = yield* request.text;

    if (!isFor(telemetry, envelope)) return HttpServerResponse.empty({ status: 403 });

    const response = yield* client.execute(
      HttpClientRequest.post(ingestUrl(telemetry.dsn)).pipe(
        HttpClientRequest.bodyText(envelope, "application/x-sentry-envelope"),
      ),
    );

    return HttpServerResponse.empty({
      status: response.status,
      headers: rateLimitsOf(response.headers),
    });
  },
  Effect.catchTags({
    HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    HttpClientError: () => Effect.succeed(HttpServerResponse.empty({ status: 502 })),
  }),
);

export const TelemetryRoutes = (telemetry: Option.Option<Telemetry>) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const client = yield* HttpClient.HttpClient;

      yield* router.add(
        "GET",
        "/api/telemetry",
        HttpServerResponse.jsonUnsafe(Option.getOrNull(telemetry)),
      );
      yield* router.add("POST", TUNNEL_PATH, (request) =>
        Option.match(telemetry, {
          onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          onSome: (telemetry) => forwardEnvelope(client, telemetry, request),
        }),
      );
    }),
  );
