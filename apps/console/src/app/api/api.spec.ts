import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";

import { type FakeRoutes, fakeServer } from "../fakes.ts";
import { GatewayFailures } from "../telemetry/gateway-failures.ts";
import * as Api from "./api.ts";

const Status = Schema.Struct({ botInOffice: Schema.Boolean });

const noted: Array<string> = [];

const answering = (...answers: ReadonlyArray<ReturnType<FakeRoutes>>) => {
  let next = 0;

  const server = fakeServer(() => {
    const answer = answers[Math.min(next, answers.length - 1)] ?? { status: 404 };

    next += 1;

    return answer;
  });

  const layer = Layer.mergeAll(
    server.layer,
    Api.SessionToken.layer,
    Layer.succeed(Api.RetryTiming, { retries: 2, delay: Duration.seconds(1) }),
    Layer.succeed(GatewayFailures, {
      retrying: ({ path, status }) => Effect.sync(() => noted.push(`retrying ${path} ${status}`)),
      gaveUp: ({ path, status }) => Effect.sync(() => noted.push(`gave up ${path} ${status}`)),
    }),
  );

  return { server, layer };
};

const reasonOf = <A, R>(effect: Effect.Effect<A, Api.ApiFailure, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map(({ reason }) => reason),
  );

const unavailable = { status: 503, headers: { "retry-after": "5" } };

describe("the API", () => {
  it.effect("sends no credentials before sign-in, and the session as a bearer token after", () => {
    const { server, layer } = answering({ body: { botInOffice: true } });

    return Effect.gen(function* () {
      yield* Api.get("/api/status", Status);
      yield* Ref.set(yield* Api.SessionToken, Option.some("session-1"));
      yield* Api.get("/api/status", Status);

      expect(server.sent.map(({ authorization }) => authorization)).toEqual([
        undefined,
        "Bearer session-1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the endpoint and the status it answered with", () => {
    const { layer } = answering({ status: 500 });

    return Effect.gen(function* () {
      expect(yield* reasonOf(Api.get("/api/status", Status))).toBe("/api/status answered 500");
    }).pipe(Effect.provide(layer));
  });

  it.effect("says when the endpoint didn't answer at all, once the retries are used up", () => {
    const { server, layer } = answering("unanswered");

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(reasonOf(Api.get("/api/status", Status)));

      yield* TestClock.adjust(Duration.seconds(2));

      expect(yield* Fiber.join(fiber)).toBe("/api/status didn't answer");
      expect(server.sent).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("says when the endpoint answered with something unexpected", () => {
    const { layer } = answering({ body: { botInOffice: "yes" } });

    return Effect.gen(function* () {
      expect(yield* reasonOf(Api.get("/api/status", Status))).toBe(
        "/api/status answered with something unexpected",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "asks again when Discord's proxy briefly answers 503, and reports only the retry",
    () => {
      noted.length = 0;
      const { server, layer } = answering(unavailable, { body: { botInOffice: true } });

      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Api.get("/api/status", Status));

        yield* TestClock.adjust(Duration.millis(999));
        expect(server.sent).toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));

        expect(yield* Fiber.join(fiber)).toEqual({ botInOffice: true });
        expect(noted).toEqual(["retrying /api/status 503"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("gives up with the last failure once the retries are used up, and reports it", () => {
    noted.length = 0;
    const { server, layer } = answering(unavailable);

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(reasonOf(Api.get("/api/status", Status)));

      yield* TestClock.adjust(Duration.seconds(2));

      expect(yield* Fiber.join(fiber)).toBe("/api/status answered 503");
      expect(server.sent).toHaveLength(3);
      expect(noted).toEqual([
        "retrying /api/status 503",
        "retrying /api/status 503",
        "gave up /api/status 503",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("doesn't ask again or report when the Worker itself refused", () => {
    noted.length = 0;
    const { server, layer } = answering({ status: 401 });

    return Effect.gen(function* () {
      expect(yield* reasonOf(Api.get("/api/status", Status))).toBe("/api/status answered 401");
      expect(server.sent).toHaveLength(1);
      expect(noted).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "never sends a request that changes something twice, but reports the proxy's answer",
    () => {
      noted.length = 0;
      const { server, layer } = answering(unavailable);

      return Effect.gen(function* () {
        expect(yield* reasonOf(Api.post("/api/requests", Status, { action: "start" }))).toBe(
          "/api/requests answered 503",
        );
        expect(server.sent).toHaveLength(1);
        expect(server.sent[0]?.body).toEqual({ action: "start" });
        expect(noted).toEqual(["gave up /api/requests 503"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps what says who answered a gateway failure", () => {
    const { layer } = answering({ ...unavailable, body: "upstream connect error" });

    return Effect.gen(function* () {
      const failure = yield* Effect.flip(Api.post("/api/requests", Status));

      expect(failure.details).toEqual({
        status: "503",
        "retry-after": "5",
        "content-type": "text/plain;charset=UTF-8",
        body: '"upstream connect error"',
      });
    }).pipe(Effect.provide(layer));
  });
});
