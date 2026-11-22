import { describe, expect, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Fiber, Layer, Option, Predicate, Ref, Schema } from "effect";
import { HttpApiError } from "effect/http-api";
import { TestClock } from "effect/testing";
import type { ConsentStatus } from "office-domain/Consent";
import { AsyncData, Story } from "foldkit";

import { RetryTiming, SessionToken } from "../api/api.ts";
import { fakeApi } from "../dev/fake-worker.ts";
import { type FakeRoutes, fakeServer } from "../fakes.ts";
import {
  ConsentData,
  init,
  Message,
  NOT_SCHEDULED,
  NOT_SURE,
  NOT_WITHDRAWN,
  open,
  RequestErasure,
  update,
  WithdrawConsent,
  WITHDRAWN,
} from "./consent.ts";
import * as ErasureAdmin from "./erasure-admin.ts";

const unavailable = Schema.encodeEffect(HttpApiError.ServiceUnavailable)(
  HttpApiError.ServiceUnavailable.make({}),
).pipe(Effect.map((body) => ({ status: 503, body })));

const answering = (routes: FakeRoutes) =>
  Layer.mergeAll(
    fakeApi(fakeServer(routes).layer),
    Layer.succeed(RetryTiming, { retries: 0, delay: Duration.zero, timeout: Duration.seconds(5) }),
  );

const signedIn = Effect.gen(function* () {
  yield* Ref.set(yield* SessionToken, Option.some("session-1"));
});

const noticeOf = <R>(command: { readonly effect: Effect.Effect<Message, never, R> }) =>
  signedIn.pipe(
    Effect.andThen(command.effect),
    Effect.map((message) =>
      Predicate.isTagged(message, "CompletedAct") ? Option.some(message.notice) : Option.none(),
    ),
  );

const agreed: ConsentStatus = {
  standing: "agreed",
  since: DateTime.makeUnsafe("2026-11-06T08:42:00.000Z"),
  pendingWithdrawal: null,
  pendingErasure: null,
  refusedErasure: null,
  admin: true,
};

describe("when withdrawing or asking for deletion goes wrong", () => {
  it.effect("says nothing changed when the Worker refuses the withdrawal", () =>
    Effect.gen(function* () {
      const refusal = yield* unavailable;

      const notice = yield* noticeOf(WithdrawConsent()).pipe(
        Effect.provide(answering(() => refusal)),
      );

      expect(notice).toEqual(Option.some(NOT_WITHDRAWN));
    }),
  );

  it.effect("says it can't tell when the withdrawal got no answer at all", () =>
    noticeOf(WithdrawConsent()).pipe(
      Effect.map((notice) => expect(notice).toEqual(Option.some(NOT_SURE))),
      Effect.provide(answering(() => "unanswered")),
    ),
  );

  it.effect("waits for the bot and says when the withdrawal went through", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(noticeOf(WithdrawConsent()));

      yield* TestClock.adjust(Duration.seconds(2));

      expect(yield* Fiber.join(fiber)).toEqual(Option.some(WITHDRAWN));
    }).pipe(
      Effect.provide(
        answering(({ method }) =>
          method === "POST"
            ? { status: 202, body: { id: 3, outcome: null } }
            : { body: { id: 3, outcome: "withdrawn" } },
        ),
      ),
    ),
  );

  it.effect("tells a refused deletion request apart from one that got no answer", () =>
    Effect.gen(function* () {
      const refusal = yield* unavailable;

      const refused = yield* noticeOf(RequestErasure()).pipe(
        Effect.provide(answering(() => refusal)),
      );

      const unanswered = yield* noticeOf(RequestErasure()).pipe(
        Effect.provide(answering(() => "unanswered")),
      );

      expect(refused).toEqual(Option.some(NOT_SCHEDULED));
      expect(unanswered).toEqual(Option.some(NOT_SURE));
    }),
  );
});

describe("opening the privacy tab again", () => {
  it("keeps an action that's still running, and what an admin was typing", () => {
    const working = {
      ...init(),
      status: ConsentData.Success({ data: agreed }),
      busy: Option.some("withdraw" as const),
      admin: {
        ...ErasureAdmin.init(),
        cases: ErasureAdmin.CasesData.Success({ data: [] }),
        reason: "An open dispute.",
      },
    };

    const reopened = open(working);

    expect(reopened.model.busy).toEqual(Option.some("withdraw"));
    expect(reopened.model.admin.reason).toBe("An open dispute.");
    expect(AsyncData.isRefreshing(reopened.model.status)).toBe(true);

    Story.story(
      update,
      Story.given(reopened.model),
      Story.message(Message.SucceededFetchConsent({ status: agreed })),
      Story.model((model) => {
        expect(model.admin.reason).toBe("An open dispute.");
        expect(AsyncData.isRefreshing(model.admin.cases)).toBe(true);
      }),
      Story.Command.resolve(
        ErasureAdmin.FetchCases,
        ErasureAdmin.Message.SucceededFetchCases({ cases: [] }),
      ),
    );
  });
});

describe("refusing a deletion request", () => {
  const confirmingRefusal = (id: number) =>
    ErasureAdmin.Message.ClickedConfirm({ confirming: { id, action: "refuse" } });

  it("starts each refusal blank, so a reason never carries over to someone else", () => {
    Story.story(
      ErasureAdmin.update,
      Story.given(ErasureAdmin.init()),
      Story.message(confirmingRefusal(12)),
      Story.message(ErasureAdmin.Message.UpdatedGround({ value: "legal_claim" })),
      Story.message(ErasureAdmin.Message.UpdatedReason({ value: "Ada's dispute" })),
      Story.message(ErasureAdmin.Message.ClickedBack()),
      Story.message(confirmingRefusal(13)),
      Story.model((model) => {
        expect(model.reason).toBe("");
        expect(model.ground).toBe("legal_obligation");
      }),
    );
  });

  it("keeps the reason when the request couldn't be sent, so it can be sent again", () => {
    Story.story(
      ErasureAdmin.update,
      Story.given(ErasureAdmin.init()),
      Story.message(confirmingRefusal(12)),
      Story.message(ErasureAdmin.Message.UpdatedReason({ value: "An open dispute." })),
      Story.message(ErasureAdmin.Message.SubmittedRefusal({ id: 12 })),
      Story.Command.resolve(
        ErasureAdmin.DecideErasure,
        ErasureAdmin.Message.FailedDecideErasure({ why: "unreachable" }),
      ),
      Story.model((model) => {
        expect(model.reason).toBe("An open dispute.");
        expect(model.confirming).toEqual(Option.some({ id: 12, action: "refuse" }));
        expect(model.notice).toEqual(Option.some(ErasureAdmin.UNREACHABLE));
      }),
      Story.Command.resolve(
        ErasureAdmin.FetchCases,
        ErasureAdmin.Message.SucceededFetchCases({ cases: [] }),
      ),
    );
  });
});
