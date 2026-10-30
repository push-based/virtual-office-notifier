import { Array, Effect, Layer, Option, Predicate } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { assert, describe, it } from "vite-plus/test";

import type { Telemetry } from "./Observability.ts";
import { TelemetryRoutes } from "./Telemetry.ts";

const DSN = "https://public@o1.ingest.us.sentry.io/42";

const telemetry: Telemetry = { dsn: DSN, environment: "production", release: "abc123" };

const envelopeFor = (dsn: string) =>
  Array.join(
    [`{"dsn":"${dsn}","sent_at":"2026-10-30T12:00:00.000Z"}`, '{"type":"event"}', "{}"],
    "\n",
  );

interface Forwarded {
  readonly url: string;
  readonly contentType: string | undefined;
  readonly body: string;
}

const forwardedOf = ({ url, body }: HttpClientRequest.HttpClientRequest): Forwarded =>
  Predicate.isTagged(body, "Uint8Array")
    ? { url, contentType: body.contentType, body: new TextDecoder().decode(body.body) }
    : { url, contentType: undefined, body: "" };

const consoleWith = (
  settings: Option.Option<Telemetry>,
  sentry: Option.Option<Response>,
  forwarded: Array<Forwarded> = [],
) =>
  HttpRouter.toWebHandler(
    TelemetryRoutes(settings).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            forwarded.push(forwardedOf(request));

            return Option.match(sentry, {
              onNone: () =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request }),
                  }),
                ),
              onSome: (response) => Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            });
          }),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

const send = (app: ReturnType<typeof consoleWith>, path: string, init?: RequestInit) =>
  Effect.acquireUseRelease(
    Effect.succeed(app),
    ({ handler }) => Effect.promise(() => handler(new Request(`http://console.test${path}`, init))),
    ({ dispose }) => Effect.promise(dispose),
  );

const tunnel = (app: ReturnType<typeof consoleWith>, envelope: string) =>
  send(app, "/api/sentry", { method: "POST", body: envelope });

const accepted = () => Option.some(new Response('{"id":"1"}', { status: 200 }));

describe("the telemetry routes", () => {
  it("tell the page where to send its telemetry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* send(
          consoleWith(Option.some(telemetry), accepted()),
          "/api/telemetry",
        );

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), telemetry);
      }),
    ));

  it("tell the page there's nowhere to send it without a DSN", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* send(consoleWith(Option.none(), accepted()), "/api/telemetry");

        assert.strictEqual(response.status, 200);
        assert.isNull(yield* Effect.promise(() => response.json()));
      }),
    ));
});

describe("the Sentry tunnel", () => {
  it("forwards an envelope for the Console's DSN to its project", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forwarded: Array<Forwarded> = [];
        const envelope = envelopeFor(DSN);

        const response = yield* tunnel(
          consoleWith(Option.some(telemetry), accepted(), forwarded),
          envelope,
        );

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(forwarded, [
          {
            url: "https://o1.ingest.us.sentry.io/api/42/envelope/",
            contentType: "application/x-sentry-envelope",
            body: envelope,
          },
        ]);
      }),
    ));

  it("passes Sentry's rate limits back to the page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const limited = new Response(null, {
          status: 429,
          headers: { "retry-after": "60", "x-sentry-rate-limits": "60:error:organization" },
        });

        const response = yield* tunnel(
          consoleWith(Option.some(telemetry), Option.some(limited)),
          envelopeFor(DSN),
        );

        assert.strictEqual(response.status, 429);
        assert.strictEqual(response.headers.get("retry-after"), "60");
        assert.strictEqual(response.headers.get("x-sentry-rate-limits"), "60:error:organization");
      }),
    ));

  it("refuses envelopes for any other DSN", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forwarded: Array<Forwarded> = [];

        const response = yield* tunnel(
          consoleWith(Option.some(telemetry), accepted(), forwarded),
          envelopeFor("https://public@o2.ingest.sentry.io/7"),
        );

        assert.strictEqual(response.status, 403);
        assert.deepStrictEqual(forwarded, []);
      }),
    ));

  it("refuses something that isn't an envelope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forwarded: Array<Forwarded> = [];

        const response = yield* tunnel(
          consoleWith(Option.some(telemetry), accepted(), forwarded),
          "hello",
        );

        assert.strictEqual(response.status, 403);
        assert.deepStrictEqual(forwarded, []);
      }),
    ));

  it("answers 502 when Sentry can't be reached", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* tunnel(
          consoleWith(Option.some(telemetry), Option.none()),
          envelopeFor(DSN),
        );

        assert.strictEqual(response.status, 502);
      }),
    ));

  it("isn't there without a DSN", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forwarded: Array<Forwarded> = [];

        const response = yield* tunnel(
          consoleWith(Option.none(), accepted(), forwarded),
          envelopeFor(DSN),
        );

        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(forwarded, []);
      }),
    ));
});
