import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  type Cause,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { TestClock } from "effect/testing";
import { ConsentRequests, type WithdrawalHandler } from "recording-requests/ConsentRequests";
import { CHECK_INTERVAL } from "recording-requests/RecordingRequest";

import { ConsentBook } from "../../src/consent/ConsentBook.ts";
import { type Choice, type ConsentLine, ConsentGate } from "../../src/office/ConsentGate.ts";
import * as Notice from "../../src/consent/Notice.ts";
import { DiscordGateway } from "../../src/office/DiscordGateway.ts";
import {
  NO_VOICE_DETAILS,
  type OfficeEvent,
  type VoiceStateUpdate,
} from "../../src/office/OfficeEvent.ts";
import { ConsentDeskLayer } from "../../src/reception/ConsentDesk.ts";
import { pollUntil, withEnv } from "../fakes.ts";

const OFFICE = "office";

const env = { DISCORD_BOT_TOKEN: "discord-token", DISCORD_OFFICE_CHANNEL_ID: OFFICE };

const join = (overrides: Partial<VoiceStateUpdate> = {}): VoiceStateUpdate => ({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  guildId: "guild",
  oldChannelId: null,
  newChannelId: OFFICE,
  isBot: false,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  ...overrides,
});

const leave = (overrides: Partial<VoiceStateUpdate> = {}) =>
  join({ oldChannelId: OFFICE, newChannelId: null, ...overrides });

interface Asked {
  readonly userId: string;
  readonly promptId: string;
  readonly text: string;
}

const makeLine = Effect.gen(function* () {
  const asked = yield* Ref.make<ReadonlyArray<Asked>>([]);
  const settled = yield* Ref.make<ReadonlyArray<string>>([]);
  const replies = yield* Ref.make<ReadonlyArray<string>>([]);
  const told = yield* Ref.make<ReadonlyArray<string>>([]);
  const shownOut = yield* Ref.make<ReadonlyArray<string>>([]);

  const pressed = yield* Queue.unbounded<{
    promptId: string;
    userId: string;
    choice: Choice;
  }>();

  const push = <A>(ref: Ref.Ref<ReadonlyArray<A>>, value: A) =>
    Ref.update(ref, (all) => [...all, value]);

  const line: ConsentLine = {
    ask: (userId, promptId, text) =>
      push(asked, { userId, promptId, text }).pipe(
        Effect.as(
          Option.some({
            via: "direct_message" as const,
            settle: (settledText: string) => push(settled, settledText),
          }),
        ),
      ),
    tell: (_, text) => push(told, text),
    showOut: (userId) => push(shownOut, userId).pipe(Effect.as(true)),
    answers: Stream.fromQueue(pressed).pipe(
      Stream.map((press) => ({
        ...press,
        reply: (text: string) => push(replies, text),
        acknowledge: push(replies, "(acknowledged)"),
      })),
    ),
  };

  const press = (prompt: Asked, choice: Choice, userId = prompt.userId) =>
    Queue.offer(pressed, { promptId: prompt.promptId, userId, choice });

  const nextAsk = (count: number) =>
    pollUntil(Ref.get(asked), (all) => all.length >= count).pipe(
      Effect.map((all) => all[count - 1]!),
    );

  return { line, asked, settled, replies, told, shownOut, press, nextAsk };
});

type Line = Effect.Success<typeof makeLine>;

interface Withdrawals {
  readonly queue: Ref.Ref<ReadonlyArray<string>>;
  readonly layer: Layer.Layer<ConsentRequests>;
}

const makeWithdrawals = Effect.gen(function* () {
  const queue = yield* Ref.make<ReadonlyArray<string>>([]);

  const layer = Layer.succeed(
    ConsentRequests,
    ConsentRequests.of({
      status: () => Effect.die("not used"),
      withdraw: () => Effect.die("not used"),
      find: () => Effect.die("not used"),
      handlePending: <E, R>(handler: WithdrawalHandler<E, R>) =>
        Ref.getAndSet(queue, []).pipe(
          Effect.flatMap((userIds) =>
            Effect.forEach(
              userIds,
              (userId, index) =>
                handler
                  .withdraw({ id: index + 1, userId })
                  .pipe(Effect.flatMap((made) => made.afterCommit)),
              { discard: true },
            ),
          ),
        ),
    }),
  );

  return { queue, layer } satisfies Withdrawals;
});

const withDesk = <A, E>(
  updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>,
  fake: Line,
  withdrawals: Withdrawals,
  use: (gateway: DiscordGateway["Service"]) => Effect.Effect<A, E>,
  remember: ReadonlyArray<string> = [],
  present: ReadonlyArray<VoiceStateUpdate> = [],
) => {
  const gateway = Layer.unwrap(
    Effect.map(Effect.service(ConsentGate), (gate) =>
      DiscordGateway.layerTest({
        updates,
        gate,
        line: fake.line,
        present,
        occupants: new Set(Array.map(present, (update) => update.userId)),
      }),
    ),
  );

  const preloaded = Layer.effectDiscard(
    Effect.flatMap(Effect.service(ConsentBook), (book) =>
      Effect.forEach(
        remember,
        (userId) => book.remember({ userId, at: DateTime.makeUnsafe(0), kind: "agreed" }),
        { discard: true },
      ),
    ),
  );

  return Effect.flatMap(Effect.service(DiscordGateway), use).pipe(
    Effect.provide(
      ConsentDeskLayer.pipe(
        Layer.provideMerge(gateway),
        Layer.provideMerge(ConsentGate.layer),
        Layer.provideMerge(preloaded.pipe(Layer.provideMerge(ConsentBook.layerMemory))),
        Layer.provide(withdrawals.layer),
        Layer.provide(SecureRandom.layerWebCrypto),
      ),
    ),
    withEnv(env),
  );
};

const officeEvents = (gateway: DiscordGateway["Service"], count: number) =>
  gateway.officeEvents.pipe(Stream.take(count), Stream.runCollect);

const tagsOf = (events: ReadonlyArray<OfficeEvent>) => Array.map(events, (event) => event._tag);

describe("ConsentDesk", () => {
  it.effect("asks someone who joins, and lets them in once they agree", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(updates, fake, withdrawals, (gateway) =>
        Effect.gen(function* () {
          const prompt = yield* fake.nextAsk(1);

          assert.strictEqual(prompt.userId, "u1");
          assert.strictEqual(prompt.text, Notice.askFor("first", "Ada"));
          assert.isFalse(yield* gateway.isAdmitted("u1"));
          assert.deepStrictEqual(yield* gateway.occupants, []);

          yield* fake.press(prompt, "agree");

          const events = yield* officeEvents(gateway, 1);

          assert.deepStrictEqual(tagsOf(events), ["Opened"]);
          assert.isTrue(yield* gateway.isAdmitted("u1"));
          assert.deepStrictEqual(yield* Ref.get(fake.replies), [Notice.AGREED("Ada")]);
          assert.deepStrictEqual(yield* Ref.get(fake.shownOut), []);
        }),
      );
    }),
  );

  it.effect("shows someone out who declines, and never announces them", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(updates, fake, withdrawals, (gateway) =>
        Effect.gen(function* () {
          yield* fake.press(yield* fake.nextAsk(1), "decline");
          yield* pollUntil(Ref.get(fake.shownOut), (out) => out.length === 1);
          yield* Queue.offerAll(updates, [leave(), join({ userId: "u2", displayName: "Grace" })]);
          yield* fake.press(yield* fake.nextAsk(2), "agree");

          const [opened] = yield* officeEvents(gateway, 1);

          assert.deepStrictEqual(yield* Ref.get(fake.shownOut), ["u1"]);
          assert.deepStrictEqual(yield* Ref.get(fake.replies), [
            Notice.DECLINED,
            Notice.AGREED("Grace"),
          ]);
          assert.strictEqual(opened?._tag === "Opened" ? opened.userId : null, "u2");
        }),
      );
    }),
  );

  it.effect(
    "shows someone out after a minute without an answer, and asks differently next time",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeLine;
        const withdrawals = yield* makeWithdrawals;
        const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
        yield* Queue.offer(updates, join());

        yield* withDesk(updates, fake, withdrawals, () =>
          Effect.gen(function* () {
            yield* fake.nextAsk(1);
            yield* TestClock.adjust(Duration.subtract(Notice.ANSWER_TIME, Duration.millis(1)));
            yield* Effect.yieldNow;

            assert.deepStrictEqual(yield* Ref.get(fake.shownOut), []);

            yield* TestClock.adjust(Duration.millis(1));
            yield* pollUntil(Ref.get(fake.shownOut), (out) => out.length === 1);

            assert.deepStrictEqual(yield* Ref.get(fake.settled), [Notice.TIMED_OUT]);

            yield* Queue.offerAll(updates, [leave(), join()]);

            const again = yield* fake.nextAsk(2);

            assert.strictEqual(again.text, Notice.askFor("again", "Ada"));
          }),
        );
      }),
  );

  it.effect("lets the question lapse when someone leaves before answering", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(updates, fake, withdrawals, () =>
        Effect.gen(function* () {
          const prompt = yield* fake.nextAsk(1);
          yield* Queue.offer(updates, leave());
          yield* pollUntil(Ref.get(fake.settled), (all) => all.length === 1);
          yield* fake.press(prompt, "agree");
          yield* pollUntil(Ref.get(fake.replies), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(fake.settled), [Notice.LEFT]);
          assert.deepStrictEqual(yield* Ref.get(fake.replies), ["(acknowledged)"]);
          assert.deepStrictEqual(yield* Ref.get(fake.shownOut), []);
        }),
      );
    }),
  );

  it.effect("doesn't ask someone who already agreed", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(
        updates,
        fake,
        withdrawals,
        (gateway) =>
          Effect.gen(function* () {
            const events = yield* officeEvents(gateway, 1);

            assert.deepStrictEqual(tagsOf(events), ["Opened"]);
            assert.deepStrictEqual(yield* Ref.get(fake.asked), []);
          }),
        ["u1"],
      );
    }),
  );

  it.effect("withdraws consent from the Console and shows them out", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(updates, fake, withdrawals, (gateway) =>
        Effect.gen(function* () {
          yield* fake.press(yield* fake.nextAsk(1), "agree");
          yield* pollUntil(gateway.isAdmitted("u1"), (admitted) => admitted);
          yield* Ref.set(withdrawals.queue, ["u1"]);
          yield* TestClock.adjust(CHECK_INTERVAL);
          yield* pollUntil(Ref.get(fake.told), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(fake.shownOut), ["u1"]);
          assert.deepStrictEqual(yield* Ref.get(fake.told), [Notice.WITHDRAWN_AND_SHOWN_OUT]);
          assert.isFalse(yield* gateway.isAdmitted("u1"));
        }),
      );
    }),
  );

  it.effect("drops an open question when someone withdraws from the Console", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(updates, fake, withdrawals, () =>
        Effect.gen(function* () {
          yield* fake.nextAsk(1);
          yield* Ref.set(withdrawals.queue, ["u1"]);
          yield* TestClock.adjust(CHECK_INTERVAL);
          yield* pollUntil(Ref.get(fake.told), (all) => all.length === 1);
          yield* TestClock.adjust(Notice.ANSWER_TIME);
          yield* Effect.yieldNow;

          assert.deepStrictEqual(yield* Ref.get(fake.settled), [Notice.QUESTION_WITHDRAWN]);
          assert.deepStrictEqual(yield* Ref.get(fake.shownOut), ["u1"]);
        }),
      );
    }),
  );

  it.effect("acknowledges a second press without changing the answer", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(updates, fake, withdrawals, (gateway) =>
        Effect.gen(function* () {
          const prompt = yield* fake.nextAsk(1);
          yield* fake.press(prompt, "agree");
          yield* fake.press(prompt, "decline");
          yield* pollUntil(Ref.get(fake.replies), (all) => all.length === 2);

          assert.sameMembers(
            [...(yield* Ref.get(fake.replies))],
            [Notice.AGREED("Ada"), "(acknowledged)"],
          );
          assert.isTrue(yield* gateway.isAdmitted("u1"));
          assert.deepStrictEqual(yield* Ref.get(fake.shownOut), []);
        }),
      );
    }),
  );

  it.effect("lets someone who was already in at startup in quietly once they agree", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();

      yield* withDesk(
        updates,
        fake,
        withdrawals,
        (gateway) =>
          Effect.gen(function* () {
            yield* fake.press(yield* fake.nextAsk(1), "agree");
            yield* pollUntil(gateway.isAdmitted("u1"), (admitted) => admitted);
            yield* Queue.offer(updates, leave());

            const [event] = yield* officeEvents(gateway, 1);

            const observed = yield* gateway.voiceObservations.pipe(
              Stream.take(2),
              Stream.runCollect,
            );

            assert.strictEqual(event?._tag, "Emptied");
            assert.deepStrictEqual(
              Array.map(observed, (observation) => observation.source),
              ["startup", "update"],
            );
          }),
        [],
        [join({ alreadyThere: true })],
      );
    }),
  );

  it.effect("answers a press on a question that has lapsed", () =>
    Effect.gen(function* () {
      const fake = yield* makeLine;
      const withdrawals = yield* makeWithdrawals;
      const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      yield* Queue.offer(updates, join());

      yield* withDesk(updates, fake, withdrawals, (gateway) =>
        Effect.gen(function* () {
          yield* fake.press({ userId: "u1", promptId: "stale", text: "" }, "agree");
          yield* pollUntil(Ref.get(fake.replies), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(fake.replies), [Notice.EXPIRED]);
          assert.isFalse(yield* gateway.isAdmitted("u1"));
        }),
      );
    }),
  );
});
