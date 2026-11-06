import {
  Array,
  Context,
  Effect,
  Layer,
  type Option,
  Predicate,
  Queue,
  Ref,
  Result,
  Stream,
} from "effect";

import type { TimedVoiceStateUpdate } from "../office/index.ts";
import {
  Admission,
  admit,
  type Decision,
  type Gated,
  type Gatekeeping,
  gatekeepingOf,
  type Visit,
} from "./Admission.ts";
import { ConsentBook } from "./ConsentBook.ts";

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
  decide(decision: Decision): Effect.Effect<void>;
  readonly visits: Stream.Stream<Visit>;
}

const isPassed = Predicate.isTagged("Passed");

const passedUpdate = (gated: Gated): Result.Result<TimedVoiceStateUpdate, Gated> =>
  isPassed(gated) ? Result.succeed(gated.update) : Result.fail(gated);

export class ConsentGate extends Context.Service<ConsentGate, Gate>()("bot/consent/ConsentGate") {
  static readonly layer = Layer.effect(
    ConsentGate,
    Effect.gen(function* () {
      const book = yield* ConsentBook;
      const state = yield* Ref.make<Gatekeeping>(gatekeepingOf(new Set()));
      const decisions = yield* Queue.unbounded<Decision>();
      const visits = yield* Queue.unbounded<Visit>();

      const admitUpdates =
        (officeChannelId: string, admittedAtStart: ReadonlySet<string>) =>
        <E, R>(updates: Stream.Stream<TimedVoiceStateUpdate, E, R>) =>
          Stream.unwrap(
            Ref.set(state, gatekeepingOf(admittedAtStart)).pipe(
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
        Effect.forEach(userIds, (userId) => book.lookup(userId), { concurrency: "unbounded" }).pipe(
          Effect.map(
            (records): ReadonlySet<string> =>
              new Set(Array.filter(userIds, (_, index) => records[index]?.agreed === true)),
          ),
        );

      return ConsentGate.of({
        admit: admitUpdates,
        consentedAmong,
        isAdmitted: (userId) =>
          Ref.get(state).pipe(Effect.map(({ admitted }) => admitted.has(userId))),
        decide: (decision) => Queue.offer(decisions, decision).pipe(Effect.asVoid),
        visits: Stream.fromQueue(visits),
      });
    }),
  );

  static readonly open: Gate = {
    admit: () => (updates) => updates,
    consentedAmong: (userIds) => Effect.succeed(new Set(userIds)),
    isAdmitted: () => Effect.succeed(true),
    decide: () => Effect.void,
    visits: Stream.empty,
  };

  static readonly layerOpen = Layer.succeed(ConsentGate, ConsentGate.of(ConsentGate.open));
}
