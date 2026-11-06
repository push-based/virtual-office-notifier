import {
  DateTime,
  Deferred,
  Effect,
  ErrorReporter,
  FiberMap,
  Layer,
  Match,
  Option,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { SecureRandom } from "effect/crypto";
import type { ConsentEventKind, Delivery, Wording } from "recording-requests/Consent";
import { ConsentRequests, type Withdrawal } from "recording-requests/ConsentRequests";
import { CHECK_INTERVAL } from "recording-requests/RecordingRequest";

import { DiscordGateway } from "../office/index.ts";
import { StoreHealth } from "../recording/index.ts";
import {
  Admission,
  type ConsentAnswer,
  ConsentBook,
  ConsentGate,
  type ConsentLine,
  Notice,
  type Visit,
} from "../consent/index.ts";

const {
  AGREED,
  ANSWER_TIME,
  askFor,
  DECLINED,
  EXPIRED,
  LEFT,
  RESTARTING,
  SHOWN_OUT_REASON,
  TIMED_OUT,
  WITHDRAWN,
  WITHDRAWN_AND_SHOWN_OUT,
} = Notice;

const HANDLING_WITHDRAWALS = "Couldn't handle consent withdrawals";

const deliveryOf = (via: Option.Option<{ readonly via: Delivery }>): Delivery =>
  Option.match(via, { onNone: () => "undelivered", onSome: ({ via }) => via });

const run = Effect.fnUntraced(function* (line: ConsentLine) {
  const gate = yield* ConsentGate;
  const book = yield* ConsentBook;
  const requests = yield* ConsentRequests;
  const random = yield* SecureRandom.SecureRandom;
  const health = yield* StoreHealth.make;
  const waiting = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<ConsentAnswer>>>(new Map());
  const departed = yield* Ref.make<ReadonlySet<string>>(new Set());
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

  const awaitAnswer = (promptId: string) =>
    Effect.acquireRelease(
      Deferred.make<ConsentAnswer>().pipe(
        Effect.tap((answer) => Ref.update(waiting, (all) => new Map(all).set(promptId, answer))),
      ),
      () =>
        Ref.update(waiting, (all) => {
          const next = new Map(all);
          next.delete(promptId);

          return next;
        }),
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

    const answered = yield* Deferred.await(answer).pipe(
      Effect.timeoutOption(ANSWER_TIME),
      Effect.onInterrupt(() =>
        Ref.get(departed).pipe(
          Effect.flatMap((gone) =>
            gone.has(userId)
              ? note(userId, "left").pipe(Effect.andThen(settle(LEFT)))
              : settle(RESTARTING),
          ),
        ),
      ),
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

  const onVisit = (visit: Visit) =>
    Match.valueTags(visit, {
      Arrived: ({ userId, displayName }) =>
        Ref.update(departed, (gone) => {
          const next = new Set(gone);
          next.delete(userId);

          return next;
        }).pipe(Effect.andThen(FiberMap.run(asks, userId, ask(userId, displayName)))),
      Departed: ({ userId }) =>
        Ref.update(departed, (gone) => new Set(gone).add(userId)).pipe(
          Effect.andThen(FiberMap.remove(asks, userId)),
        ),
    });

  const route = (answer: ConsentAnswer) =>
    Ref.get(waiting).pipe(
      Effect.flatMap((all) => {
        const pending = all.get(answer.promptId);

        return pending === undefined
          ? answer.reply(EXPIRED)
          : Deferred.succeed(pending, answer).pipe(Effect.asVoid);
      }),
    );

  const withdraw = (withdrawal: Withdrawal) =>
    Effect.succeed({
      afterCommit: Effect.gen(function* () {
        const { userId } = withdrawal;

        yield* book.remember({ userId, at: yield* DateTime.now, kind: "withdrawn" });
        yield* gate.decide(Admission.Withdrawn({ userId }));

        const shown = yield* line.showOut(userId, SHOWN_OUT_REASON);

        if (shown) yield* note(userId, "disconnected");

        yield* line.tell(userId, shown ? WITHDRAWN_AND_SHOWN_OUT : WITHDRAWN);
      }),
    });

  const handleWithdrawals = requests
    .handlePending({ withdraw })
    .pipe(
      Effect.andThen(health.ok(HANDLING_WITHDRAWALS)),
      Effect.catchTag("RecordingUnavailable", health.issue(HANDLING_WITHDRAWALS)),
    );

  yield* Effect.all(
    [
      Stream.runForEach(gate.visits, onVisit),
      Stream.runForEach(line.answers, route),
      Effect.schedule(handleWithdrawals, Schedule.spaced(CHECK_INTERVAL)),
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
