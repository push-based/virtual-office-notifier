import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { HttpApiError } from "effect/http-api";
import { TestClock } from "effect/testing";
import { Unauthorized } from "office-domain/RecordingApi";

import { type FakeRoutes, fakeApi, fakeServer } from "../fakes.ts";
import { type GatewayFailure, GatewayFailures } from "../telemetry/gateway-failures.ts";
import { type ApiFailure, ConsoleApi, reasonOf, RetryTiming, SessionToken } from "./api.ts";

const STATUS = {
  botInOffice: true,
  occupants: [],
  recording: null,
  updatedAt: "2026-10-27T12:00:00.000Z",
};

const reported: Array<string> = [];

const gaveUpWith: Array<GatewayFailure> = [];

const answering = (...answers: ReadonlyArray<ReturnType<FakeRoutes>>) => {
  let next = 0;

  const server = fakeServer(() => {
    const answer = answers[Math.min(next, answers.length - 1)] ?? { status: 404 };

    next += 1;

    return answer;
  });

  const layer = Layer.mergeAll(
    fakeApi(server.layer),
    Layer.succeed(RetryTiming, {
      retries: 2,
      delay: Duration.seconds(1),
      timeout: Duration.seconds(10),
    }),
    Layer.succeed(GatewayFailures, {
      retrying: ({ path, status }) =>
        Effect.sync(() => reported.push(`retrying ${path} ${status}`)),
      gaveUp: (failure) =>
        Effect.sync(() => {
          reported.push(`gave up ${failure.path} ${failure.status}`);
          gaveUpWith.push(failure);
        }),
    }),
  );

  return { server, layer };
};

const status = ConsoleApi.use((api) => api.recording.status());

const stop = ConsoleApi.use((api) => api.recording.submit({ payload: { action: "stop" } }));

const reasonFor = <A, E extends ApiFailure, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.flip, Effect.map(reasonOf));

const encodeError = Schema.encodeSync(
  Schema.Union([HttpApiError.ServiceUnavailable, Unauthorized]),
);

const unavailable = { status: 503, headers: { "retry-after": "5" } };

describe("the API", () => {
  it.effect("sends no credentials before sign-in, and the session as a bearer token after", () => {
    const { server, layer } = answering({ body: STATUS });

    return Effect.gen(function* () {
      yield* status;
      yield* Ref.set(yield* SessionToken, Option.some("session-1"));
      yield* status;

      expect(server.sent.map(({ authorization }) => authorization)).toEqual([
        undefined,
        "Bearer session-1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "names the endpoint and the status when the Worker answers one it never declared",
    () => {
      const { layer } = answering({ status: 500 });

      return Effect.gen(function* () {
        expect(yield* reasonFor(status)).toBe("/api/status answered 500");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("says when the endpoint didn't answer at all, once the retries are used up", () => {
    const { server, layer } = answering("unanswered");

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(reasonFor(status));

      yield* TestClock.adjust(Duration.seconds(2));

      expect(yield* Fiber.join(fiber)).toBe("/api/status didn't answer");
      expect(server.sent).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives up on an attempt that hangs, and asks again", () => {
    reported.length = 0;
    const { server, layer } = answering("hangs", { body: STATUS });

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(status);

      yield* TestClock.adjust(Duration.seconds(10));
      expect(reported).toEqual(["retrying /api/status 0"]);
      yield* TestClock.adjust(Duration.seconds(1));

      expect((yield* Fiber.join(fiber)).botInOffice).toBe(true);
      expect(server.sent).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("says when the Worker answered with something the contract doesn't allow", () => {
    const { layer } = answering({ body: { ...STATUS, botInOffice: "yes" } });

    return Effect.gen(function* () {
      expect(yield* reasonFor(status)).toBe("the Worker answered with something unexpected");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "asks again when Discord's proxy briefly answers 503, and reports only the retry",
    () => {
      reported.length = 0;
      const { server, layer } = answering(unavailable, { body: STATUS });

      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(status);

        yield* TestClock.adjust(Duration.millis(999));
        expect(server.sent).toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));

        expect((yield* Fiber.join(fiber)).botInOffice).toBe(true);
        expect(reported).toEqual(["retrying /api/status 503"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("gives up with the last failure once the retries are used up, and reports it", () => {
    reported.length = 0;
    const { server, layer } = answering(unavailable);

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(reasonFor(status));

      yield* TestClock.adjust(Duration.seconds(2));

      expect(yield* Fiber.join(fiber)).toBe("/api/status answered 503");
      expect(server.sent).toHaveLength(3);
      expect(reported).toEqual([
        "retrying /api/status 503",
        "retrying /api/status 503",
        "gave up /api/status 503",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("says in words when the Worker itself says the bot's records are out of reach", () => {
    reported.length = 0;

    const { layer } = answering({
      status: 503,
      body: encodeError(HttpApiError.ServiceUnavailable.make({})),
    });

    return Effect.gen(function* () {
      expect(yield* reasonFor(stop)).toBe("the bot's records are out of reach");
      expect(reported).toEqual(["gave up /api/requests 503"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("doesn't ask again or report when the Worker itself refused", () => {
    reported.length = 0;
    const { server, layer } = answering({ status: 401, body: encodeError(Unauthorized.make()) });

    return Effect.gen(function* () {
      expect(yield* reasonFor(status)).toBe("the sign-in ran out, so reopen the Activity");
      expect(server.sent).toHaveLength(1);
      expect(reported).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "never sends a request that changes something twice, but reports the proxy's answer",
    () => {
      reported.length = 0;
      const { server, layer } = answering(unavailable);

      return Effect.gen(function* () {
        expect(yield* reasonFor(stop)).toBe("/api/requests answered 503");
        expect(server.sent).toHaveLength(1);
        expect(server.sent[0]?.body).toEqual({ action: "stop" });
        expect(reported).toEqual(["gave up /api/requests 503"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps what says who answered a gateway failure", () => {
    gaveUpWith.length = 0;
    const { layer } = answering({ ...unavailable, body: "upstream connect error" });

    return Effect.gen(function* () {
      yield* Effect.flip(stop);

      expect(gaveUpWith[0]?.details).toEqual({
        status: "503",
        "retry-after": "5",
        "content-type": "text/plain;charset=UTF-8",
        body: '"upstream connect error"',
      });
    }).pipe(Effect.provide(layer));
  });
});
