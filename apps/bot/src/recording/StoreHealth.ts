import { Cause, Effect, ErrorReporter, HashSet, Ref } from "effect";

export interface StoreFailure extends Error {
  readonly reason: string;
  readonly unreadable: boolean;
}

export interface StoreHealth {
  readonly issue: (what: string) => (error: StoreFailure) => Effect.Effect<void>;
  readonly ok: (what: string) => Effect.Effect<void>;
}

const report =
  (what: string) =>
  (error: StoreFailure): Effect.Effect<void> =>
    (error.unreadable
      ? Effect.logError(`${what}, a row couldn't be read`)
      : Effect.logWarning(`${what}, the database isn't available`)
    ).pipe(
      Effect.annotateLogs({ reason: error.reason }),
      Effect.andThen(ErrorReporter.report(Cause.fail(error))),
    );

const make: Effect.Effect<StoreHealth> = Effect.map(
  Ref.make(HashSet.empty<string>()),
  (failing) => ({
    issue: (what) => (error) =>
      Ref.modify(failing, (current) => [
        !HashSet.has(current, what),
        HashSet.add(current, what),
      ]).pipe(Effect.flatMap((wasOk) => (wasOk ? report(what)(error) : Effect.void))),
    ok: (what) => Ref.update(failing, HashSet.remove(what)),
  }),
);

export const StoreHealth = { make, report };
