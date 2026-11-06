import {
  Array,
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Queue,
  Ref,
  Result,
  Stream,
} from "effect";

import { ConsentBook, LOOKUP_WAIT } from "../consent/index.ts";
import {
  Admission,
  admit,
  type Decision,
  type Gated,
  type Gatekeeping,
  gatekeepingOf,
  type Visit,
} from "./Admission.ts";
import type { TimedVoiceStateUpdate } from "./OfficeEvent.ts";

export interface PromptDelivery {
  readonly via: "direct_message" | "voice_chat";
  settle(text: string): Effect.Effect<void>;
}

export type Choice = "agree" | "decline";

export interface ConsentAnswer {
  readonly promptId: string;
  readonly userId: string;
  readonly choice: Choice;
  reply(text: string): Effect.Effect<void>;
  readonly acknowledge: Effect.Effect<void>;
}

export interface ConsentLine {
  ask(userId: string, promptId: string, text: string): Effect.Effect<Option.Option<PromptDelivery>>;
  tell(userId: string, text: string): Effect.Effect<void>;
  showOut(userId: string, reason: string): Effect.Effect<boolean>;
  readonly answers: Stream.Stream<ConsentAnswer>;
}

export interface Gate {
  admit(
    officeChannelId: string,
    admittedAtStart: ReadonlySet<string>,
  ): <E, R>(
    updates: Stream.Stream<TimedVoiceStateUpdate, E, R>,
  ) => Stream.Stream<TimedVoiceStateUpdate, E, R>;
  consentedAmong(userIds: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>>;
  isAdmitted(userId: string): Effect.Effect<boolean>;
  admittedSince(userId: string): Effect.Effect<Option.Option<DateTime.Utc>>;
  decide(decision: Decision): Effect.Effect<void>;
  readonly visits: Stream.Stream<Visit>;
}

const isPassed = Predicate.isTagged("Passed");

const passedUpdate = (gated: Gated): Result.Result<TimedVoiceStateUpdate, Gated> =>
  isPassed(gated) ? Result.succeed(gated.update) : Result.fail(gated);

const LONG_AGO = DateTime.makeUnsafe(0);

export class ConsentGate extends Context.Service<ConsentGate, Gate>()("bot/office/ConsentGate") {
  static readonly layer = Layer.effect(
    ConsentGate,
    Effect.gen(function* () {
      const book = yield* ConsentBook;
      const state = yield* Ref.make<Gatekeeping>(gatekeepingOf(new Set()));
      const since = yield* Ref.make<ReadonlyMap<string, DateTime.Utc>>(new Map());
      const decisions = yield* Queue.unbounded<Decision>();
      const visits = yield* Queue.unbounded<Visit>();

      const admitUpdates =
        (officeChannelId: string, admittedAtStart: ReadonlySet<string>) =>
        <E, R>(updates: Stream.Stream<TimedVoiceStateUpdate, E, R>) =>
          Stream.unwrap(
            Effect.all([
              Ref.set(state, gatekeepingOf(admittedAtStart)),
              Ref.set(
                since,
                new Map(Array.map([...admittedAtStart], (userId) => [userId, LONG_AGO])),
              ),
            ]).pipe(
              Effect.as(
                updates.pipe(
                  Stream.map((update): Admission => Admission.Heard({ update })),
                  Stream.merge(Stream.fromQueue(decisions), { haltStrategy: "left" }),
                  Stream.mapEffect((input) =>
                    Ref.modify(state, (current) => {
                      const [next, gated] = admit(officeChannelId)(current, input);

                      return [gated, next];
                    }),
                  ),
                  Stream.flattenIterable,
                  Stream.tap((gated) =>
                    isPassed(gated) ? Effect.void : Queue.offer(visits, gated),
                  ),
                  Stream.filterMap(passedUpdate),
                ),
              ),
            ),
          );

      const consentedAmong = (userIds: ReadonlyArray<string>) =>
        Effect.forEach(userIds, (userId) => book.lookupWithin(userId, LOOKUP_WAIT), {
          concurrency: "unbounded",
        }).pipe(
          Effect.map(
            (records): ReadonlySet<string> =>
              new Set(
                Array.filter(userIds, (_, index) =>
                  Option.exists(records[index] ?? Option.none(), ({ agreed }) => agreed),
                ),
              ),
          ),
        );

      const remember = (decision: Decision) =>
        Match.valueTags(decision, {
          Agreed: ({ userId }) =>
            DateTime.now.pipe(
              Effect.flatMap((at) =>
                Ref.update(since, (all) => (all.has(userId) ? all : new Map(all).set(userId, at))),
              ),
            ),
          Refused: () => Effect.void,
          Withdrawn: ({ userId }) =>
            Ref.update(since, (all) => {
              const next = new Map(all);
              next.delete(userId);

              return next;
            }),
        });

      return ConsentGate.of({
        admit: admitUpdates,
        consentedAmong,
        isAdmitted: (userId) =>
          Ref.get(state).pipe(Effect.map(({ admitted }) => admitted.has(userId))),
        admittedSince: (userId) =>
          Ref.get(since).pipe(Effect.map((all) => Option.fromUndefinedOr(all.get(userId)))),
        decide: (decision) =>
          remember(decision).pipe(Effect.andThen(Queue.offer(decisions, decision)), Effect.asVoid),
        visits: Stream.fromQueue(visits),
      });
    }),
  );

  static readonly open: Gate = {
    admit: () => (updates) => updates,
    consentedAmong: (userIds) => Effect.succeed(new Set(userIds)),
    isAdmitted: () => Effect.succeed(true),
    admittedSince: () => Effect.succeedSome(LONG_AGO),
    decide: () => Effect.void,
    visits: Stream.empty,
  };

  static readonly layerOpen = Layer.succeed(ConsentGate, ConsentGate.of(ConsentGate.open));
}
