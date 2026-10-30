import { Effect, MutableHashMap, type Option } from "effect";

export interface ClipAudio {
  readonly put: (clipId: number, bytes: Uint8Array) => Effect.Effect<void>;
  readonly get: (clipId: number) => Effect.Effect<Option.Option<Uint8Array>>;
  readonly remove: (clipId: number) => Effect.Effect<void>;
}

const make: Effect.Effect<ClipAudio> = Effect.sync(() => {
  const held = MutableHashMap.empty<number, Uint8Array>();

  return {
    put: (clipId, bytes) =>
      Effect.sync(() => {
        MutableHashMap.set(held, clipId, bytes);
      }),
    get: (clipId) => Effect.sync(() => MutableHashMap.get(held, clipId)),
    remove: (clipId) =>
      Effect.sync(() => {
        MutableHashMap.remove(held, clipId);
      }),
  };
});

export const ClipAudio = { make };
