import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiMiddleware, HttpApiTest } from "effect/http-api";
import { RecordingApi, SignedIn, Unauthorized } from "office-domain/RecordingApi";
import type { Telemetry } from "office-domain/Telemetry";

import { TelemetryHandlers } from "../src/TelemetryHandlers.ts";

const telemetry: Telemetry = {
  dsn: "https://public@o1.ingest.us.sentry.io/42",
  environment: "production",
  release: "abc123",
};

const nobodySignedIn = Layer.succeed(
  SignedIn,
  SignedIn.of({ session: () => Effect.fail(Unauthorized.make()) }),
);

const noSession = HttpApiMiddleware.layerClient(SignedIn, ({ next, request }) => next(request));

const configFrom = (settings: Option.Option<Telemetry>) =>
  HttpApiTest.groups(RecordingApi, ["telemetry"]).pipe(
    Effect.flatMap((client) => client.telemetry.config()),
    Effect.provide([
      TelemetryHandlers(settings),
      nobodySignedIn,
      noSession,
      HttpServer.layerServices,
    ]),
  );

describe("the telemetry handlers", () => {
  it.effect("tell the page where to send its telemetry, before it has signed in", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* configFrom(Option.some(telemetry)), telemetry);
    }),
  );

  it.effect("tell the page there's nowhere to send it when Sentry isn't set up", () =>
    Effect.gen(function* () {
      assert.isNull(yield* configFrom(Option.none()));
    }),
  );
});
