import { DateTime, identity, Option } from "effect";
import { Scene, Story } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it } from "vite-plus/test";

import type { ConsentStatus, ErasureCase } from "office-domain/Consent";
import {
  CANCELLED,
  CancelErasure,
  ConsentData,
  FetchConsent,
  init,
  Message,
  type Model,
  NO_ANSWER,
  OpenAuthorities,
  RequestErasure,
  SCHEDULED,
  update,
  view,
  WithdrawConsent,
  WITHDRAWN,
} from "./consent.ts";
import * as ErasureAdmin from "./erasure-admin.ts";

const agreed: ConsentStatus = {
  standing: "agreed",
  since: DateTime.makeUnsafe("2026-11-06T08:42:00.000Z"),
  pendingWithdrawal: null,
  pendingErasure: null,
  refusedErasure: null,
  admin: false,
};

const erasure: ErasureCase = {
  id: 12,
  userId: "u-ada",
  displayName: "Ada",
  requestedAt: DateTime.makeUnsafe("2026-11-08T12:00:00.000Z"),
  dueAt: DateTime.makeUnsafe("2026-12-08T12:00:00.000Z"),
  decision: null,
  decidedBy: null,
  decidedByName: null,
  refusal: null,
  seenBy: [],
  seenByNames: [],
  inventory: {
    voiceActivity: 41,
    soundsAndEmoji: 3,
    slackMessages: 2,
    slackReactions: 5,
    clips: 17,
    audioFiles: 17,
    recordingsSpokenIn: 2,
    recordingsStartedStoppedOrPaused: 1,
    recordingRequests: 1,
    recordingEdits: 0,
    actionItemsOwned: 1,
    names: ["Ada", "Ada Lovelace"],
    linesMentioningThem: 4,
    recordingTextsMentioningThem: 1,
    slackPostsMentioningThem: 2,
    slackMessagesMentioningThem: 0,
  },
};

const showing = (status: ConsentStatus): Model => ({
  ...init(),
  status: ConsentData.Success({ data: status }),
});

const scene = {
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    h.submodel({ slotId: "consent", model, view, toParentMessage: identity }),
};

describe("the privacy panel", () => {
  it("shows when you agreed and what the office records", () => {
    Scene.scene(
      scene,
      Scene.given(showing(agreed)),
      Scene.expect(Scene.role("heading", { name: "You agreed to being recorded" })).toExist(),
      Scene.expect(Scene.text("You agreed on Fri 6 Nov, 10:42, UTC+2.")).toExist(),
      Scene.expect(
        Scene.role("region", { name: "While you're in the office, it records" }),
      ).toContainText("every soundboard sound and emoji you send"),
    );
  });

  it("asks you to confirm, then withdraws, says so and checks again", () => {
    Scene.scene(
      scene,
      Scene.given(showing(agreed)),
      Scene.click(Scene.role("button", { name: "Withdraw consent" })),
      Scene.click(Scene.role("button", { name: "Withdraw my consent" })),
      Scene.Command.expectExact(WithdrawConsent()),
      Scene.expect(Scene.role("button", { name: "Withdrawing…" })).toBeDisabled(),
      Scene.Command.resolve(WithdrawConsent, Message.CompletedAct({ notice: WITHDRAWN })),
      Scene.expect(Scene.text(WITHDRAWN.text)).toExist(),
      Scene.Command.expectExact(FetchConsent()),
      Scene.Command.resolve(
        FetchConsent,
        Message.SucceededFetchConsent({ status: { ...agreed, standing: "withdrawn" } }),
      ),
      Scene.expect(Scene.role("heading", { name: "You withdrew your consent" })).toExist(),
    );
  });

  it("lets you keep your consent", () => {
    Scene.scene(
      scene,
      Scene.given(showing(agreed)),
      Scene.click(Scene.role("button", { name: "Withdraw consent" })),
      Scene.click(Scene.role("button", { name: "Keep it" })),
      Scene.expect(Scene.role("button", { name: "Withdraw consent" })).toExist(),
    );
  });

  it("says the bot didn't answer in time", () => {
    Story.story(
      update,
      Story.given({ ...showing(agreed), busy: Option.some("withdraw" as const) }),
      Story.message(Message.CompletedAct({ notice: NO_ANSWER })),
      Story.model((model) => {
        expect(model.notice).toEqual(Option.some(NO_ANSWER));
        expect(model.busy).toEqual(Option.none());
      }),
      Story.Command.resolve(FetchConsent, Message.SucceededFetchConsent({ status: agreed })),
    );
  });

  it("asks you to confirm, then asks for the deletion", () => {
    Scene.scene(
      scene,
      Scene.given(showing(agreed)),
      Scene.click(Scene.role("button", { name: "Delete my data" })),
      Scene.expect(Scene.text(/Once it runs, this can't be undone/)).toExist(),
      Scene.click(Scene.role("button", { name: "Delete everything" })),
      Scene.Command.expectExact(RequestErasure()),
      Scene.Command.resolve(RequestErasure, Message.CompletedAct({ notice: SCHEDULED })),
      Scene.Command.resolve(FetchConsent, Message.SucceededFetchConsent({ status: agreed })),
      Scene.expect(Scene.text(SCHEDULED.text)).toExist(),
    );
  });

  it("lets you cancel the deletion until it runs", () => {
    const pending: ConsentStatus = {
      ...agreed,
      standing: "withdrawn",
      pendingErasure: {
        id: 12,
        requestedAt: DateTime.makeUnsafe("2026-11-08T12:00:00.000Z"),
        dueAt: DateTime.makeUnsafe("2026-12-08T12:00:00.000Z"),
        decision: null,
      },
    };

    Scene.scene(
      scene,
      Scene.given(showing(pending)),
      Scene.expect(
        Scene.role("heading", { name: "Your data will be deleted on Tue 8 Dec, 14:00, UTC+2" }),
      ).toExist(),
      Scene.click(Scene.role("button", { name: "Cancel the deletion" })),
      Scene.click(Scene.role("button", { name: "Cancel the deletion" })),
      Scene.Command.expectExact(CancelErasure({ id: 12 })),
      Scene.Command.resolve(CancelErasure, Message.CompletedAct({ notice: CANCELLED })),
      Scene.Command.resolve(FetchConsent, Message.SucceededFetchConsent({ status: agreed })),
      Scene.expect(Scene.text(CANCELLED.text)).toExist(),
    );
  });

  it("shows why a deletion was refused, with the way to complain", () => {
    Scene.scene(
      scene,
      Scene.given(
        showing({
          ...agreed,
          standing: "withdrawn",
          refusedErasure: {
            id: 12,
            refusedAt: DateTime.makeUnsafe("2026-11-09T09:00:00.000Z"),
            ground: "legal_claim",
            reason: "There's an open dispute.",
          },
        }),
      ),
      Scene.expect(Scene.text("There's an open dispute.")).toExist(),
      Scene.click(Scene.role("button", { name: "Data protection authorities" })),
      Scene.Command.expectExact(OpenAuthorities()),
      Scene.Command.resolve(OpenAuthorities, Message.CompletedOpenAuthorities()),
    );
  });

  it("asks for the deletion requests to review when you're an admin, and shows them", () => {
    Story.story(
      update,
      Story.given({ ...init(), status: ConsentData.Loading() }),
      Story.message(Message.SucceededFetchConsent({ status: { ...agreed, admin: true } })),
      Story.Command.expectExact(ErasureAdmin.FetchCases()),
      Story.Command.resolve(
        ErasureAdmin.FetchCases,
        ErasureAdmin.Message.SucceededFetchCases({ cases: [erasure] }),
      ),
    );
    Scene.scene(
      scene,
      Scene.given({
        ...showing({ ...agreed, admin: true }),
        admin: {
          ...ErasureAdmin.init(),
          cases: ErasureAdmin.CasesData.Success({ data: [erasure] }),
        },
      }),
      Scene.expect(Scene.role("article", { name: /Ada/ })).toExist(),
    );
  });
});

const adminScene = {
  update: ErasureAdmin.update,
  view: (model: ErasureAdmin.Model, h: HtmlBuilder<ErasureAdmin.Message>) =>
    h.submodel({
      slotId: "erasure-admin",
      model,
      view: ErasureAdmin.view,
      toParentMessage: identity,
    }),
};

const reviewing = (cases: ReadonlyArray<ErasureCase>): ErasureAdmin.Model => ({
  ...ErasureAdmin.init(),
  cases: ErasureAdmin.CasesData.Success({ data: cases }),
});

describe("the deletion requests", () => {
  it("lists each request with exactly what will be deleted, or says when nobody asked", () => {
    Scene.scene(
      adminScene,
      Scene.given(reviewing([erasure])),
      Scene.expect(Scene.role("heading", { name: /Discord ID u-ada · request #12/ })).toExist(),
      Scene.expect(Scene.text(/Nobody has looked at it yet\./)).toExist(),
      Scene.expect(Scene.text(/41 voice activity rows/)).toExist(),
    );
    Scene.scene(
      adminScene,
      Scene.given(reviewing([])),
      Scene.expect(Scene.text("Nobody has asked for their data to be deleted.")).toExist(),
    );
  });

  it("asks before deleting now, then does and checks again", () => {
    Scene.scene(
      adminScene,
      Scene.given(reviewing([erasure])),
      Scene.click(Scene.role("button", { name: "Delete now" })),
      Scene.expect(Scene.text(/can't be undone/)).toExist(),
      Scene.click(Scene.role("button", { name: "Delete now" })),
      Scene.Command.expectExact(ErasureAdmin.DecideErasure({ id: 12, decision: { kind: "now" } })),
      Scene.Command.resolve(
        ErasureAdmin.DecideErasure,
        ErasureAdmin.Message.SucceededDecideErasure({ decision: { kind: "now" } }),
      ),
      Scene.expect(Scene.text(ErasureAdmin.NOTED_NOW.text)).toExist(),
      Scene.Command.resolve(
        ErasureAdmin.FetchCases,
        ErasureAdmin.Message.SucceededFetchCases({ cases: [{ ...erasure, decision: "now" }] }),
      ),
    );
  });

  it("notes that an admin has seen it", () => {
    Story.story(
      ErasureAdmin.update,
      Story.given(reviewing([erasure])),
      Story.message(ErasureAdmin.Message.ClickedLetItRun({ id: 12 })),
      Story.Command.expectExact(ErasureAdmin.DecideErasure({ id: 12, decision: { kind: "seen" } })),
      Story.Command.resolve(
        ErasureAdmin.DecideErasure,
        ErasureAdmin.Message.SucceededDecideErasure({ decision: { kind: "seen" } }),
      ),
      Story.model((model) => expect(model.notice).toEqual(Option.some(ErasureAdmin.NOTED_SEEN))),
      Story.Command.resolve(
        ErasureAdmin.FetchCases,
        ErasureAdmin.Message.SucceededFetchCases({ cases: [erasure] }),
      ),
    );
  });

  it("refuses only with a ground and a reason", () => {
    Scene.scene(
      adminScene,
      Scene.given(reviewing([erasure])),
      Scene.click(Scene.role("button", { name: "Refuse…" })),
      Scene.submit(Scene.role("form")),
      Scene.Command.expectNone(),
      Scene.change(Scene.label("Ground"), "legal_claim"),
      Scene.type(
        Scene.label("Why it has to be kept. This goes to them, word for word."),
        "  An open dispute. ",
      ),
      Scene.submit(Scene.role("form")),
      Scene.Command.expectExact(
        ErasureAdmin.DecideErasure({
          id: 12,
          decision: { kind: "refuse", ground: "legal_claim", reason: "An open dispute." },
        }),
      ),
      Scene.Command.resolve(
        ErasureAdmin.DecideErasure,
        ErasureAdmin.Message.FailedDecideErasure({ why: "already_decided" }),
      ),
      Scene.expect(Scene.text(ErasureAdmin.ALREADY_DECIDED.text)).toExist(),
      Scene.Command.resolve(
        ErasureAdmin.FetchCases,
        ErasureAdmin.Message.SucceededFetchCases({ cases: [] }),
      ),
    );
  });
});
