import { Effect, HashMap, Option, Ref, Scope } from "effect";

export interface SummaryRewriter {
  readonly rewrite: (recordingId: string) => Effect.Effect<void>;
}

type Running = HashMap.HashMap<string, boolean>;

const make = Effect.fnUntraced(function* (
  rewriteOnce: (recordingId: string) => Effect.Effect<void>,
): Effect.fn.Return<SummaryRewriter, never, Scope.Scope> {
  const scope = yield* Scope.Scope;
  const running = yield* Ref.make<Running>(HashMap.empty());

  const askedAgain = (id: string) =>
    Ref.modify(running, (all): readonly [boolean, Running] =>
      Option.getOrElse(HashMap.get(all, id), () => false)
        ? [true, HashMap.set(all, id, false)]
        : [false, HashMap.remove(all, id)],
    );

  const rewriteWhileAsked = Effect.fn("Recorder.rewriteWhileAsked")(function* (id: string) {
    do {
      yield* rewriteOnce(id);
    } while (yield* askedAgain(id));
  });

  const rewrite = (id: string) =>
    Ref.modify(running, (all): readonly [boolean, Running] => [
      !HashMap.has(all, id),
      HashMap.set(all, id, HashMap.has(all, id)),
    ]).pipe(
      Effect.flatMap((fresh) =>
        fresh ? rewriteWhileAsked(id).pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void,
      ),
    );

  return { rewrite };
});

export const SummaryRewriter = { make };
