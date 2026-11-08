import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  ErrorReporter,
  FiberMap,
  Layer,
  Match,
  Option,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { SecureRandom } from "effect/crypto";
import type {
  ConsentEventKind,
  ConsentStanding,
  Delivery,
  Wording,
} from "recording-requests/Consent";
import {
  type Erasure,
  type ErasureHandler,
  ConsentRequests,
  type Withdrawal,
} from "recording-requests/ConsentRequests";
import { CHECK_INTERVAL } from "recording-requests/RecordingRequest";

import { ConsentBook, LOOKUP_WAIT, Notice } from "../consent/index.ts";
import { Eraser, type PrepareError } from "../erasure/index.ts";
import {
  Admission,
  type ConsentAnswer,
  ConsentGate,
  type ConsentLine,
  DiscordGateway,
  type Visit,
} from "../office/index.ts";
import { StoreHealth } from "../recording/index.ts";

const {
  AGREED,
  ANSWER_TIME,
  askFor,
  DECLINED,
  ERASED,
  ERASED_AND_SHOWN_OUT,
  ERASED_REASON,
  EXPIRED,
  LEFT,
  QUESTION_ERASED,
  QUESTION_WITHDRAWN,
  RESTARTING,
  SHOWN_OUT_REASON,
  TIMED_OUT,
  WITHDRAWN,
  WITHDRAWN_AND_SHOWN_OUT,
} = Notice;

const HANDLING_WITHDRAWALS = "Couldn't handle consent withdrawals";

export const ERASURE_RETRY_FIRST = Duration.seconds(30);

export const ERASURE_RETRY_LONGEST = Duration.minutes(30);

export const ERASURE_SWEEP_DELAY = Duration.minutes(1);

const erasureRetry = Schedule.exponential(ERASURE_RETRY_FIRST).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, ERASURE_RETRY_LONGEST)),
  ),
);

type Lapse = "left" | "withdrawn" | "erased";

const deliveryOf = (via: Option.Option<{ readonly via: Delivery }>): Delivery =>
  Option.match(via, { onNone: () => "undelivered", onSome: ({ via }) => via });

const run = Effect.fnUntraced(function* (line: ConsentLine) {
  const gate = yield* ConsentGate;
  const book = yield* ConsentBook;
  const requests = yield* ConsentRequests;
  const eraser = yield* Eraser;
  const scope = yield* Scope.Scope;
  const random = yield* SecureRandom.SecureRandom;
  const health = yield* StoreHealth.make;
  const waiting = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<ConsentAnswer>>>(new Map());
  const lapses = yield* Ref.make<ReadonlyMap<string, Lapse>>(new Map());
  const settled = yield* Ref.make<ReadonlySet<string>>(new Set());
  const shownOutForErasure = yield* Ref.make<ReadonlySet<string>>(new Set());
  const asks = yield* FiberMap.make<string>();

  const note = (userId: string, kind: ConsentEventKind, wording?: Wording, delivery?: Delivery) =>
    DateTime.now.pipe(
      Effect.flatMap((at) =>
        book.note(
          wording === undefined || delivery === undefined
            ? { userId, at, kind }
            : { userId, at, kind, asked: { wording, delivery } },
        ),
      ),
    );

  const showOut = (userId: string) =>
    line
      .showOut(userId, SHOWN_OUT_REASON)
      .pipe(Effect.flatMap((shown) => (shown ? note(userId, "disconnected") : Effect.void)));

  const forget = (promptId: string) =>
    Ref.update(settled, (all) => new Set(all).add(promptId)).pipe(
      Effect.andThen(
        Ref.update(waiting, (all) => {
          const next = new Map(all);
          next.delete(promptId);

          return next;
        }),
      ),
    );

  const awaitAnswer = (promptId: string) =>
    Effect.acquireRelease(
      Deferred.make<ConsentAnswer>().pipe(
        Effect.tap((answer) => Ref.update(waiting, (all) => new Map(all).set(promptId, answer))),
      ),
      () => forget(promptId),
    );

  const lapsed = (userId: string, settle: (text: string) => Effect.Effect<void>) =>
    Ref.get(lapses).pipe(
      Effect.flatMap((all) =>
        Match.value(all.get(userId)).pipe(
          Match.when("left", () => note(userId, "left").pipe(Effect.andThen(settle(LEFT)))),
          Match.when("withdrawn", () => settle(QUESTION_WITHDRAWN)),
          Match.when("erased", () => settle(QUESTION_ERASED)),
          Match.orElse(() => settle(RESTARTING)),
        ),
      ),
    );

  const answerBy = (answer: Deferred.Deferred<ConsentAnswer>, promptId: string) =>
    Deferred.await(answer).pipe(
      Effect.timeoutOption(ANSWER_TIME),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeedSome,
          onNone: () =>
            forget(promptId).pipe(
              Effect.andThen(Deferred.poll(answer)),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeedNone,
                  onSome: Effect.asSome,
                }),
              ),
            ),
        }),
      ),
    );

  const ask = Effect.fn("ConsentDesk.ask")(function* (userId: string, displayName: string) {
    const record = yield* book.lookup(userId);

    if (record.agreed) return yield* gate.decide(Admission.Agreed({ userId }));

    const wording: Wording = record.asked === 0 ? "first" : "again";
    const promptId = yield* random.uuidV4();
    const answer = yield* awaitAnswer(promptId);
    const delivery = yield* line.ask(userId, promptId, askFor(wording, displayName));

    yield* note(userId, "asked", wording, deliveryOf(delivery));

    const settle = (text: string) =>
      Option.match(delivery, { onNone: () => Effect.void, onSome: (sent) => sent.settle(text) });

    const answered = yield* answerBy(answer, promptId).pipe(
      Effect.onInterrupt(() => lapsed(userId, settle)),
    );

    if (Option.isNone(answered)) {
      yield* note(userId, "timed_out");
      yield* gate.decide(Admission.Refused({ userId }));
      yield* settle(TIMED_OUT);
      yield* showOut(userId);

      return yield* Effect.logInfo("Showed someone out who didn't answer in time");
    }

    if (answered.value.choice === "agree") {
      yield* note(userId, "agreed");
      yield* gate.decide(Admission.Agreed({ userId }));
      yield* answered.value.reply(AGREED(displayName));

      return yield* Effect.logInfo("Someone agreed to being recorded in the office");
    }

    yield* note(userId, "declined");
    yield* gate.decide(Admission.Refused({ userId }));
    yield* answered.value.reply(DECLINED);
    yield* showOut(userId);

    yield* Effect.logInfo("Showed someone out who declined");
  }, Effect.scoped);

  const stopAsking = (userId: string, lapse: Lapse) =>
    Ref.update(lapses, (all) => new Map(all).set(userId, lapse)).pipe(
      Effect.andThen(FiberMap.remove(asks, userId)),
    );

  const onVisit = (visit: Visit) =>
    Match.valueTags(visit, {
      Arrived: ({ userId, displayName }) =>
        Ref.update(lapses, (all) => {
          const next = new Map(all);
          next.delete(userId);

          return next;
        }).pipe(Effect.andThen(FiberMap.run(asks, userId, ask(userId, displayName)))),
      Departed: ({ userId }) => stopAsking(userId, "left"),
    });

  const route = Effect.fnUntraced(function* (answer: ConsentAnswer) {
    const pending = (yield* Ref.get(waiting)).get(answer.promptId);

    if (pending !== undefined) {
      const first = yield* Deferred.succeed(pending, answer);

      return yield* first ? Effect.void : answer.acknowledge;
    }

    return yield* (yield* Ref.get(settled)).has(answer.promptId)
      ? answer.acknowledge
      : answer.reply(EXPIRED);
  });

  const withdrawn = Effect.fnUntraced(function* (userId: string) {
    yield* book.remember({ userId, at: yield* DateTime.now, kind: "withdrawn" });
    yield* stopAsking(userId, "withdrawn");
    yield* gate.decide(Admission.Withdrawn({ userId }));

    const shown = yield* line.showOut(userId, SHOWN_OUT_REASON);

    if (shown) yield* note(userId, "disconnected");

    yield* line.tell(userId, shown ? WITHDRAWN_AND_SHOWN_OUT : WITHDRAWN);
  });

  const withdraw = ({ userId }: Withdrawal, recorded: ConsentStanding) =>
    book
      .lookupWithin(userId, LOOKUP_WAIT)
      .pipe(
        Effect.map((noted) =>
          recorded === "agreed" || Option.exists(noted, (record) => record.agreed)
            ? Option.some({ afterCommit: withdrawn(userId) })
            : Option.none(),
        ),
      );

  const handleWithdrawals = requests
    .handleWithdrawals({ withdraw })
    .pipe(
      Effect.andThen(health.ok(HANDLING_WITHDRAWALS)),
      Effect.catchTag("RecordingUnavailable", health.issue(HANDLING_WITHDRAWALS)),
    );

  const markShownOut = (userId: string, shown: boolean) =>
    shown ? Ref.update(shownOutForErasure, (all) => new Set(all).add(userId)) : Effect.void;

  const takeShownOut = (userId: string) =>
    Ref.modify(shownOutForErasure, (all): readonly [boolean, ReadonlySet<string>] => {
      const next = new Set(all);
      next.delete(userId);

      return [all.has(userId), next];
    });

  const sweepLater = (userId: string) =>
    Effect.sleep(ERASURE_SWEEP_DELAY).pipe(
      Effect.andThen(gate.isAdmitted(userId)),
      Effect.flatMap((admitted) => (admitted ? Effect.void : eraser.sweep(userId))),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const erasures: ErasureHandler<PrepareError, never> = {
    prepare: Effect.fnUntraced(function* ({ userId }: Erasure) {
      yield* book.remember({ userId, at: yield* DateTime.now, kind: "withdrawn" });
      yield* stopAsking(userId, "erased");
      yield* gate.decide(Admission.Withdrawn({ userId }));
      yield* markShownOut(userId, yield* line.showOut(userId, ERASED_REASON));
      yield* eraser.prepare(userId);
    }),
    erase: ({ userId }) =>
      eraser.erase(userId).pipe(
        Effect.map((erased) => ({
          afterCommit: Effect.gen(function* () {
            yield* book.forget(userId);
            yield* sweepLater(userId);
            yield* eraser.removeAudio(erased.objectPaths);
            yield* line.tell(userId, (yield* takeShownOut(userId)) ? ERASED_AND_SHOWN_OUT : ERASED);
            yield* Effect.logInfo("Erased someone's data and told them").pipe(
              Effect.annotateLogs({ recordingsToRepublish: erased.republishing }),
            );
          }),
        })),
      ),
  };

  const handleErasures = requests.handleErasures(erasures).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Couldn't erase someone's data yet, trying again later").pipe(
        Effect.annotateLogs({ reason: error.message }),
        Effect.andThen(ErrorReporter.report(Cause.fail(error))),
      ),
    ),
    Effect.retry(erasureRetry),
    Effect.orDie,
  );

  yield* Effect.all(
    [
      Stream.runForEach(gate.visits, onVisit),
      Stream.runForEach(line.answers, route),
      Effect.schedule(handleWithdrawals, Schedule.spaced(CHECK_INTERVAL)),
      Effect.schedule(handleErasures, Schedule.spaced(CHECK_INTERVAL)),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

export const ConsentDeskLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;

    yield* Option.match(gateway.consentLine, {
      onNone: () => Effect.logInfo("No office voice channel, so nobody is asked for consent"),
      onSome: run,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Stopped asking for consent", cause).pipe(
          Effect.andThen(ErrorReporter.report(cause)),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
