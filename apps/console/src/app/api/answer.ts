import { Duration, Effect, Option } from "effect";

import { ANSWER_WINDOW_MS } from "../wire.ts";

export interface AnswerTiming {
  readonly every: Duration.Duration;
  readonly attempts: number;
}

const REQUEST_POLL = Duration.seconds(1);

export const REQUEST_ANSWER: AnswerTiming = {
  every: REQUEST_POLL,
  attempts: Math.ceil(ANSWER_WINDOW_MS / Duration.toMillis(REQUEST_POLL)),
};

export const awaitAnswer = <A, Answered extends A, E, R>(
  check: Effect.Effect<A, E, R>,
  isAnswered: (found: A) => found is Answered,
  timing: AnswerTiming,
): Effect.Effect<Option.Option<Answered>, E, R> => {
  const attempt = (left: number): Effect.Effect<Option.Option<Answered>, E, R> =>
    left === 0
      ? Effect.succeed(Option.none())
      : Effect.sleep(timing.every).pipe(
          Effect.andThen(check),
          Effect.flatMap((found) =>
            isAnswered(found) ? Effect.succeed(Option.some(found)) : attempt(left - 1),
          ),
        );

  return attempt(timing.attempts);
};
