import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Logger, Predicate, References } from "effect";

import { StoreHealth } from "../src/StoreHealth.ts";

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly reason: string;
}

const captureLogs = () => {
  const entries: Array<LogEntry> = [];

  const logger = Logger.make<unknown, void>((options) => {
    const { reason } = options.fiber.getRef(References.CurrentLogAnnotations);

    entries.push({
      level: options.logLevel,
      message: globalThis.String(
        Array.isArray(options.message) ? options.message[0] : options.message,
      ),
      reason: Predicate.isString(reason) ? reason : "",
    });
  });

  return { entries, layer: Logger.layer([logger]) };
};

const down = (reason: string) => ({ reason });

describe("StoreHealth", () => {
  it.effect("warns the first time the database isn't available", () => {
    const logs = captureLogs();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.issue("Couldn't handle recording requests")(down("connection refused"));

      assert.deepStrictEqual(logs.entries, [
        {
          level: "Warn",
          message: "Couldn't handle recording requests, the database isn't available",
          reason: "connection refused",
        },
      ]);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("stays quiet while the database is still down", () => {
    const logs = captureLogs();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.issue("Couldn't handle recording requests")(down("connection refused"));
      yield* health.issue("Couldn't read the clips to transcribe")(down("timeout"));
      yield* health.issue("Couldn't handle recording requests")(down("connection refused"));

      assert.deepStrictEqual(
        Array.map(logs.entries, ({ message }) => message),
        ["Couldn't handle recording requests, the database isn't available"],
      );
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("warns again once the database came back and went down again", () => {
    const logs = captureLogs();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.issue("Couldn't handle recording requests")(down("connection refused"));
      yield* health.ok;
      yield* health.ok;
      yield* health.issue("Couldn't apply recording edits")(down("timeout"));

      assert.deepStrictEqual(
        Array.map(logs.entries, ({ message, reason }) => [message, reason]),
        [
          [
            "Couldn't handle recording requests, the database isn't available",
            "connection refused",
          ],
          ["Couldn't apply recording edits, the database isn't available", "timeout"],
        ],
      );
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("says nothing when the database comes back", () => {
    const logs = captureLogs();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.ok;
      yield* health.issue("Couldn't handle recording requests")(down("connection refused"));
      yield* health.ok;

      assert.strictEqual(logs.entries.length, 1);
    }).pipe(Effect.provide(logs.layer));
  });
});
