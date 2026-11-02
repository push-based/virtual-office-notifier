import { Effect, Predicate, Schedule, Schema } from "effect";

export class NotPresentYet extends Schema.TaggedError<
  NotPresentYet,
  { readonly brand: unique symbol }
>()("NotPresentYet", {
  resource: Schema.String,
}) {}

export const untilPresent = <A, E, R>(
  name: string,
  find: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A, E | NotPresentYet, R> =>
  find.pipe(
    Effect.flatMap((found) =>
      found === undefined
        ? Effect.fail(new NotPresentYet({ resource: name }))
        : Effect.succeed(found),
    ),
    Effect.retry({
      while: Predicate.isTagged("NotPresentYet"),
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );
