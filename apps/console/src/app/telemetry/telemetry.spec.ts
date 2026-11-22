import * as Sentry from "@sentry/browser";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import type { Telemetry } from "office-domain/Telemetry";

import { RetryTiming } from "../api/api.ts";
import { type FakeAnswer, fakeApi, fakeServer } from "../fakes.ts";
import { reportCrash, sentryOptionsFor, startTelemetry } from "./telemetry.ts";

const telemetry: Telemetry = {
  dsn: "https://public@o1.ingest.sentry.io/42",
  environment: "production",
  release: "abc123",
};

const serving = (answer: FakeAnswer) =>
  Layer.mergeAll(
    fakeApi(fakeServer(() => answer).layer),
    Layer.succeed(RetryTiming, { retries: 0, delay: Duration.zero, timeout: Duration.seconds(1) }),
  );

afterEach(async () => {
  await Sentry.close();
});

describe("the telemetry", () => {
  it.effect("sends nothing when the Worker has no DSN", () =>
    Effect.gen(function* () {
      yield* startTelemetry;

      expect(Sentry.getClient()).toBeUndefined();
    }).pipe(Effect.provide(serving({ body: null }))),
  );

  it.effect("sends nothing when the Worker can't say where to", () =>
    Effect.gen(function* () {
      yield* startTelemetry;

      expect(Sentry.getClient()).toBeUndefined();
    }).pipe(Effect.provide(serving({ status: 503 }))),
  );

  it.effect("starts Sentry with what the Worker serves, without console breadcrumbs", () =>
    Effect.gen(function* () {
      yield* startTelemetry;

      expect(Sentry.getClient()?.getOptions()).toMatchObject({
        dsn: telemetry.dsn,
        environment: "production",
        release: "abc123",
        tunnel: "/api/sentry",
        dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [] },
      });
      expect(Sentry.getClient()?.getIntegrationByName("BrowserTracing")).toBeDefined();
      expect(Sentry.getClient()?.getIntegrationByName("Console")).toBeUndefined();
    }).pipe(Effect.provide(serving({ body: telemetry }))),
  );

  it("reports a crash through the Worker", async () => {
    const sentTo: Array<string> = [];
    const errors: Array<string | undefined> = [];

    Sentry.init({
      ...sentryOptionsFor(telemetry),
      transport: (options) =>
        Sentry.createTransport(options, () => {
          sentTo.push(options.url);

          return Promise.resolve({});
        }),
      beforeSend: (event) => {
        errors.push(event.exception?.values?.[0]?.value);

        return event;
      },
    });

    reportCrash(new Error("The page caught fire"));
    await Sentry.flush(2000);

    expect(errors).toEqual(["The page caught fire"]);
    expect(new Set(sentTo)).toEqual(new Set(["/api/sentry"]));
  });

  it("leaves the release out when the Worker has none", () => {
    expect(sentryOptionsFor({ ...telemetry, release: null }).release).toBeUndefined();
  });
});
