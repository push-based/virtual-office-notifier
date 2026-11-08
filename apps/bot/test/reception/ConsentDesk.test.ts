import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  type Cause,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  pipe,
  Queue,
  Ref,
  Stream,
  String as Text,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { TestClock } from "effect/testing";
import { type Admin, ADMINS } from "recording-requests/Admins";
import type { ErasureCase, ErasureDecision, ErasureRefusal } from "recording-requests/Consent";
import {
  ConsentRequests,
  type ErasureHandler,
  type ErasureNotice,
  type NoticeMedium,
  type WithdrawalHandler,
} from "recording-requests/ConsentRequests";
import { CHECK_INTERVAL } from "recording-requests/RecordingRequest";

import { ConsentBook } from "../../src/consent/ConsentBook.ts";
import * as Notice from "../../src/consent/Notice.ts";
import { Eraser } from "../../src/erasure/Eraser.ts";
import type { AdminLine, ErasureAction, ErasureVerdict } from "../../src/office/AdminLine.ts";
import { type Choice, type ConsentLine, ConsentGate } from "../../src/office/ConsentGate.ts";
import { DiscordGateway } from "../../src/office/DiscordGateway.ts";
import {
  NO_VOICE_DETAILS,
  type OfficeEvent,
  type VoiceStateUpdate,
} from "../../src/office/OfficeEvent.ts";
import { ConsentDeskLayer, ERASURE_SWEEP_DELAY } from "../../src/reception/ConsentDesk.ts";
import { SlackAdminLine } from "../../src/reception/SlackAdminLine.ts";
import { pollUntil, withEnv } from "../fakes.ts";

const OFFICE = "office";

const env = { DISCORD_BOT_TOKEN: "discord-token", DISCORD_OFFICE_CHANNEL_ID: OFFICE };

const CHRIS = ADMINS[0]!;

const JULIAN = ADMINS[1]!;

const REQUESTED_AT = DateTime.makeUnsafe("2026-11-08T12:00:00Z");

const DUE_AT = DateTime.makeUnsafe("2026-12-08T12:00:00Z");

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

const caseFor = (userId: string, overrides: Partial<ErasureCase> = {}): ErasureCase => ({
  id: 1,
  userId,
  displayName: "Ada",
  requestedAt: REQUESTED_AT,
  dueAt: DUE_AT,
  decision: null,
  decidedBy: null,
  refusal: null,
  seenBy: [],
  inventory: {
    voiceActivity: 3,
    soundsAndEmoji: 0,
    slackMessages: 0,
    slackReactions: 0,
    clips: 2,
    audioFiles: 2,
    recordingsSpokenIn: 1,
    recordingsStartedStoppedOrPaused: 0,
    recordingRequests: 0,
    recordingEdits: 0,
    actionItemsOwned: 0,
    names: ["Ada"],
    linesMentioningThem: 1,
    recordingTextsMentioningThem: 0,
    slackPostsMentioningThem: 0,
    slackMessagesMentioningThem: 0,
  },
  ...overrides,
});

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

interface Notified {
  readonly admin: string;
  readonly erasureId: number;
}

interface Updated {
  readonly messageId: string;
  readonly text: string;
}

const makeAdminLine = Effect.fnUntraced(function* (medium: NoticeMedium) {
  const notified = yield* Ref.make<ReadonlyArray<Notified>>([]);
  const updated = yield* Ref.make<ReadonlyArray<Updated>>([]);
  const replies = yield* Ref.make<ReadonlyArray<string>>([]);
  const pressed = yield* Queue.unbounded<ErasureAction>();

  const line: AdminLine = {
    medium,
    notify: (admin, erasure) =>
      Ref.update(notified, (all) => [...all, { admin: admin.name, erasureId: erasure.id }]).pipe(
        Effect.as(
          Option.some({
            channel: `${medium}-dm`,
            messageId: `${medium}-${admin.name}-${erasure.id}`,
          }),
        ),
      ),
    update: (notice, text) =>
      Ref.update(updated, (all) => [...all, { messageId: notice.messageId, text }]),
    actions: Stream.fromQueue(pressed),
  };

  const press = (admin: Admin, requestId: number, verdict: ErasureVerdict) =>
    Queue.offer(pressed, {
      requestId,
      admin,
      verdict,
      reply: (text) => Ref.update(replies, (all) => [...all, text]),
    });

  return { line, notified, updated, replies, press };
});

type FakeAdminLine = Effect.Success<ReturnType<typeof makeAdminLine>>;

interface PendingCase {
  readonly erasure: ErasureCase;
  readonly announced: boolean;
  readonly due: boolean;
}

interface Requests {
  readonly queue: Ref.Ref<ReadonlyArray<string>>;
  readonly cases: Ref.Ref<ReadonlyArray<PendingCase>>;
  readonly erasing: Ref.Ref<ReadonlyArray<string>>;
  readonly notices: Ref.Ref<ReadonlyArray<ErasureNotice>>;
  readonly cancelled: Ref.Ref<ReadonlyArray<string>>;
  readonly layer: Layer.Layer<ConsentRequests | Eraser>;
  request(userId: string, overrides?: Partial<ErasureCase>, due?: boolean): Effect.Effect<void>;
}

const makeRequests = Effect.gen(function* () {
  const queue = yield* Ref.make<ReadonlyArray<string>>([]);
  const cases = yield* Ref.make<ReadonlyArray<PendingCase>>([]);
  const erasing = yield* Ref.make<ReadonlyArray<string>>([]);
  const notices = yield* Ref.make<ReadonlyArray<ErasureNotice>>([]);
  const cancelled = yield* Ref.make<ReadonlyArray<string>>([]);

  const step = (text: string) => Ref.update(erasing, (all) => [...all, text]);

  const decide = (
    id: number,
    decision: ErasureDecision,
    by: string,
    refusal: ErasureRefusal | null = null,
  ) =>
    Ref.modify(cases, (all) => {
      const found = Array.findFirst(
        all,
        (pending) => pending.erasure.id === id && pending.erasure.decision === null,
      );

      if (Option.isNone(found)) return [Option.none(), all] as const;

      const erasure: ErasureCase = {
        ...found.value.erasure,
        decision,
        decidedBy: by,
        refusal,
      };

      return [
        Option.some({ id, outcome: null, dueAt: erasure.dueAt }),
        Array.map(all, (pending) =>
          pending.erasure.id === id
            ? { ...pending, erasure, due: pending.due || decision === "now" }
            : pending,
        ),
      ] as const;
    });

  const remove = (id: number) =>
    Ref.update(cases, (all) => Array.filter(all, (pending) => pending.erasure.id !== id));

  const handleErasures = <E, R>(handler: ErasureHandler<E, R>) =>
    Ref.get(cases).pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all,
          (pending) =>
            Effect.gen(function* () {
              if (!pending.announced) {
                yield* handler.announce(pending.erasure);
                yield* Ref.update(cases, (current) =>
                  Array.map(current, (other) =>
                    other.erasure.id === pending.erasure.id ? { ...other, announced: true } : other,
                  ),
                );
              }

              const { decision } = pending.erasure;

              if (decision === "refused" || decision === "cancelled") {
                const made = yield* handler.settle(pending.erasure, decision);

                yield* remove(pending.erasure.id);
                yield* step(`${decision} ${pending.erasure.userId}`);

                return yield* made.afterCommit;
              }

              if (!pending.due && decision !== "now") return;

              yield* handler.prepare(pending.erasure);

              const made = yield* handler.erase(pending.erasure);

              if (Option.isNone(made)) {
                const settledInstead = yield* handler.settle(pending.erasure, "cancelled");

                yield* remove(pending.erasure.id);
                yield* step(`cancelled ${pending.erasure.userId}`);

                return yield* settledInstead.afterCommit;
              }

              yield* remove(pending.erasure.id);
              yield* step(`commit ${pending.erasure.userId}`);
              yield* made.value.afterCommit;
            }),
          { discard: true },
        ),
      ),
    );

  const requests = Layer.succeed(
    ConsentRequests,
    ConsentRequests.of({
      status: () => Effect.die("not used"),
      withdraw: () => Effect.die("not used"),
      find: () => Effect.die("not used"),
      erase: () => Effect.die("not used"),
      findErasure: () => Effect.die("not used"),
      cancelErasure: () => Effect.die("not used"),
      cancelErasuresOf: (userId) =>
        Ref.update(cancelled, (all) => [...all, userId]).pipe(
          Effect.andThen(
            Ref.update(cases, (all) =>
              Array.map(all, (pending) =>
                pending.erasure.userId === userId && pending.erasure.decision === null
                  ? {
                      ...pending,
                      erasure: { ...pending.erasure, decision: "cancelled", decidedBy: userId },
                    }
                  : pending,
              ),
            ),
          ),
        ),
      pendingErasureOf: (userId) =>
        Ref.get(cases).pipe(
          Effect.map((all) =>
            Array.findFirst(all, (pending) => pending.erasure.userId === userId).pipe(
              Option.map(({ erasure }) => ({
                id: erasure.id,
                requestedAt: erasure.requestedAt,
                dueAt: erasure.dueAt,
                decision: erasure.decision,
              })),
            ),
          ),
        ),
      cases: Ref.get(cases).pipe(Effect.map(Array.map((pending) => pending.erasure))),
      expedite: (id, adminId) => decide(id, "now", adminId),
      refuse: (id, adminId, refusal) => decide(id, "refused", adminId, refusal),
      seen: (id) =>
        Ref.get(cases).pipe(
          Effect.map((all) =>
            Array.findFirst(all, (pending) => pending.erasure.id === id).pipe(
              Option.map(({ erasure }) => ({ id, outcome: null, dueAt: erasure.dueAt })),
            ),
          ),
        ),
      recordNotice: (notice) => Ref.update(notices, (all) => [...all, notice]),
      noticesOf: (requestId) =>
        Ref.get(notices).pipe(Effect.map(Array.filter((notice) => notice.requestId === requestId))),
      handleWithdrawals: <E, R>(handler: WithdrawalHandler<E, R>) =>
        Ref.getAndSet(queue, []).pipe(
          Effect.flatMap((userIds) =>
            Effect.forEach(
              userIds,
              (userId, index) =>
                handler.withdraw({ id: index + 1, userId }, "agreed").pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (made) => made.afterCommit,
                    }),
                  ),
                ),
              { discard: true },
            ),
          ),
        ),
      handleErasures,
    }),
  );

  const eraser = Layer.succeed(
    Eraser,
    Eraser.of({
      prepare: (userId) => step(`prepare ${userId}`),
      erase: (userId) =>
        step(`erase ${userId}`).pipe(
          Effect.as({ objectPaths: [`${userId}.ogg`], republishing: 1 }),
        ),
      removeAudio: (paths) => step(`remove ${Array.join(paths, ", ")}`),
      sweep: (userId) => step(`sweep ${userId}`),
    }),
  );

  return {
    queue,
    cases,
    erasing,
    notices,
    cancelled,
    layer: Layer.merge(requests, eraser),
    request: (userId, overrides = {}, due = false) =>
      Ref.update(cases, (all) => [
        ...all,
        { erasure: caseFor(userId, { id: all.length + 1, ...overrides }), announced: false, due },
      ]),
  } satisfies Requests;
});

interface Desk {
  readonly fake: Line;
  readonly requests: Requests;
  readonly discord: FakeAdminLine;
  readonly slack: FakeAdminLine;
  readonly updates: Queue.Queue<VoiceStateUpdate, Cause.Done>;
}

const makeDesk = Effect.gen(function* () {
  const fake = yield* makeLine;
  const requests = yield* makeRequests;
  const discord = yield* makeAdminLine("discord");
  const slack = yield* makeAdminLine("slack");
  const updates = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();

  return { fake, requests, discord, slack, updates } satisfies Desk;
});

const withDesk = <A, E>(
  desk: Desk,
  use: (gateway: DiscordGateway["Service"]) => Effect.Effect<A, E>,
  remember: ReadonlyArray<string> = [],
  present: ReadonlyArray<VoiceStateUpdate> = [],
) => {
  const gateway = Layer.unwrap(
    Effect.map(Effect.service(ConsentGate), (gate) =>
      DiscordGateway.layerTest({
        updates: desk.updates,
        gate,
        line: desk.fake.line,
        admin: desk.discord.line,
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
        Layer.provide(desk.requests.layer),
        Layer.provide(Layer.succeed(SlackAdminLine, desk.slack.line)),
        Layer.provide(SecureRandom.layerWebCrypto),
      ),
    ),
    withEnv(env),
  );
};

const officeEvents = (gateway: DiscordGateway["Service"], count: number) =>
  gateway.officeEvents.pipe(Stream.take(count), Stream.runCollect);

const tagsOf = (events: ReadonlyArray<OfficeEvent>) => Array.map(events, (event) => event._tag);

const agreeFirst = (desk: Desk, gateway: DiscordGateway["Service"]) =>
  Effect.gen(function* () {
    yield* Queue.offer(desk.updates, join());
    yield* desk.fake.press(yield* desk.fake.nextAsk(1), "agree");
    yield* pollUntil(gateway.isAdmitted("u1"), (admitted) => admitted);
  });

const tick = TestClock.adjust(CHECK_INTERVAL);

describe("ConsentDesk", () => {
  it.effect("asks someone who joins, and lets them in once they agree", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          const prompt = yield* desk.fake.nextAsk(1);

          assert.strictEqual(prompt.userId, "u1");
          assert.strictEqual(prompt.text, Notice.askFor("first", "Ada"));
          assert.isFalse(yield* gateway.isAdmitted("u1"));
          assert.deepStrictEqual(yield* gateway.occupants, []);

          yield* desk.fake.press(prompt, "agree");

          const events = yield* officeEvents(gateway, 1);

          assert.deepStrictEqual(tagsOf(events), ["Opened"]);
          assert.isTrue(yield* gateway.isAdmitted("u1"));
          assert.deepStrictEqual(yield* Ref.get(desk.fake.replies), [Notice.AGREED("Ada")]);
          assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), []);
          assert.deepStrictEqual(yield* Ref.get(desk.requests.cancelled), []);
        }),
      );
    }),
  );

  it.effect("shows someone out who declines, and never announces them", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          yield* desk.fake.press(yield* desk.fake.nextAsk(1), "decline");
          yield* pollUntil(Ref.get(desk.fake.shownOut), (out) => out.length === 1);
          yield* Queue.offerAll(desk.updates, [
            leave(),
            join({ userId: "u2", displayName: "Grace" }),
          ]);
          yield* desk.fake.press(yield* desk.fake.nextAsk(2), "agree");

          const [opened] = yield* officeEvents(gateway, 1);

          assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), ["u1"]);
          assert.deepStrictEqual(yield* Ref.get(desk.fake.replies), [
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
        const desk = yield* makeDesk;
        yield* Queue.offer(desk.updates, join());

        yield* withDesk(desk, () =>
          Effect.gen(function* () {
            yield* desk.fake.nextAsk(1);
            yield* TestClock.adjust(Duration.subtract(Notice.ANSWER_TIME, Duration.millis(1)));
            yield* Effect.yieldNow;

            assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), []);

            yield* TestClock.adjust(Duration.millis(1));
            yield* pollUntil(Ref.get(desk.fake.shownOut), (out) => out.length === 1);

            assert.deepStrictEqual(yield* Ref.get(desk.fake.settled), [Notice.TIMED_OUT]);

            yield* Queue.offerAll(desk.updates, [leave(), join()]);

            const again = yield* desk.fake.nextAsk(2);

            assert.strictEqual(again.text, Notice.askFor("again", "Ada"));
          }),
        );
      }),
  );

  it.effect("lets the question lapse when someone leaves before answering", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(desk, () =>
        Effect.gen(function* () {
          const prompt = yield* desk.fake.nextAsk(1);
          yield* Queue.offer(desk.updates, leave());
          yield* pollUntil(Ref.get(desk.fake.settled), (all) => all.length === 1);
          yield* desk.fake.press(prompt, "agree");
          yield* pollUntil(Ref.get(desk.fake.replies), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(desk.fake.settled), [Notice.LEFT]);
          assert.deepStrictEqual(yield* Ref.get(desk.fake.replies), ["(acknowledged)"]);
          assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), []);
        }),
      );
    }),
  );

  it.effect("doesn't ask someone who already agreed", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(
        desk,
        (gateway) =>
          Effect.gen(function* () {
            const events = yield* officeEvents(gateway, 1);

            assert.deepStrictEqual(tagsOf(events), ["Opened"]);
            assert.deepStrictEqual(yield* Ref.get(desk.fake.asked), []);
          }),
        ["u1"],
      );
    }),
  );

  it.effect("withdraws consent from the Console and shows them out", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          yield* agreeFirst(desk, gateway);
          yield* Ref.set(desk.requests.queue, ["u1"]);
          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), ["u1"]);
          assert.deepStrictEqual(yield* Ref.get(desk.fake.told), [Notice.WITHDRAWN_AND_SHOWN_OUT]);
          assert.isFalse(yield* gateway.isAdmitted("u1"));
        }),
      );
    }),
  );

  it.effect("drops an open question when someone withdraws from the Console", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(desk, () =>
        Effect.gen(function* () {
          yield* desk.fake.nextAsk(1);
          yield* Ref.set(desk.requests.queue, ["u1"]);
          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 1);
          yield* TestClock.adjust(Notice.ANSWER_TIME);
          yield* Effect.yieldNow;

          assert.deepStrictEqual(yield* Ref.get(desk.fake.settled), [Notice.QUESTION_WITHDRAWN]);
          assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), ["u1"]);
        }),
      );
    }),
  );

  it.effect(
    "schedules a deletion: withdraws consent, shows them out, tells them the date, and tells both admins everywhere",
    () =>
      Effect.gen(function* () {
        const desk = yield* makeDesk;

        yield* withDesk(desk, (gateway) =>
          Effect.gen(function* () {
            yield* agreeFirst(desk, gateway);
            yield* desk.requests.request("u1");
            yield* tick;
            yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 1);

            assert.deepStrictEqual(yield* Ref.get(desk.fake.told), [
              Notice.SCHEDULED(DUE_AT, true),
            ]);
            assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), ["u1"]);
            assert.isFalse(yield* gateway.isAdmitted("u1"));
            assert.deepStrictEqual(yield* Ref.get(desk.discord.notified), [
              { admin: CHRIS.name, erasureId: 1 },
              { admin: JULIAN.name, erasureId: 1 },
            ]);
            assert.deepStrictEqual(yield* Ref.get(desk.slack.notified), [
              { admin: CHRIS.name, erasureId: 1 },
              { admin: JULIAN.name, erasureId: 1 },
            ]);
            assert.strictEqual((yield* Ref.get(desk.requests.notices)).length, 4);
            assert.deepStrictEqual(yield* Ref.get(desk.requests.erasing), []);

            yield* tick;
            yield* tick;

            assert.deepStrictEqual(yield* Ref.get(desk.requests.erasing), []);
            assert.strictEqual((yield* Ref.get(desk.discord.notified)).length, 2);
          }),
        );
      }),
  );

  it.effect(
    "erases when the request is due, says goodbye, forgets them and closes the admins' messages",
    () =>
      Effect.gen(function* () {
        const desk = yield* makeDesk;

        yield* withDesk(desk, (gateway) =>
          Effect.gen(function* () {
            yield* agreeFirst(desk, gateway);
            yield* desk.requests.request("u1", {}, true);
            yield* tick;
            yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 2);

            assert.deepStrictEqual(yield* Ref.get(desk.requests.erasing), [
              "prepare u1",
              "erase u1",
              "commit u1",
              "remove u1.ogg",
            ]);
            assert.deepStrictEqual(yield* Ref.get(desk.fake.told), [
              Notice.SCHEDULED(DUE_AT, true),
              Notice.ERASED_AND_SHOWN_OUT,
            ]);
            assert.isFalse(yield* gateway.isAdmitted("u1"));

            const updated = yield* Ref.get(desk.discord.updated);

            assert.strictEqual(updated.length, 2);
            assert.isTrue(pipe(updated[0]!.text, Text.includes("Deletion request #1 done")));
            assert.isFalse(pipe(updated[0]!.text, Text.includes("Ada")));
            assert.strictEqual((yield* Ref.get(desk.slack.updated)).length, 2);

            yield* TestClock.adjust(ERASURE_SWEEP_DELAY);
            yield* pollUntil(Ref.get(desk.requests.erasing), (all) => all.includes("sweep u1"));

            yield* Queue.offerAll(desk.updates, [leave(), join()]);

            const again = yield* desk.fake.nextAsk(2);

            assert.strictEqual(again.text, Notice.askFor("first", "Ada"));
          }),
        );
      }),
  );

  it.effect("runs the deletion within a minute when an admin says Delete now", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          yield* agreeFirst(desk, gateway);
          yield* desk.requests.request("u1");
          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 1);
          yield* desk.discord.press(CHRIS, 1, { kind: "now" });
          yield* pollUntil(Ref.get(desk.discord.replies), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(desk.discord.replies), [Notice.NOTED_NOW]);

          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 2);

          assert.deepStrictEqual(yield* Ref.get(desk.requests.erasing), [
            "prepare u1",
            "erase u1",
            "commit u1",
            "remove u1.ogg",
          ]);

          yield* desk.discord.press(CHRIS, 1, { kind: "seen" });
          yield* pollUntil(Ref.get(desk.discord.replies), (all) => all.length === 2);

          assert.deepStrictEqual(yield* Ref.get(desk.discord.replies), [
            Notice.NOTED_NOW,
            Notice.ALREADY_DECIDED,
          ]);
        }),
      );
    }),
  );

  it.effect("passes an admin's refusal on to the person, with the reason", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          yield* agreeFirst(desk, gateway);
          yield* desk.requests.request("u1");
          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 1);
          yield* desk.slack.press(JULIAN, 1, {
            kind: "refuse",
            ground: "legal_claim",
            reason: "It's evidence in the supplier dispute.",
          });
          yield* pollUntil(Ref.get(desk.slack.replies), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(desk.slack.replies), [Notice.NOTED_REFUSED]);

          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 2);

          assert.deepStrictEqual(yield* Ref.get(desk.fake.told), [
            Notice.SCHEDULED(DUE_AT, true),
            Notice.REFUSED("legal_claim", "It's evidence in the supplier dispute."),
          ]);
          assert.deepStrictEqual(yield* Ref.get(desk.requests.erasing), ["refused u1"]);

          const [updated] = yield* Ref.get(desk.slack.updated);

          assert.isTrue(pipe(updated!.text, Text.includes(`${JULIAN.name} refused`)));
          assert.isTrue(pipe(updated!.text, Text.includes("supplier dispute")));
        }),
      );
    }),
  );

  it.effect("says so when the question is about a pending deletion, and cancels it on a yes", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          yield* agreeFirst(desk, gateway);
          yield* desk.requests.request("u1");
          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.shownOut), (all) => all.length === 1);
          yield* Queue.offerAll(desk.updates, [leave(), join()]);

          const prompt = yield* desk.fake.nextAsk(2);

          assert.strictEqual(prompt.text, Notice.askAbout("again", "Ada", true));

          yield* desk.fake.press(prompt, "agree");
          yield* pollUntil(gateway.isAdmitted("u1"), (admitted) => admitted);

          assert.deepStrictEqual(yield* Ref.get(desk.requests.cancelled), ["u1"]);

          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 2);

          assert.deepStrictEqual(yield* Ref.get(desk.fake.told), [
            Notice.SCHEDULED(DUE_AT, true),
            Notice.CANCELLED,
          ]);
          assert.deepStrictEqual(yield* Ref.get(desk.requests.erasing), ["cancelled u1"]);
          assert.isTrue(yield* gateway.isAdmitted("u1"));
        }),
      );
    }),
  );

  it.effect(
    "never erases someone the bot knows has agreed again, even when the request is due",
    () =>
      Effect.gen(function* () {
        const desk = yield* makeDesk;

        yield* withDesk(desk, (gateway) =>
          Effect.gen(function* () {
            yield* agreeFirst(desk, gateway);
            yield* desk.requests.request("u1");
            yield* tick;
            yield* pollUntil(Ref.get(desk.fake.shownOut), (all) => all.length === 1);
            yield* Queue.offerAll(desk.updates, [leave(), join()]);
            yield* desk.fake.press(yield* desk.fake.nextAsk(2), "agree");
            yield* pollUntil(gateway.isAdmitted("u1"), (admitted) => admitted);
            yield* Ref.update(desk.requests.cases, (all) =>
              Array.map(all, (pending) => ({
                ...pending,
                due: true,
                erasure: { ...pending.erasure, decision: null, decidedBy: null },
              })),
            );
            yield* tick;
            yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 2);

            assert.deepStrictEqual(yield* Ref.get(desk.requests.erasing), [
              "prepare u1",
              "cancelled u1",
            ]);
            assert.deepStrictEqual(yield* Ref.get(desk.fake.told), [
              Notice.SCHEDULED(DUE_AT, true),
              Notice.CANCELLED,
            ]);
          }),
        );
      }),
  );

  it.effect("drops an open question when someone asks for their data to be deleted", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(desk, () =>
        Effect.gen(function* () {
          yield* desk.fake.nextAsk(1);
          yield* desk.requests.request("u1");
          yield* tick;
          yield* pollUntil(Ref.get(desk.fake.told), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(desk.fake.settled), [Notice.QUESTION_ERASED]);
          assert.deepStrictEqual(yield* Ref.get(desk.fake.told), [Notice.SCHEDULED(DUE_AT, true)]);
        }),
      );
    }),
  );

  it.effect("acknowledges a second press without changing the answer", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          const prompt = yield* desk.fake.nextAsk(1);
          yield* desk.fake.press(prompt, "agree");
          yield* desk.fake.press(prompt, "decline");
          yield* pollUntil(Ref.get(desk.fake.replies), (all) => all.length === 2);

          assert.sameMembers(
            [...(yield* Ref.get(desk.fake.replies))],
            [Notice.AGREED("Ada"), "(acknowledged)"],
          );
          assert.isTrue(yield* gateway.isAdmitted("u1"));
          assert.deepStrictEqual(yield* Ref.get(desk.fake.shownOut), []);
        }),
      );
    }),
  );

  it.effect("lets someone who was already in at startup in quietly once they agree", () =>
    Effect.gen(function* () {
      const desk = yield* makeDesk;

      yield* withDesk(
        desk,
        (gateway) =>
          Effect.gen(function* () {
            yield* desk.fake.press(yield* desk.fake.nextAsk(1), "agree");
            yield* pollUntil(gateway.isAdmitted("u1"), (admitted) => admitted);
            yield* Queue.offer(desk.updates, leave());

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
      const desk = yield* makeDesk;
      yield* Queue.offer(desk.updates, join());

      yield* withDesk(desk, (gateway) =>
        Effect.gen(function* () {
          yield* desk.fake.press({ userId: "u1", promptId: "stale", text: "" }, "agree");
          yield* pollUntil(Ref.get(desk.fake.replies), (all) => all.length === 1);

          assert.deepStrictEqual(yield* Ref.get(desk.fake.replies), [Notice.EXPIRED]);
          assert.isFalse(yield* gateway.isAdmitted("u1"));
        }),
      );
    }),
  );
});
