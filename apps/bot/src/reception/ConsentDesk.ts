import {
  Array,
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
import type { Admin } from "recording-requests/Admins";
import type {
  ConsentEventKind,
  ConsentStanding,
  Delivery,
  ErasureCase,
  Wording,
} from "recording-requests/Consent";
import {
  ConsentRequests,
  type ErasureHandler,
  type ErasureNotice,
  type NoticeMedium,
  type Settled,
  type Withdrawal,
} from "recording-requests/ConsentRequests";
import { CHECK_INTERVAL } from "recording-requests/RecordingRequest";
import type { RecordingUnavailable } from "recording-requests/RecordingRequests";

import { ConsentBook, LOOKUP_WAIT, Notice } from "../consent/index.ts";
import { Eraser, type PrepareError } from "../erasure/index.ts";
import {
  type AdminLine,
  Admission,
  type ConsentAnswer,
  ConsentGate,
  type ConsentLine,
  DiscordGateway,
  type ErasureAction,
  type Visit,
} from "../office/index.ts";
import { StoreHealth } from "../recording/index.ts";
import { SlackAdminLine } from "./SlackAdminLine.ts";

const {
  AGREED,
  ALREADY_DECIDED,
  ANSWER_TIME,
  askAbout,
  CANCELLED,
  DECLINED,
  ERASED,
  ERASED_AND_SHOWN_OUT,
  ERASED_REASON,
  EXPIRED,
  LEFT,
  NOTED_NOW,
  NOTED_REFUSED,
  NOTED_SEEN,
  NOT_AN_ADMIN,
  QUESTION_ERASED,
  QUESTION_WITHDRAWN,
  REFUSED,
  RESTARTING,
  SCHEDULED,
  SHOWN_OUT_REASON,
  TIMED_OUT,
  WITHDRAWN,
  WITHDRAWN_AND_SHOWN_OUT,
} = Notice;

const HANDLING_WITHDRAWALS = "Couldn't handle consent withdrawals";

const DATABASE_DOWN = "Couldn't reach the database. Try again in a moment.";

export const ERASURE_RETRY_FIRST = Duration.seconds(30);

export const ERASURE_RETRY_LONGEST = Duration.minutes(30);

export const ERASURE_SWEEP_DELAY = Duration.minutes(1);

const erasureRetry = Schedule.exponential(ERASURE_RETRY_FIRST).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, ERASURE_RETRY_LONGEST)),
  ),
);

type Lapse = "left" | "withdrawn" | "erased";

interface AdminPress {
  readonly medium: NoticeMedium;
  readonly action: ErasureAction;
}

const deliveryOf = (via: Option.Option<{ readonly via: Delivery }>): Delivery =>
  Option.match(via, { onNone: () => "undelivered", onSome: ({ via }) => via });

const run = Effect.fnUntraced(function* (line: ConsentLine, adminLines: ReadonlyArray<AdminLine>) {
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

  const databaseDown = (what: string) => (error: { readonly reason: string }) =>
    Effect.logWarning(what).pipe(Effect.annotateLogs({ reason: error.reason }));

  const hasPendingErasure = (userId: string) =>
    requests.pendingErasureOf(userId).pipe(
      Effect.map(Option.isSome),
      Effect.catchTag("RecordingUnavailable", (error) =>
        databaseDown("Couldn't check for a pending deletion request before asking")(error).pipe(
          Effect.as(false),
        ),
      ),
    );

  const cancelErasures = (userId: string) =>
    requests
      .cancelErasuresOf(userId)
      .pipe(
        Effect.catchTag(
          "RecordingUnavailable",
          databaseDown("Couldn't cancel a deletion request after someone agreed"),
        ),
      );

  const ask = Effect.fn("ConsentDesk.ask")(function* (userId: string, displayName: string) {
    const record = yield* book.lookup(userId);

    if (record.agreed) return yield* gate.decide(Admission.Agreed({ userId }));

    const wording: Wording = record.asked === 0 ? "first" : "again";
    const pendingErasure = yield* hasPendingErasure(userId);
    const promptId = yield* random.uuidV4();
    const answer = yield* awaitAnswer(promptId);

    const delivery = yield* line.ask(
      userId,
      promptId,
      askAbout(wording, displayName, pendingErasure),
    );

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

      if (pendingErasure) yield* cancelErasures(userId);

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

  const lineFor = (medium: ErasureNotice["medium"]) =>
    Array.findFirst(adminLines, (candidate) => candidate.medium === medium);

  const notifyAdmins = (admins: ReadonlyArray<Admin>, erasure: ErasureCase) =>
    Effect.forEach(
      admins,
      (admin) =>
        Effect.forEach(
          adminLines,
          (candidate) =>
            candidate.notify(admin, erasure).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (sent) =>
                    requests
                      .recordNotice({
                        requestId: erasure.id,
                        medium: candidate.medium,
                        recipient: admin.discordUserId,
                        channel: sent.channel,
                        messageId: sent.messageId,
                      })
                      .pipe(
                        Effect.catchTag(
                          "RecordingUnavailable",
                          databaseDown("Couldn't remember an admin's message about a deletion"),
                        ),
                      ),
                }),
              ),
            ),
          { discard: true },
        ),
      { discard: true },
    );

  const updateNotices = (erasure: ErasureCase, outcome: Notice.AdminOutcome) =>
    requests.noticesOf(erasure.id).pipe(
      Effect.flatMap((notices) =>
        Effect.forEach(
          notices,
          (notice) =>
            Option.match(lineFor(notice.medium), {
              onNone: () => Effect.void,
              onSome: (candidate) =>
                candidate.update(
                  notice,
                  Notice.adminSettled(
                    erasure,
                    outcome,
                    Option.fromNullOr(erasure.decidedByName),
                    notice.medium,
                  ),
                ),
            }),
          { discard: true },
        ),
      ),
      Effect.catchTag(
        "RecordingUnavailable",
        databaseDown("Couldn't find the admins' messages about a deletion to update them"),
      ),
    );

  const erasures: ErasureHandler<PrepareError | RecordingUnavailable, never> = {
    announce: Effect.fnUntraced(function* (erasure: ErasureCase) {
      const { userId } = erasure;
      const admins = yield* requests.admins;

      yield* book.remember({ userId, at: yield* DateTime.now, kind: "withdrawn" });
      yield* stopAsking(userId, "erased");
      yield* gate.decide(Admission.Withdrawn({ userId }));

      const shown = yield* line.showOut(userId, ERASED_REASON);

      if (shown) yield* note(userId, "disconnected");

      yield* line.tell(userId, SCHEDULED(erasure.dueAt, shown));

      if (admins.length === 0)
        return yield* Effect.logWarning(
          "Nobody is an admin, so nobody was told about a deletion request",
        );

      yield* notifyAdmins(admins, erasure);
      yield* Effect.logInfo("Told the admins about a deletion request");
    }),
    settle: (erasure: ErasureCase, outcome: Settled) =>
      Effect.succeed({
        afterCommit: Effect.gen(function* () {
          yield* line.tell(
            erasure.userId,
            outcome === "refused" && erasure.refusal !== null
              ? REFUSED(erasure.refusal.ground, erasure.refusal.reason)
              : CANCELLED,
          );
          yield* updateNotices(erasure, outcome);
        }),
      }),
    prepare: Effect.fnUntraced(function* ({ userId }: ErasureCase) {
      yield* stopAsking(userId, "erased");
      yield* gate.decide(Admission.Withdrawn({ userId }));
      yield* markShownOut(userId, yield* line.showOut(userId, ERASED_REASON));
      yield* eraser.prepare(userId);
    }),
    erase: (erasure: ErasureCase) =>
      book.lookupWithin(erasure.userId, LOOKUP_WAIT).pipe(
        Effect.flatMap((noted) =>
          Option.exists(noted, (record) => record.agreed)
            ? Effect.succeedNone
            : eraser.erase(erasure.userId).pipe(
                Effect.map((erased) =>
                  Option.some({
                    afterCommit: Effect.gen(function* () {
                      yield* book.forget(erasure.userId);
                      yield* sweepLater(erasure.userId);
                      yield* eraser.removeAudio(erased.objectPaths);
                      yield* line.tell(
                        erasure.userId,
                        (yield* takeShownOut(erasure.userId)) ? ERASED_AND_SHOWN_OUT : ERASED,
                      );
                      yield* updateNotices(erasure, "erased");
                      yield* Effect.logInfo("Erased someone's data and told them").pipe(
                        Effect.annotateLogs({ recordingsToRepublish: erased.republishing }),
                      );
                    }),
                  }),
                ),
              ),
        ),
      ),
  };

  const handleErasures = requests.handleErasures(erasures).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Couldn't handle a deletion request yet, trying again later").pipe(
        Effect.annotateLogs({ reason: error.message }),
        Effect.andThen(ErrorReporter.report(Cause.fail(error))),
      ),
    ),
    Effect.retry(erasureRetry),
    Effect.orDie,
  );

  const record = (action: ErasureAction, adminId: string) =>
    Match.value(action.verdict).pipe(
      Match.when({ kind: "now" }, () =>
        requests.expedite(action.requestId, adminId).pipe(Effect.map(Option.as(NOTED_NOW))),
      ),
      Match.when({ kind: "seen" }, () =>
        requests.seen(action.requestId, adminId).pipe(Effect.map(Option.as(NOTED_SEEN))),
      ),
      Match.when({ kind: "refuse" }, ({ ground, reason }) =>
        requests
          .refuse(action.requestId, adminId, { ground, reason })
          .pipe(Effect.map(Option.as(NOTED_REFUSED))),
      ),
      Match.exhaustive,
      Effect.map(Option.getOrElse(() => ALREADY_DECIDED)),
      Effect.tap(() =>
        Effect.logInfo("An admin decided about a deletion request").pipe(
          Effect.annotateLogs({ request: action.requestId, verdict: action.verdict.kind }),
        ),
      ),
    );

  const decide = Effect.fnUntraced(function* ({ medium, action }: AdminPress) {
    const answer = yield* requests.adminOf(medium, action.userId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(NOT_AN_ADMIN),
          onSome: (admin) => record(action, admin.discordUserId),
        }),
      ),
      Effect.catchTag("RecordingUnavailable", (error) =>
        databaseDown("Couldn't record an admin's decision about a deletion")(error).pipe(
          Effect.as(DATABASE_DOWN),
        ),
      ),
    );

    yield* action.reply(answer);
  });

  const adminActions = Stream.mergeAll(
    Array.map(adminLines, (candidate) =>
      Stream.map(candidate.actions, (action): AdminPress => ({ medium: candidate.medium, action })),
    ),
    { concurrency: "unbounded" },
  );

  yield* Effect.all(
    [
      Stream.runForEach(gate.visits, onVisit),
      Stream.runForEach(line.answers, route),
      Stream.runForEach(adminActions, decide),
      Effect.schedule(handleWithdrawals, Schedule.spaced(CHECK_INTERVAL)),
      Effect.schedule(handleErasures, Schedule.spaced(CHECK_INTERVAL)),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

export const ConsentDeskLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const slackAdmins = yield* SlackAdminLine;

    yield* Option.match(gateway.consentLine, {
      onNone: () => Effect.logInfo("No office voice channel, so nobody is asked for consent"),
      onSome: (line) => run(line, [gateway.adminLine, slackAdmins]),
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
