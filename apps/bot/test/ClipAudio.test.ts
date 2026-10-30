import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { ClipAudio } from "../src/ClipAudio.ts";

const bytes = (fill: number) => new Uint8Array([fill, fill, fill]);

describe("ClipAudio", () => {
  it.effect("holds a clip's audio until it's removed", () =>
    Effect.gen(function* () {
      const audio = yield* ClipAudio.make;

      yield* audio.put(1, bytes(1));

      assert.deepStrictEqual(yield* audio.get(1), Option.some(bytes(1)));

      yield* audio.remove(1);

      assert.deepStrictEqual(yield* audio.get(1), Option.none());
    }),
  );

  it.effect("has nothing for a clip it was never given", () =>
    Effect.gen(function* () {
      const audio = yield* ClipAudio.make;

      assert.deepStrictEqual(yield* audio.get(7), Option.none());
    }),
  );

  it.effect("keeps each clip's audio apart, and removing one leaves the others", () =>
    Effect.gen(function* () {
      const audio = yield* ClipAudio.make;

      yield* audio.put(1, bytes(1));
      yield* audio.put(2, bytes(2));
      yield* audio.remove(1);
      yield* audio.remove(3);

      assert.deepStrictEqual(yield* audio.get(1), Option.none());
      assert.deepStrictEqual(yield* audio.get(2), Option.some(bytes(2)));
    }),
  );

  it.effect("replaces a clip's audio when it's put again", () =>
    Effect.gen(function* () {
      const audio = yield* ClipAudio.make;

      yield* audio.put(1, bytes(1));
      yield* audio.put(1, bytes(9));

      assert.deepStrictEqual(yield* audio.get(1), Option.some(bytes(9)));
    }),
  );

  it.effect("gives every buffer its own audio", () =>
    Effect.gen(function* () {
      const first = yield* ClipAudio.make;
      const second = yield* ClipAudio.make;

      yield* first.put(1, bytes(1));

      assert.deepStrictEqual(yield* second.get(1), Option.none());
    }),
  );
});
