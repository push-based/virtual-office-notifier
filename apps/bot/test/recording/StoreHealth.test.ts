import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Layer, Logger, Predicate, References } from "effect";

import { StoreUnavailable } from "../../src/recording/RecordingStore.ts";
import { StoreHealth } from "../../src/recording/StoreHealth.ts";
import { captureReports } from "../fakes.ts";

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

const capture = () => {
  const logs = captureLogs();
  const reports = captureReports();

  return {
    logs: logs.entries,
    reports: reports.reports,
    layer: Layer.mergeAll(logs.layer, reports.layer),
  };
};

const down = (reason: string) => StoreUnavailable.make({ reason });

const unreadable = (reason: string) => StoreUnavailable.make({ reason, unreadable: true });

const REQUESTS = "Couldn't handle recording requests";

const CLIPS = "Couldn't read the clips to transcribe";

describe("StoreHealth", () => {
  it.effect("warns and reports the first time the database isn't available", () => {
    const captured = capture();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.issue(REQUESTS)(down("connection refused"));

      assert.deepStrictEqual(captured.logs, [
        {
          level: "Warn",
          message: "Couldn't handle recording requests, the database isn't available",
          reason: "connection refused",
        },
      ]);
      assert.deepStrictEqual(captured.reports, [
        { name: "StoreUnavailable", message: "connection refused", severity: "Warn" },
      ]);
    }).pipe(Effect.provide(captured.layer));
  });

  it.effect("stays quiet while the same work still fails, but not about other work", () => {
    const captured = capture();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.issue(REQUESTS)(down("connection refused"));
      yield* health.ok(CLIPS);
      yield* health.issue(CLIPS)(down("timeout"));
      yield* health.issue(REQUESTS)(down("connection refused"));

      assert.deepStrictEqual(
        Array.map(captured.logs, ({ message }) => message),
        [
          "Couldn't handle recording requests, the database isn't available",
          "Couldn't read the clips to transcribe, the database isn't available",
        ],
      );
      assert.strictEqual(captured.reports.length, 2);
    }).pipe(Effect.provide(captured.layer));
  });

  it.effect("warns again once the same work recovered and failed again", () => {
    const captured = capture();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.issue(REQUESTS)(down("connection refused"));
      yield* health.ok(REQUESTS);
      yield* health.ok(REQUESTS);
      yield* health.issue(REQUESTS)(down("timeout"));

      assert.deepStrictEqual(
        Array.map(captured.logs, ({ reason }) => reason),
        ["connection refused", "timeout"],
      );
    }).pipe(Effect.provide(captured.layer));
  });

  it.effect("says nothing when the database comes back", () => {
    const captured = capture();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.ok(REQUESTS);
      yield* health.issue(REQUESTS)(down("connection refused"));
      yield* health.ok(REQUESTS);

      assert.strictEqual(captured.logs.length, 1);
    }).pipe(Effect.provide(captured.layer));
  });

  it.effect("reports a row it can't read as an error, since that's a bug", () => {
    const captured = capture();

    return Effect.gen(function* () {
      const health = yield* StoreHealth.make;

      yield* health.issue(REQUESTS)(unreadable("Expected number, got 1n"));

      assert.deepStrictEqual(captured.logs, [
        {
          level: "Error",
          message: "Couldn't handle recording requests, a row couldn't be read",
          reason: "Expected number, got 1n",
        },
      ]);
      assert.deepStrictEqual(
        Array.map(captured.reports, ({ severity }) => severity),
        ["Error"],
      );
    }).pipe(Effect.provide(captured.layer));
  });

  it.effect("reports a one-off failure every time", () => {
    const captured = capture();

    return Effect.gen(function* () {
      const record = StoreHealth.report("Couldn't record the end of the recording");

      yield* record(down("connection refused"));
      yield* record(down("connection refused"));

      assert.strictEqual(captured.logs.length, 2);
      assert.strictEqual(captured.reports.length, 2);
    }).pipe(Effect.provide(captured.layer));
  });
});
