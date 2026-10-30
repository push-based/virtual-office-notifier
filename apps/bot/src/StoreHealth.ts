import { Effect, Ref } from "effect";

export interface StoreHealth {
  readonly issue: (what: string) => (error: { readonly reason: string }) => Effect.Effect<void>;
  readonly ok: Effect.Effect<void>;
}

const make: Effect.Effect<StoreHealth> = Effect.map(Ref.make(true), (healthy) => ({
  issue: (what) => (error) =>
    Ref.getAndSet(healthy, false).pipe(
      Effect.flatMap((wasHealthy) =>
        wasHealthy
          ? Effect.logWarning(`${what}, the database isn't available`).pipe(
              Effect.annotateLogs({ reason: error.reason }),
            )
          : Effect.void,
      ),
    ),
  ok: Ref.set(healthy, true),
}));

export const StoreHealth = { make };
