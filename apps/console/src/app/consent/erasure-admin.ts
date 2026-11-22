import { Array, Effect, Match, Option, Schema, String } from "effect";
import {
  button,
  card,
  description,
  eyebrow,
  notice,
  noticeRegion,
  type SelectOption,
  selectField,
  textField,
} from "design-system";
import { AsyncData, Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { ConsoleApi, isUnanswered, reasonOf } from "../api/api.ts";
import { Notice } from "../notice.ts";
import type { Resources } from "../resources.ts";
import { ErasureCase, RefusalGround } from "office-domain/Consent";
import { REFUSAL_GROUNDS } from "office-domain/wire";
import { describeInventory, describeStanding, officeTime } from "./describe-erasure.ts";

export const NOTED_NOW: Notice = {
  kind: "info",
  text: "Noted. The bot deletes it within a minute, then tells them.",
};

export const NOTED_SEEN: Notice = {
  kind: "info",
  text: "Noted as seen. It still runs on the due date unless someone acts.",
};

export const NOTED_REFUSED: Notice = {
  kind: "info",
  text: "Refused. They'll be told why, and that they can complain.",
};

export const ALREADY_DECIDED: Notice = {
  kind: "error",
  text: "That request was already decided, or the deletion has already run.",
};

export const NOT_SURE: Notice = {
  kind: "error",
  text: "The Console's server didn't answer, so this may or may not have gone through. The list below shows where it stands now.",
};

export const UNREACHABLE: Notice = {
  kind: "error",
  text: "Couldn't reach the bot's records. Nothing changed, so try again in a moment.",
};

const REASON_ROWS = 4;

const REASON_MAX_LENGTH = 1000;

const GROUNDS: ReadonlyArray<SelectOption> = [
  { value: "legal_obligation", label: REFUSAL_GROUNDS.legal_obligation },
  { value: "legal_claim", label: REFUSAL_GROUNDS.legal_claim },
];

const groundOf = (value: string): RefusalGround =>
  value === "legal_claim" ? "legal_claim" : "legal_obligation";

export const CasesData = AsyncData.Schema(Schema.Array(ErasureCase), Schema.String);

export const Confirming = Schema.Struct({
  id: Schema.Finite,
  action: Schema.Literals(["now", "refuse"]),
});

export const Decision = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("now") }),
  Schema.Struct({ kind: Schema.Literal("seen") }),
  Schema.Struct({ kind: Schema.Literal("refuse"), ground: RefusalGround, reason: Schema.String }),
]);

export type Decision = typeof Decision.Type;

export const Model = Schema.Struct({
  cases: CasesData.schema,
  confirming: Schema.Option(Confirming),
  busy: Schema.Option(Schema.Finite),
  notice: Schema.Option(Notice),
  ground: RefusalGround,
  reason: Schema.String,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  cases: CasesData.Idle(),
  confirming: Option.none(),
  busy: Option.none(),
  notice: Option.none(),
  ground: "legal_obligation",
  reason: "",
});

export const Message = defineMessageUnion({
  SucceededFetchCases: { cases: Schema.Array(ErasureCase) },
  FailedFetchCases: { reason: Schema.String },
  ClickedConfirm: { confirming: Confirming },
  ClickedBack: {},
  ClickedDeleteNow: { id: Schema.Finite },
  ClickedLetItRun: { id: Schema.Finite },
  UpdatedGround: { value: Schema.String },
  UpdatedReason: { value: Schema.String },
  SubmittedRefusal: { id: Schema.Finite },
  SucceededDecideErasure: { decision: Decision },
  FailedDecideErasure: { why: Schema.Literals(["already_decided", "unreachable", "unanswered"]) },
});

export type Message = typeof Message.Type;

export const FetchCases = Command.define("FetchCases", {
  messages: [Message.SucceededFetchCases, Message.FailedFetchCases],
  execute: ConsoleApi.use((api) => api.erasureAdmin.cases()).pipe(
    Effect.map((cases) => Message.SucceededFetchCases({ cases })),
    Effect.catch((failure) =>
      Effect.succeed(Message.FailedFetchCases({ reason: reasonOf(failure) })),
    ),
  ),
});

const decided = (id: number, decision: Decision) =>
  ConsoleApi.use((api) => {
    switch (decision.kind) {
      case "now":
        return api.erasureAdmin.expedite({ params: { id } });
      case "seen":
        return api.erasureAdmin.seen({ params: { id } });
      case "refuse":
        return api.erasureAdmin.refuse({
          params: { id },
          payload: { ground: decision.ground, reason: decision.reason },
        });
    }
  });

export const DecideErasure = Command.define("DecideErasure", {
  args: { id: Schema.Finite, decision: Decision },
  messages: [Message.SucceededDecideErasure, Message.FailedDecideErasure],
  execute: ({ id, decision }) =>
    decided(id, decision).pipe(
      Effect.as(Message.SucceededDecideErasure({ decision })),
      Effect.catchTag("ErasureNotFound", () =>
        Effect.succeed(Message.FailedDecideErasure({ why: "already_decided" })),
      ),
      Effect.catch((failure) =>
        Effect.succeed(
          Message.FailedDecideErasure({
            why: isUnanswered(failure) ? "unanswered" : "unreachable",
          }),
        ),
      ),
    ),
});

type UpdateReturn = Update.Return<Model, Message, Resources>;

export const open = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { cases: () => CasesData.Loading() }),
  commands: [FetchCases()],
});

const decide = (model: Model, id: number, decision: Decision): UpdateReturn =>
  Option.isSome(model.busy)
    ? { model }
    : {
        model: modifyFields(model, { busy: () => Option.some(id), notice: () => Option.none() }),
        commands: [DecideErasure({ id, decision })],
      };

const refreshedCases = (cases: Model["cases"]): Model["cases"] =>
  Option.match(AsyncData.getData(cases), {
    onNone: () => CasesData.Loading(),
    onSome: (data) => CasesData.Refreshing({ data }),
  });

export const refresh = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { cases: refreshedCases }),
  commands: [FetchCases()],
});

const withoutDraft = (model: Model): Model =>
  modifyFields(model, {
    confirming: () => Option.none(),
    ground: () => "legal_obligation",
    reason: () => "",
  });

const settle = (model: Model, shown: Notice): UpdateReturn =>
  refresh(
    modifyFields(model, {
      busy: () => Option.none(),
      notice: () => Option.some(shown),
    }),
  );

const noticeFor = (decision: Decision): Notice => {
  switch (decision.kind) {
    case "now":
      return NOTED_NOW;
    case "seen":
      return NOTED_SEEN;
    case "refuse":
      return NOTED_REFUSED;
  }
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchCases: ({ cases }) => ({
      model: modifyFields(model, { cases: () => CasesData.Success({ data: cases }) }),
    }),

    FailedFetchCases: ({ reason }) => ({
      model: modifyFields(model, { cases: () => CasesData.Failure({ error: reason }) }),
    }),

    ClickedConfirm: ({ confirming }) => ({
      model: modifyFields(withoutDraft(model), { confirming: () => Option.some(confirming) }),
    }),

    ClickedBack: () => ({ model: withoutDraft(model) }),

    ClickedDeleteNow: ({ id }) => decide(model, id, { kind: "now" }),

    ClickedLetItRun: ({ id }) => decide(model, id, { kind: "seen" }),

    UpdatedGround: ({ value }) => ({
      model: modifyFields(model, { ground: () => groundOf(value) }),
    }),

    UpdatedReason: ({ value }) => ({ model: modifyFields(model, { reason: () => value }) }),

    SubmittedRefusal: ({ id }) => {
      const reason = String.trim(model.reason);

      return reason === ""
        ? { model }
        : decide(model, id, { kind: "refuse", ground: model.ground, reason });
    },

    SucceededDecideErasure: ({ decision }) => settle(withoutDraft(model), noticeFor(decision)),

    FailedDecideErasure: ({ why }) =>
      Match.value(why).pipe(
        Match.when("already_decided", () => settle(withoutDraft(model), ALREADY_DECIDED)),
        Match.when("unanswered", () => settle(withoutDraft(model), NOT_SURE)),
        Match.when("unreachable", () => settle(model, UNREACHABLE)),
        Match.exhaustive,
      ),
  });

const isConfirming = (model: Model, id: number, action: "now" | "refuse"): boolean =>
  Option.exists(
    model.confirming,
    (confirming) => confirming.id === id && confirming.action === action,
  );

const workingLabel = (model: Model, id: number, idle: string): string =>
  Option.exists(model.busy, (busy) => busy === id) ? "Working…" : idle;

const confirmNowView = (model: Model, id: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("confirm confirm-danger"), h.Role("group")],
    [
      h.p(
        [h.Class("text-body-sm")],
        ["This runs the deletion within a minute, and it can't be undone."],
      ),
      h.div(
        [h.Class("controls")],
        [
          button(h, {
            label: [workingLabel(model, id, "Delete now")],
            onClick: Message.ClickedDeleteNow({ id }),
            isDisabled: Option.isSome(model.busy),
          }),
          button(h, {
            label: ["Back"],
            variant: "ghost",
            onClick: Message.ClickedBack(),
            isDisabled: Option.isSome(model.busy),
          }),
        ],
      ),
    ],
  );

const refuseView = (model: Model, id: number, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class("confirm confirm-danger"), h.OnSubmit(Message.SubmittedRefusal({ id }))],
    [
      selectField(h, {
        id: `ground-${id}`,
        label: "Ground",
        options: GROUNDS,
        value: model.ground,
        onChange: (value) => Message.UpdatedGround({ value }),
      }),
      textField(h, {
        id: `reason-${id}`,
        label: "Why it has to be kept. This goes to them, word for word.",
        value: model.reason,
        onInput: (value) => Message.UpdatedReason({ value }),
        isMultiline: true,
        rows: REASON_ROWS,
        maxLength: REASON_MAX_LENGTH,
        isRequired: true,
        isCountHidden: true,
        isLabelStrong: true,
      }),
      h.div(
        [h.Class("controls")],
        [
          button(h, {
            label: [workingLabel(model, id, "Refuse the deletion")],
            isSubmit: true,
            isDisabled: Option.isSome(model.busy) || String.trim(model.reason) === "",
          }),
          button(h, {
            label: ["Keep it open"],
            variant: "ghost",
            onClick: Message.ClickedBack(),
            isDisabled: Option.isSome(model.busy),
          }),
        ],
      ),
    ],
  );

const actionsView = (model: Model, id: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("controls")],
    [
      button(h, {
        label: ["Delete now"],
        onClick: Message.ClickedConfirm({ confirming: { id, action: "now" } }),
        isDisabled: Option.isSome(model.busy),
      }),
      button(h, {
        label: ["Let it run"],
        variant: "ghost",
        onClick: Message.ClickedLetItRun({ id }),
        isDisabled: Option.isSome(model.busy),
      }),
      button(h, {
        label: ["Refuse…"],
        variant: "ghost",
        onClick: Message.ClickedConfirm({ confirming: { id, action: "refuse" } }),
        isDisabled: Option.isSome(model.busy),
      }),
    ],
  );

const decisionView = (model: Model, erasure: ErasureCase, h: HtmlBuilder<Message>): Html => {
  if (erasure.decision !== null) return h.empty;

  if (isConfirming(model, erasure.id, "now")) return confirmNowView(model, erasure.id, h);

  if (isConfirming(model, erasure.id, "refuse")) return refuseView(model, erasure.id, h);

  return actionsView(model, erasure.id, h);
};

const caseView = (model: Model, erasure: ErasureCase, h: HtmlBuilder<Message>): Html =>
  h.keyed("article")(
    globalThis.String(erasure.id),
    [h.Class("case"), h.AriaLabelledBy(`case-${erasure.id}`)],
    [
      h.h3(
        [h.Id(`case-${erasure.id}`), h.Class("text-body label")],
        [
          erasure.displayName ?? "A member",
          h.span(
            [h.Class("text-body-sm muted")],
            [`Discord ID ${erasure.userId} · request #${erasure.id}`],
          ),
        ],
      ),
      description(h, [
        `Asked on ${officeTime(erasure.requestedAt)}. Unless someone acts, it's deleted on ${officeTime(erasure.dueAt)}. ${describeStanding(erasure)}`,
      ]),
      description(h, [
        "Under Article 17 of the GDPR this is their right. Refusing needs one of two grounds: a legal obligation to keep the data, or an ongoing legal claim that needs it. The reason goes to them word for word, with their right to complain to a data protection authority.",
      ]),
      h.h4([h.Class("text-body-sm label")], ["What will be deleted"]),
      h.ul(
        [h.Class("text-body-sm bullets")],
        Array.map(describeInventory(erasure.inventory), (line) => h.li([], [line])),
      ),
      decisionView(model, erasure, h),
    ],
  );

const casesView = (model: Model, cases: ReadonlyArray<ErasureCase>, h: HtmlBuilder<Message>) => [
  ...(cases.length === 0
    ? [description(h, ["Nobody has asked for their data to be deleted."])]
    : []),
  ...Array.map(cases, (erasure) => caseView(model, erasure, h)),
];

const loading = (h: HtmlBuilder<Message>) => [description(h, ["Loading…"])];

export const view = Submodel.defineView<Model, Message>((model, h) =>
  card(h, "lg", [
    eyebrow(h, { text: "Deletion requests" }),
    ...AsyncData.match(model.cases, {
      onIdle: () => loading(h),
      onLoading: () => loading(h),
      onFailure: (reason) => [
        notice(h, { kind: "error", text: `Couldn't load the deletion requests: ${reason}` }),
      ],
      onRefreshing: (cases) => casesView(model, cases, h),
      onStale: ({ data }) => casesView(model, data, h),
      onSuccess: (cases) => casesView(model, cases, h),
    }),
    noticeRegion(
      h,
      Option.match(model.notice, { onNone: () => [], onSome: (shown) => [notice(h, shown)] }),
    ),
  ]),
);
