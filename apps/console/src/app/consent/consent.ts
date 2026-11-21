import { Duration, Effect, Option, Schema } from "effect";
import {
  button,
  card,
  description,
  eyebrow,
  notice,
  noticeRegion,
  statusHeading,
} from "design-system";
import { AsyncData, Command, Submodel, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import * as Api from "../api/api.ts";
import { awaitAnswer } from "../api/answer.ts";
import { Notice } from "../notice.ts";
import type { Resources } from "../resources.ts";
import { Session } from "../session/session.ts";
import {
  ANSWER_WINDOW_MS,
  CHECK_INTERVAL_MS,
  ConsentStatus,
  DATA_PROTECTION_AUTHORITIES_URL,
  ERASURE_REVIEW_DAYS,
  RECORDED_IN_THE_OFFICE,
  type Refusal,
  SubmittedErasure,
  SubmittedWithdrawal,
} from "../wire.ts";
import { type ConsentView, describeConsent } from "./describe-consent.ts";
import { groundLabel, officeTime } from "./describe-erasure.ts";
import * as ErasureAdmin from "./erasure-admin.ts";

export const WITHDRAWN: Notice = {
  kind: "info",
  text: "Your consent is withdrawn. If you were in the office, the bot has shown you out, and it's sent you a DM. We'll miss you.",
};

export const NOTHING_TO_WITHDRAW: Notice = {
  kind: "info",
  text: "There was nothing to withdraw: you hadn't agreed to being recorded.",
};

export const NO_ANSWER: Notice = {
  kind: "error",
  text: "The bot didn't answer in time. It'll still withdraw your consent once it's back.",
};

export const SCHEDULED: Notice = {
  kind: "info",
  text: "Done. Your consent is withdrawn, the bot will show you out if you're in and send you a DM with the date, and the office admins have been told what will be deleted.",
};

export const NOT_SCHEDULED: Notice = {
  kind: "error",
  text: "Couldn't ask for your data to be deleted. Nothing has changed, so try again in a moment.",
};

export const CANCELLED: Notice = {
  kind: "info",
  text: "Your deletion request is cancelled. Nothing was deleted, and the bot will send you a DM.",
};

export const NOT_CANCELLED: Notice = {
  kind: "error",
  text: "Couldn't cancel the request. It may already have run, or the bot's records are out of reach. Check again in a moment.",
};

const WITHDRAWAL_ANSWER = {
  every: Duration.millis(CHECK_INTERVAL_MS),
  attempts: Math.floor(ANSWER_WINDOW_MS / CHECK_INTERVAL_MS),
};

export const ConsentData = AsyncData.Schema(ConsentStatus, Schema.String);

export const Action = Schema.Literals(["withdraw", "erase", "cancel"]);

export type Action = typeof Action.Type;

export const Model = Schema.Struct({
  status: ConsentData.schema,
  confirming: Schema.Option(Action),
  busy: Schema.Option(Action),
  notice: Schema.Option(Notice),
  admin: ErasureAdmin.Model,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  status: ConsentData.Idle(),
  confirming: Option.none(),
  busy: Option.none(),
  notice: Option.none(),
  admin: ErasureAdmin.init(),
});

export const Message = defineMessageUnion({
  SucceededFetchConsent: { status: ConsentStatus },
  FailedFetchConsent: { reason: Schema.String },
  ClickedRetry: {},
  ClickedConfirm: { action: Action },
  ClickedKeep: {},
  ClickedWithdraw: {},
  ClickedErase: {},
  ClickedCancelErasure: { id: Schema.Number },
  CompletedAct: { notice: Notice },
  ClickedAuthorities: {},
  CompletedOpenAuthorities: {},
  GotAdminMessage: { message: ErasureAdmin.Message },
});

export type Message = typeof Message.Type;

export const FetchConsent = Command.define("FetchConsent", {
  messages: [Message.SucceededFetchConsent, Message.FailedFetchConsent],
  execute: Api.get("/api/consent", ConsentStatus).pipe(
    Effect.map((status) => Message.SucceededFetchConsent({ status })),
    Effect.catchTag("ApiFailure", ({ reason }) =>
      Effect.succeed(Message.FailedFetchConsent({ reason })),
    ),
  ),
});

type AnsweredWithdrawal = SubmittedWithdrawal & {
  readonly outcome: NonNullable<SubmittedWithdrawal["outcome"]>;
};

const isAnswered = (withdrawal: SubmittedWithdrawal): withdrawal is AnsweredWithdrawal =>
  withdrawal.outcome !== null;

const withdrawalNotice = (withdrawal: SubmittedWithdrawal): Notice =>
  withdrawal.outcome === "ignored" ? NOTHING_TO_WITHDRAW : WITHDRAWN;

export const WithdrawConsent = Command.define("WithdrawConsent", {
  messages: [Message.CompletedAct],
  execute: Api.post("/api/consent/withdrawals", SubmittedWithdrawal).pipe(
    Effect.flatMap((submitted) =>
      isAnswered(submitted)
        ? Effect.succeed(Option.some(submitted))
        : awaitAnswer(
            Api.get(`/api/consent/withdrawals/${submitted.id}`, SubmittedWithdrawal),
            isAnswered,
            WITHDRAWAL_ANSWER,
          ),
    ),
    Effect.map(Option.match({ onNone: () => NO_ANSWER, onSome: withdrawalNotice })),
    Effect.orElseSucceed(() => NO_ANSWER),
    Effect.map((shown) => Message.CompletedAct({ notice: shown })),
  ),
});

export const RequestErasure = Command.define("RequestErasure", {
  messages: [Message.CompletedAct],
  execute: Api.post("/api/consent/erasures", SubmittedErasure).pipe(
    Effect.as(SCHEDULED),
    Effect.orElseSucceed(() => NOT_SCHEDULED),
    Effect.map((shown) => Message.CompletedAct({ notice: shown })),
  ),
});

export const CancelErasure = Command.define("CancelErasure", {
  args: { id: Schema.Number },
  messages: [Message.CompletedAct],
  execute: ({ id }) =>
    Api.post(`/api/consent/erasures/${id}/cancel`, SubmittedErasure).pipe(
      Effect.as(CANCELLED),
      Effect.orElseSucceed(() => NOT_CANCELLED),
      Effect.map((shown) => Message.CompletedAct({ notice: shown })),
    ),
});

export const OpenAuthorities = Command.define("OpenAuthorities", {
  messages: [Message.CompletedOpenAuthorities],
  execute: Session.use((session) => session.openExternalLink(DATA_PROTECTION_AUTHORITIES_URL)).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedOpenAuthorities()),
  ),
});

type UpdateReturn = Update.Return<Model, Message, Resources>;

export const open = (_model: Model): UpdateReturn => ({
  model: modifyFields(init(), { status: () => ConsentData.Loading() }),
  commands: [FetchConsent()],
});

const act = (
  model: Model,
  action: Action,
  command: Command.Command<Message, never, Resources>,
): UpdateReturn => ({
  model: modifyFields(model, { busy: () => Option.some(action), notice: () => Option.none() }),
  commands: [command],
});

const foldAdmin = Update.foldChild({
  update: ErasureAdmin.update,
  read: (model: Model) => Option.some(model.admin),
  write: (model, nextAdmin) => modifyFields(model, { admin: () => nextAdmin }),
  toParentMessage: (message) => Message.GotAdminMessage({ message }),
});

const withAdminCases = (model: Model, status: ConsentStatus): UpdateReturn => {
  if (!status.admin || !AsyncData.isIdle(model.admin.cases)) {
    return { model };
  }

  const adminOpen = ErasureAdmin.open(model.admin);

  return {
    model: modifyFields(model, { admin: () => adminOpen.model }),
    commands: Command.mapMessages(adminOpen.commands, (message) =>
      Message.GotAdminMessage({ message }),
    ),
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchConsent: ({ status }) =>
      withAdminCases(
        modifyFields(model, { status: () => ConsentData.Success({ data: status }) }),
        status,
      ),

    FailedFetchConsent: ({ reason }) => ({
      model: modifyFields(model, { status: () => ConsentData.Failure({ error: reason }) }),
    }),

    ClickedRetry: () => ({
      model: modifyFields(model, { status: () => ConsentData.Loading() }),
      commands: [FetchConsent()],
    }),

    ClickedConfirm: ({ action }) => ({
      model: modifyFields(model, { confirming: () => Option.some(action) }),
    }),

    ClickedKeep: () => ({ model: modifyFields(model, { confirming: () => Option.none() }) }),

    ClickedWithdraw: () => act(model, "withdraw", WithdrawConsent()),

    ClickedErase: () => act(model, "erase", RequestErasure()),

    ClickedCancelErasure: ({ id }) => act(model, "cancel", CancelErasure({ id })),

    CompletedAct: ({ notice: shown }) => ({
      model: modifyFields(model, {
        busy: () => Option.none(),
        confirming: () => Option.none(),
        notice: () => Option.some(shown),
        status: (status) =>
          Option.match(AsyncData.getData(status), {
            onNone: () => ConsentData.Loading(),
            onSome: (data) => ConsentData.Refreshing({ data }),
          }),
      }),
      commands: [FetchConsent()],
    }),

    ClickedAuthorities: () => ({ model, commands: [OpenAuthorities()] }),

    CompletedOpenAuthorities: () => ({ model }),

    GotAdminMessage: ({ message: adminMessage }) => foldAdmin(model, adminMessage),
  });

const isBusy = (model: Model): boolean => Option.isSome(model.busy);

const busyWith = (model: Model, action: Action): boolean =>
  Option.exists(model.busy, (busy) => busy === action);

const isConfirming = (model: Model, action: Action): boolean =>
  Option.exists(model.confirming, (confirming) => confirming === action);

interface ConfirmConfig {
  readonly action: Action;
  readonly text: string;
  readonly confirm: Message;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  readonly keepLabel: string;
  readonly isDanger?: boolean;
}

const confirmView = (model: Model, config: ConfirmConfig, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(config.isDanger === true ? "confirm confirm-danger" : "confirm"),
      h.Role("group"),
      h.AriaLabelledBy(`confirm-${config.action}-text`),
    ],
    [
      h.p([h.Id(`confirm-${config.action}-text`), h.Class("text-body-sm")], [config.text]),
      h.div(
        [h.Class("controls")],
        [
          button(h, {
            label: [busyWith(model, config.action) ? config.busyLabel : config.confirmLabel],
            onClick: config.confirm,
            isDisabled: isBusy(model),
            isBusy: busyWith(model, config.action),
          }),
          button(h, {
            label: [config.keepLabel],
            variant: "ghost",
            onClick: Message.ClickedKeep(),
            isDisabled: isBusy(model),
          }),
        ],
      ),
    ],
  );

const askButton = (model: Model, action: Action, label: string, h: HtmlBuilder<Message>): Html =>
  button(h, {
    label: [label],
    variant: "ghost",
    onClick: Message.ClickedConfirm({ action }),
    isDisabled: isBusy(model),
    className: "align-start",
  });

const recordedView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("stack-2"), h.AriaLabelledBy("recorded-heading")],
    [
      h.h3(
        [h.Id("recorded-heading"), h.Class("text-body-sm label")],
        ["While you're in the office, it records"],
      ),
      h.ul(
        [h.Class("text-body-sm bullets")],
        RECORDED_IN_THE_OFFICE.map((item) => h.li([], [item])),
      ),
      description(h, [
        "It's shared in the office Slack channel, and AI models read it to write the office banter and summarise recordings. That's how the office works, so it can't be switched off for one person.",
      ]),
    ],
  );

const cancelView = (model: Model, id: number, h: HtmlBuilder<Message>): Html =>
  isConfirming(model, "cancel")
    ? confirmView(
        model,
        {
          action: "cancel",
          text: "Cancelling keeps everything as it is. Your consent stays withdrawn until you agree again, which the bot asks you next time you join the office.",
          confirm: Message.ClickedCancelErasure({ id }),
          confirmLabel: "Cancel the deletion",
          busyLabel: "Cancelling…",
          keepLabel: "Keep the request",
        },
        h,
      )
    : askButton(model, "cancel", "Cancel the deletion", h);

const refusalView = (refusal: Refusal, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("stack-2 consent-section"), h.AriaLabelledBy("refusal-heading")],
    [
      h.h3(
        [h.Id("refusal-heading"), h.Class("text-body-sm label")],
        ["Why your data wasn't deleted"],
      ),
      description(h, [
        `On ${officeTime(refusal.refusedAt)} the office admins refused your request because of ${groundLabel(refusal.ground)}. In their words:`,
      ]),
      h.blockquote([h.Class("text-body-sm")], [refusal.reason]),
      description(h, [
        "Your consent stays withdrawn, so nothing new is recorded about you. If you think that's wrong, you can complain to a data protection authority.",
      ]),
      button(h, {
        label: ["Data protection authorities"],
        variant: "ghost",
        onClick: Message.ClickedAuthorities(),
        className: "align-start",
      }),
    ],
  );

const withdrawView = (model: Model, h: HtmlBuilder<Message>): Html =>
  isConfirming(model, "withdraw")
    ? confirmView(
        model,
        {
          action: "withdraw",
          text: "Withdrawing shows you out of the office straight away, and nothing new is recorded about you. What's already recorded stays until you ask for it to be deleted. If you come back, the bot will ask you again.",
          confirm: Message.ClickedWithdraw(),
          confirmLabel: "Withdraw my consent",
          busyLabel: "Withdrawing…",
          keepLabel: "Keep it",
        },
        h,
      )
    : askButton(model, "withdraw", "Withdraw consent", h);

const eraseView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("stack-2 consent-section"), h.AriaLabelledBy("erase-heading")],
    [
      h.h3([h.Id("erase-heading"), h.Class("text-body-sm label")], ["Delete your data"]),
      description(h, [
        `Asks for everything the office holds about you to be deleted: your activity, your sounds and emoji, the Slack messages the bot kept, and your lines and audio in every recording. Each recording you spoke in gets a new summary without you, and your name is taken out of everything else, like other people's lines and the bot's posts in Slack. Your consent is withdrawn straight away. The deletion runs ${ERASURE_REVIEW_DAYS} days later, or sooner if the office admins decide so, which gives them time to check that nothing has to be kept by law. You can cancel until then.`,
      ]),
      isConfirming(model, "erase")
        ? confirmView(
            model,
            {
              action: "erase",
              text: "Once it runs, this can't be undone. If you're in the office, the bot shows you out now, and if you come back before it runs, agreeing to being recorded cancels it.",
              confirm: Message.ClickedErase(),
              confirmLabel: "Delete everything",
              busyLabel: "Asking…",
              keepLabel: "Keep it",
              isDanger: true,
            },
            h,
          )
        : askButton(model, "erase", "Delete my data", h),
    ],
  );

const statusView = (
  model: Model,
  status: ConsentStatus,
  shown: ConsentView,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  statusHeading(h, { heading: shown.heading, description: shown.description, level: 2 }),
  recordedView(h),
  shown.canCancel && status.pendingErasure !== null
    ? cancelView(model, status.pendingErasure.id, h)
    : h.empty,
  shown.refusal === null ? h.empty : refusalView(shown.refusal, h),
  shown.canWithdraw ? withdrawView(model, h) : h.empty,
  shown.canErase ? eraseView(model, h) : h.empty,
];

const checking = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [description(h, ["Checking…"])];

const consentCard = (model: Model, h: HtmlBuilder<Message>): Html =>
  card(h, "lg", [
    eyebrow(h, { text: "Privacy" }),
    ...AsyncData.match(model.status, {
      onIdle: () => checking(h),
      onLoading: () => checking(h),
      onFailure: (reason) => [
        notice(h, { kind: "error", text: `Couldn't check your consent: ${reason}` }),
        button(h, {
          label: ["Try again"],
          variant: "ghost",
          onClick: Message.ClickedRetry(),
          className: "align-start",
        }),
      ],
      onRefreshing: (status) => statusView(model, status, describeConsent(status), h),
      onStale: ({ data }) => statusView(model, data, describeConsent(data), h),
      onSuccess: (status) => statusView(model, status, describeConsent(status), h),
    }),
    noticeRegion(
      h,
      Option.match(model.notice, { onNone: () => [], onSome: (shown) => [notice(h, shown)] }),
    ),
  ]);

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const isAdmin = Option.exists(AsyncData.getData(model.status), (status) => status.admin);

  return h.div(
    [h.Class("panels")],
    [
      consentCard(model, h),
      isAdmin
        ? h.submodel({
            slotId: "erasure-admin",
            model: model.admin,
            view: ErasureAdmin.view,
            toParentMessage: (message) => Message.GotAdminMessage({ message }),
          })
        : h.empty,
    ],
  );
});
