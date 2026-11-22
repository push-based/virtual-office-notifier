import { Context, Duration, Effect, Option } from "effect";
import { ANSWER_WINDOW_MS } from "office-domain/wire";

interface AnswerTiming {
  readonly every: Duration.Duration;
  readonly attempts: number;
}

const REQUEST_POLL = Duration.seconds(1);

export const REQUEST_ANSWER: AnswerTiming = {
  every: REQUEST_POLL,
  attempts: Math.ceil(ANSWER_WINDOW_MS / Duration.toMillis(REQUEST_POLL)),
};

export const RequestAnswer = Context.Reference<AnswerTiming>("console/api/RequestAnswer", {
  defaultValue: () => REQUEST_ANSWER,
});

const polled = <A, Answered extends A, E, R>(
  check: Effect.Effect<A, E, R>,
  isAnswered: (found: A) => found is Answered,
  timing: AnswerTiming,
): Effect.Effect<Option.Option<Answered>, E, R> =>
  Effect.sleep(timing.every).pipe(
    Effect.andThen(check),
    Effect.repeat({ until: isAnswered, times: timing.attempts - 1 }),
    Effect.map(Option.liftPredicate(isAnswered)),
  );

export const awaitAnswer = <A, Answered extends A, E, R>(
  check: Effect.Effect<A, E, R>,
  isAnswered: (found: A) => found is Answered,
  timing?: AnswerTiming,
): Effect.Effect<Option.Option<Answered>, E, R> =>
  Effect.gen(function* () {
    return yield* polled(check, isAnswered, timing ?? (yield* RequestAnswer));
  });
