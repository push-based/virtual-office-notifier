import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  ErrorReporter,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
} from "effect";

import { type ActivityLogError, Outage } from "../activity/index.ts";
import { Database, reconnectSchedule } from "../database/index.ts";
import { type ConsentEvent, ConsentLog, type ConsentRecord, NEVER_ASKED } from "./ConsentLog.ts";

export const LOOKUP_WAIT = Duration.seconds(5);

export const FLUSH_TIMEOUT = Duration.seconds(10);

interface Noted {
  readonly forgotten: boolean;
  readonly agreed: Option.Option<boolean>;
  readonly asked: number;
}

const NOTHING_NOTED: Noted = { forgotten: false, agreed: Option.none(), asked: 0 };

const FORGOTTEN: Noted = { forgotten: true, agreed: Option.none(), asked: 0 };

export const recordAfter = (history: ConsentRecord, noted: Noted): ConsentRecord => {
  const base = noted.forgotten ? NEVER_ASKED : history;

  return {
    agreed: Option.getOrElse(noted.agreed, () => base.agreed),
    asked: base.asked + noted.asked,
  };
};

const noting = (noted: Noted, event: ConsentEvent): Noted => {
  switch (event.kind) {
    case "asked":
      return { ...noted, asked: noted.asked + 1 };
    case "agreed":
      return { ...noted, agreed: Option.some(true) };
    case "withdrawn":
      return { ...noted, agreed: Option.some(false) };
    default:
      return noted;
  }
};

const logUnwritten = (message: string, event: ConsentEvent) =>
  Effect.logError(message).pipe(Effect.annotateLogs({ entry: JSON.stringify(event) }));

const retryOutages = reconnectSchedule.pipe(
  Schedule.setInputType<ActivityLogError>(),
  Schedule.while(({ input }) => Schema.is(Outage)(input.reason)),
  Schedule.tap(({ input, attempt }) =>
    Effect.logWarning("Couldn't record a consent event, retrying").pipe(
      Effect.annotateLogs({ reason: input.reason.message, attempt }),
    ),
  ),
);

const make = (history: Effect.Effect<ReadonlyMap<string, ConsentRecord>>) =>
  Effect.gen(function* () {
    const known = yield* Deferred.make<ReadonlyMap<string, ConsentRecord>>();
    const noted = yield* Ref.make<ReadonlyMap<string, Noted>>(new Map());

    yield* history.pipe(
      Effect.flatMap((loaded) => Deferred.succeed(known, loaded)),
      Effect.forkScoped,
    );

    const recordIn = (records: ReadonlyMap<string, ConsentRecord>, userId: string) =>
      Ref.get(noted).pipe(
        Effect.map((all) =>
          recordAfter(records.get(userId) ?? NEVER_ASKED, all.get(userId) ?? NOTHING_NOTED),
        ),
      );

    const lookup = (userId: string) =>
      Deferred.await(known).pipe(Effect.flatMap((records) => recordIn(records, userId)));

    const lookupWithin = (userId: string, wait: Duration.Duration) =>
      Deferred.await(known).pipe(
        Effect.timeoutOption(wait),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (records) => Effect.asSome(recordIn(records, userId)),
          }),
        ),
      );

    const remember = (event: ConsentEvent) =>
      Ref.update(noted, (all) =>
        new Map(all).set(event.userId, noting(all.get(event.userId) ?? NOTHING_NOTED, event)),
      );

    const forget = (userId: string) =>
      Ref.update(noted, (all) => new Map(all).set(userId, FORGOTTEN));

    return { lookup, lookupWithin, remember, forget };
  });

export class ConsentBook extends Context.Service<
  ConsentBook,
  {
    lookup(userId: string): Effect.Effect<ConsentRecord>;
    lookupWithin(
      userId: string,
      wait: Duration.Duration,
    ): Effect.Effect<Option.Option<ConsentRecord>>;
    note(event: ConsentEvent): Effect.Effect<void>;
    remember(event: ConsentEvent): Effect.Effect<void>;
    forget(userId: string): Effect.Effect<void>;
  }
>()("bot/consent/ConsentBook") {
  static readonly layer = Layer.effect(
    ConsentBook,
    Effect.gen(function* () {
      const database = yield* Database;
      const log = yield* ConsentLog;
      const buffer = yield* Queue.unbounded<ConsentEvent, Cause.Done>();
      const inFlight = yield* Ref.make(Option.none<ConsentEvent>());

      const book = yield* make(
        database.ready.pipe(
          Effect.andThen(log.history),
          Effect.retry(retryOutages),
          Effect.catchCause((cause) =>
            Effect.logError(
              "Couldn't read who agreed to being recorded, asking everyone",
              cause,
            ).pipe(
              Effect.andThen(ErrorReporter.report(cause)),
              Effect.as<ReadonlyMap<string, ConsentRecord>>(new Map()),
            ),
          ),
        ),
      );

      const write = (event: ConsentEvent) =>
        log.append(event).pipe(
          Effect.retry(retryOutages),
          Effect.catch((error) =>
            logUnwritten("The database rejected a consent event, logging it instead", event).pipe(
              Effect.annotateLogs({ reason: error.reason.message }),
            ),
          ),
        );

      const writeNext = Effect.uninterruptibleMask((restore) =>
        restore(Queue.take(buffer)).pipe(
          Effect.tap((event) => Ref.set(inFlight, Option.some(event))),
        ),
      ).pipe(Effect.flatMap(write), Effect.andThen(Ref.set(inFlight, Option.none())));

      const writer = yield* database.ready.pipe(
        Effect.andThen(Effect.forever(writeNext)),
        Effect.catchIf(Cause.isDone, () => Effect.void),
        Effect.forkScoped,
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Queue.end(buffer);

          const flushed = yield* Fiber.await(writer).pipe(Effect.timeoutOption(FLUSH_TIMEOUT));

          if (Option.isSome(flushed)) return;

          yield* Fiber.interrupt(writer);

          const unwritten = [
            ...Option.toArray(yield* Ref.get(inFlight)),
            ...(yield* Queue.clear(buffer)),
          ];

          yield* Effect.forEach(unwritten, (event) =>
            logUnwritten("Couldn't record a consent event before shutting down", event),
          );
        }),
      );

      const note = (event: ConsentEvent) =>
        book.remember(event).pipe(
          Effect.andThen(Queue.offer(buffer, event)),
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : logUnwritten("Couldn't buffer a consent event, logging it instead", event),
          ),
        );

      return ConsentBook.of({ ...book, note });
    }),
  );

  static readonly layerMemory = Layer.effect(
    ConsentBook,
    Effect.gen(function* () {
      const book = yield* make(Effect.succeed(new Map()));

      return ConsentBook.of({ ...book, note: book.remember });
    }),
  );
}
