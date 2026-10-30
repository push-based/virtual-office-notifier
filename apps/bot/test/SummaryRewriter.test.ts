import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Ref } from "effect";
import { TestClock } from "effect/testing";

import { SummaryRewriter } from "../src/SummaryRewriter.ts";

const REWRITE_TAKES = Duration.minutes(1);

const setUp = Effect.gen(function* () {
  const started = yield* Ref.make<ReadonlyArray<string>>([]);
  const finished = yield* Ref.make<ReadonlyArray<string>>([]);

  const rewriteOnce = (id: string) =>
    Ref.update(started, (all) => [...all, id]).pipe(
      Effect.andThen(Effect.sleep(REWRITE_TAKES)),
      Effect.andThen(Ref.update(finished, (all) => [...all, id])),
    );

  const { rewrite } = yield* SummaryRewriter.make(rewriteOnce);

  return { rewrite, started: Ref.get(started), finished: Ref.get(finished) };
});

describe("SummaryRewriter", () => {
  it.effect("rewrites a recording's summary once when asked once", () =>
    Effect.gen(function* () {
      const { rewrite, started, finished } = yield* setUp;

      yield* rewrite("r1");
      yield* TestClock.adjust(REWRITE_TAKES);
      yield* TestClock.adjust(REWRITE_TAKES);

      assert.deepStrictEqual(yield* started, ["r1"]);
      assert.deepStrictEqual(yield* finished, ["r1"]);
    }),
  );

  it.effect("runs one more rewrite after the current one, however often it's asked meanwhile", () =>
    Effect.gen(function* () {
      const { rewrite, started, finished } = yield* setUp;

      yield* rewrite("r1");
      yield* TestClock.adjust(Duration.seconds(1));

      yield* rewrite("r1");
      yield* rewrite("r1");
      yield* rewrite("r1");

      assert.deepStrictEqual(yield* started, ["r1"]);

      yield* TestClock.adjust(REWRITE_TAKES);

      assert.deepStrictEqual(yield* started, ["r1", "r1"]);
      assert.deepStrictEqual(yield* finished, ["r1"]);

      yield* TestClock.adjust(REWRITE_TAKES);
      yield* TestClock.adjust(REWRITE_TAKES);

      assert.deepStrictEqual(yield* started, ["r1", "r1"]);
      assert.deepStrictEqual(yield* finished, ["r1", "r1"]);
    }),
  );

  it.effect("starts afresh when asked after the last rewrite finished", () =>
    Effect.gen(function* () {
      const { rewrite, started } = yield* setUp;

      yield* rewrite("r1");
      yield* TestClock.adjust(REWRITE_TAKES);
      yield* TestClock.adjust(REWRITE_TAKES);

      yield* rewrite("r1");
      yield* TestClock.adjust(REWRITE_TAKES);
      yield* TestClock.adjust(REWRITE_TAKES);

      assert.deepStrictEqual(yield* started, ["r1", "r1"]);
    }),
  );

  it.effect("rewrites different recordings side by side", () =>
    Effect.gen(function* () {
      const { rewrite, started, finished } = yield* setUp;

      yield* rewrite("r1");
      yield* rewrite("r2");
      yield* TestClock.adjust(Duration.seconds(1));

      assert.deepStrictEqual(yield* started, ["r1", "r2"]);
      assert.deepStrictEqual(yield* finished, []);

      yield* TestClock.adjust(REWRITE_TAKES);

      assert.deepStrictEqual(yield* finished, ["r1", "r2"]);
    }),
  );

  it.effect("stops rewriting when its scope closes", () =>
    Effect.gen(function* () {
      const finished = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rewrite } = yield* SummaryRewriter.make((id) =>
            Effect.sleep(REWRITE_TAKES).pipe(
              Effect.andThen(Ref.update(finished, (all) => [...all, id])),
            ),
          );

          yield* rewrite("r1");
          yield* TestClock.adjust(Duration.seconds(1));
        }),
      );

      yield* TestClock.adjust(REWRITE_TAKES);

      assert.deepStrictEqual(yield* Ref.get(finished), []);
    }),
  );
});
