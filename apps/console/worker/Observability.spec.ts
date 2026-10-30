import * as Sentry from "@sentry/cloudflare";
import { afterAll, assert, beforeEach, describe, it } from "vite-plus/test";

import { Array, Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from "effect/http-api";

import {
  ObservabilityLayer,
  RouteSpanNames,
  type SentryEnv,
  sentryOptions,
  telemetryFrom,
} from "./Observability.ts";

class OfficeGroup extends HttpApiGroup.make("office")
  .add(
    HttpApiEndpoint.post("burn", "/burn", { payload: Schema.Struct({ secret: Schema.String }) }),
    HttpApiEndpoint.get("busy", "/busy", { error: HttpApiError.ServiceUnavailable }),
  )
  .prefix("/api") {}

class OfficeApi extends HttpApi.make("office").add(OfficeGroup) {}

const OfficeHandlers = HttpApiBuilder.group(OfficeApi, "office", (handlers) =>
  handlers
    .handle("burn", () => Effect.die(new Error("The office caught fire")))
    .handle("busy", () =>
      Effect.logWarning("Couldn't reach the office").pipe(
        Effect.annotateLogs({ who: "Ada" }),
        Effect.andThen(Effect.fail(HttpApiError.ServiceUnavailable.make({}))),
      ),
    ),
);

const app = HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpApiBuilder.layer(OfficeApi).pipe(Layer.provide(OfficeHandlers)),
    HttpRouter.add("POST", "/api/sentry", HttpServerResponse.empty({ status: 200 })),
  ).pipe(
    Layer.provide([RouteSpanNames.layer, HttpServer.layerServices]),
    Layer.provideMerge(ObservabilityLayer),
  ),
  { disableLogger: true },
);

afterAll(() => app.dispose());

const DSN = "https://public@o1.ingest.sentry.io/42";

const env: SentryEnv = {
  SENTRY_DSN: DSN,
  SENTRY_ENVIRONMENT: "production",
  SENTRY_RELEASE: "abc123",
};

const errors: Array<Sentry.ErrorEvent> = [];

const envelopes: Array<string> = [];

type SentLog = Parameters<NonNullable<Sentry.CloudflareOptions["beforeSendLog"]>>[0];

const logs: Array<SentLog> = [];

const requests: Array<string> = [];

beforeEach(() => {
  errors.length = 0;
  envelopes.length = 0;
  logs.length = 0;
  requests.length = 0;
});

interface Invocation {
  readonly waitUntil: (promise: Promise<void>) => void;
  readonly passThroughOnException: () => void;
  readonly props: object;
}

const worker = Sentry.withSentry(
  (env: SentryEnv) => ({
    ...sentryOptions(env),
    transport: (options) =>
      Sentry.createTransport(options, ({ body }) => {
        envelopes.push(Predicate.isString(body) ? body : new TextDecoder().decode(body));

        return Promise.resolve({});
      }),
    beforeSend: (event) => {
      errors.push(event);

      return event;
    },
    beforeSendLog: (log) => {
      logs.push(log);

      return log;
    },
    beforeSendSpan: (span) => {
      if (span.is_segment) requests.push(span.name);

      return span;
    },
  }),
  {
    fetch: (request: Request, _env: SentryEnv, _invocation: Invocation) => app.handler(request),
  },
);

const invocation: Invocation = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

const send = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      worker.fetch(new Request(`http://console.test${path}`, init), env, invocation),
    );

    yield* Effect.promise(() => Sentry.flush(2000));

    return response;
  });

describe("the Worker's telemetry", () => {
  it("reports a defect as an error, without the request's body or headers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* send("/api/burn", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer s3cr3t" },
          body: '{"secret":"s3cr3t"}',
        });

        assert.strictEqual(response.status, 500);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0]?.exception?.values?.[0]?.value, "The office caught fire");
        assert.strictEqual(errors[0]?.level, "error");
        assert.strictEqual(errors[0]?.environment, "production");
        assert.strictEqual(errors[0]?.release, "abc123");
        assert.strictEqual(errors[0]?.request?.url, "http://console.test/api/burn");
        assert.isUndefined(errors[0]?.request?.headers);
        assert.isUndefined(errors[0]?.request?.data);
        assert.notInclude(errors[0]?.sdk?.integrations ?? [], "Console");
        assert.isNotEmpty(envelopes);
        assert.notInclude(Array.join(envelopes, "\n"), "s3cr3t");
      }),
    ));

  it("reports a 5xx failure and logs its warning without the annotations", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* send("/api/busy");

        assert.strictEqual(response.status, 503);
        assert.deepStrictEqual(
          Array.map(errors, ({ level, exception }) => ({
            level,
            type: exception?.values?.[0]?.type,
          })),
          [{ level: "error", type: "effect/HttpApiError/ServiceUnavailable" }],
        );
        assert.deepStrictEqual(
          Array.map(logs, ({ level, message, attributes }) => ({
            level,
            message,
            who: attributes?.["who"],
          })),
          [{ level: "warn", message: "Couldn't reach the office", who: undefined }],
        );
      }),
    ));

  it("traces each request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* send("/api/busy");

        assert.deepStrictEqual(requests, ["GET /api/busy"]);
      }),
    ));

  it("doesn't trace the page's telemetry passing through", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* send("/api/sentry", { method: "POST", body: "{}" });

        assert.deepStrictEqual(requests, []);
      }),
    ));
});

describe("the Worker's Sentry settings", () => {
  it("are off without a DSN, even an empty one", () => {
    assert.deepStrictEqual(sentryOptions({}), { dsn: "" });
    assert.deepStrictEqual(sentryOptions({ SENTRY_DSN: "" }), { dsn: "" });
    assert.isTrue(Option.isNone(telemetryFrom({ SENTRY_DSN: "" })));
  });

  it("tag everything as development unless told otherwise", () => {
    assert.deepStrictEqual(
      telemetryFrom({ SENTRY_DSN: DSN, SENTRY_RELEASE: "" }),
      Option.some({ dsn: DSN, environment: "development", release: null }),
    );
  });
});
