import { Array, Clock, Duration, Effect, Option, pipe, Predicate, Schema, Stream } from "effect";
import { type Tab, tabId, tabPanelId, tabs } from "design-system";
import { Command, Subscription, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";

import * as Consent from "./consent/consent.ts";
import * as History from "./history/history.ts";
import * as Recorder from "./recorder/recorder.ts";
import type { Resources } from "./resources.ts";
import { Session } from "./session/session.ts";
import * as Stats from "./stats/stats.ts";
import { startTelemetry } from "./telemetry/telemetry.ts";

export const CLOCK_TICK = Duration.seconds(1);

export const View = Schema.Literals(["now", "history", "stats", "privacy"]);

export type View = typeof View.Type;

export const VIEWS: ReadonlyArray<Tab<View>> = [
  { id: "now", label: "Now" },
  { id: "history", label: "History" },
  { id: "stats", label: "Stats" },
  { id: "privacy", label: "Privacy" },
];

export const viewOf = (id: string): View =>
  pipe(
    VIEWS,
    Array.findFirst((tab) => tab.id === id),
    Option.match({ onNone: () => "now", onSome: (tab) => tab.id }),
  );

export const SignIn = defineTaggedUnion({
  SigningIn: {},
  SignedIn: {},
  FailedSignIn: { reason: Schema.String },
});

export const Model = Schema.Struct({
  view: View,
  signIn: SignIn,
  now: Schema.Finite,
  recorder: Recorder.Model,
  history: History.Model,
  stats: Stats.Model,
  consent: Consent.Model,
});

export type Model = typeof Model.Type;

export const isSignedIn = (model: Model): boolean => Predicate.isTagged(model.signIn, "SignedIn");

export const Message = defineMessageUnion({
  ClickedView: { view: Schema.String },
  SucceededSignIn: {},
  FailedSignIn: { reason: Schema.String },
  CompletedStartTelemetry: {},
  TickedClock: { now: Schema.Finite },
  GotRecorderMessage: { message: Recorder.Message },
  GotHistoryMessage: { message: History.Message },
  GotStatsMessage: { message: Stats.Message },
  GotConsentMessage: { message: Consent.Message },
});

export type Message = typeof Message.Type;

export const SignInToDiscord = Command.define("SignInToDiscord", {
  messages: [Message.SucceededSignIn, Message.FailedSignIn],
  execute: Session.use((session) => session.signIn).pipe(
    Effect.as(Message.SucceededSignIn()),
    Effect.catchTag("SignInFailure", ({ reason }) =>
      Effect.succeed(Message.FailedSignIn({ reason })),
    ),
  ),
});

export const StartTelemetry = Command.define("StartTelemetry", {
  messages: [Message.CompletedStartTelemetry],
  execute: startTelemetry.pipe(Effect.as(Message.CompletedStartTelemetry())),
});

export const initModel = (): Model => ({
  view: "now",
  signIn: SignIn.SigningIn(),
  now: 0,
  recorder: Recorder.init(),
  history: History.init(),
  stats: Stats.init(),
  consent: Consent.init(),
});

export const init = (): Update.Return<Model, Message, Resources> => ({
  model: initModel(),
  commands: [StartTelemetry(), SignInToDiscord()],
});

type UpdateReturn = Update.Return<Model, Message, Resources>;

const toRecorderMessage = (message: Recorder.Message) => Message.GotRecorderMessage({ message });

const toHistoryMessage = (message: History.Message) => Message.GotHistoryMessage({ message });

const toStatsMessage = (message: Stats.Message) => Message.GotStatsMessage({ message });

const toConsentMessage = (message: Consent.Message) => Message.GotConsentMessage({ message });

const foldRecorder = Update.foldChild({
  update: Recorder.update,
  read: (model: Model) => Option.some(model.recorder),
  write: (model, nextRecorder) => modifyFields(model, { recorder: () => nextRecorder }),
  toParentMessage: toRecorderMessage,
});

const foldHistory = Update.foldChild({
  update: History.update,
  read: (model: Model) => Option.some(model.history),
  write: (model, nextHistory) => modifyFields(model, { history: () => nextHistory }),
  toParentMessage: toHistoryMessage,
});

const foldStats = Update.foldChild({
  update: Stats.update,
  read: (model: Model) => Option.some(model.stats),
  write: (model, nextStats) => modifyFields(model, { stats: () => nextStats }),
  toParentMessage: toStatsMessage,
});

const foldConsent = Update.foldChild({
  update: Consent.update,
  read: (model: Model) => Option.some(model.consent),
  write: (model, nextConsent) => modifyFields(model, { consent: () => nextConsent }),
  toParentMessage: toConsentMessage,
});

const openView = (model: Model): UpdateReturn => {
  if (!isSignedIn(model)) {
    return { model };
  }

  if (model.view === "stats") {
    const statsOpen = Stats.open(model.stats);

    return {
      model: modifyFields(model, { stats: () => statsOpen.model }),
      commands: Command.mapMessages(statsOpen.commands, toStatsMessage),
    };
  }

  if (model.view === "privacy") {
    const consentOpen = Consent.open(model.consent);

    return {
      model: modifyFields(model, { consent: () => consentOpen.model }),
      commands: Command.mapMessages(consentOpen.commands, toConsentMessage),
    };
  }

  return { model };
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedView: ({ view }) =>
      viewOf(view) === model.view
        ? { model }
        : openView(modifyFields(model, { view: () => viewOf(view) })),

    SucceededSignIn: () => {
      const recorderSignedIn = Recorder.signedIn(model.recorder);

      return openView(
        modifyFields(model, {
          signIn: () => SignIn.SignedIn(),
          recorder: () => recorderSignedIn.model,
        }),
      );
    },

    FailedSignIn: ({ reason }) => {
      const recorderFailed = Recorder.failedSignIn(model.recorder, reason);

      return {
        model: modifyFields(model, {
          signIn: () => SignIn.FailedSignIn({ reason }),
          recorder: () => recorderFailed.model,
        }),
      };
    },

    CompletedStartTelemetry: () => ({ model }),

    TickedClock: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),

    GotRecorderMessage: ({ message: recorderMessage }) => foldRecorder(model, recorderMessage),

    GotHistoryMessage: ({ message: historyMessage }) => foldHistory(model, historyMessage),

    GotStatsMessage: ({ message: statsMessage }) => foldStats(model, statsMessage),

    GotConsentMessage: ({ message: consentMessage }) => foldConsent(model, consentMessage),
  });

const clock = Subscription.make<Model, Message>()((entry) => ({
  clock: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.tick(CLOCK_TICK).pipe(
          Stream.mapEffect(() => Clock.currentTimeMillis),
          Stream.map((now) => Message.TickedClock({ now })),
        ),
    },
  ),
}));

export const subscriptions = Subscription.aggregate(
  clock,
  Subscription.lift(Recorder.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.recorder),
    toParentMessage: toRecorderMessage,
  }),
  Subscription.lift(History.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.history),
    toParentMessage: toHistoryMessage,
    when: isSignedIn,
  }),
);

const panel = (h: HtmlBuilder<Message>, view: View, isHidden: boolean, content: Html): Html =>
  h.div(
    [
      h.Role("tabpanel"),
      h.Id(tabPanelId("view", view)),
      h.AriaLabelledBy(tabId("view", view)),
      h.Hidden(isHidden),
    ],
    [content],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Console",
  body: h.main(
    [h.Class("console")],
    [
      h.div(
        [h.Class("console-frame")],
        [
          h.nav(
            [h.Class("console-nav")],
            [
              tabs(h, {
                name: "view",
                label: "Console",
                appearance: "underline",
                tabs: VIEWS,
                selected: model.view,
                onSelect: (view) => Message.ClickedView({ view }),
              }),
            ],
          ),
          panel(
            h,
            "now",
            model.view !== "now",
            h.submodel({
              slotId: "recorder",
              model: model.recorder,
              view: Recorder.view,
              viewInputs: { now: model.now },
              toParentMessage: toRecorderMessage,
            }),
          ),
          panel(
            h,
            "history",
            model.view !== "history",
            h.submodel({
              slotId: "history",
              model: model.history,
              view: History.view,
              viewInputs: { now: model.now },
              toParentMessage: toHistoryMessage,
            }),
          ),
          model.view === "stats"
            ? panel(
                h,
                "stats",
                false,
                h.submodel({
                  slotId: "stats",
                  model: model.stats,
                  view: Stats.view,
                  toParentMessage: toStatsMessage,
                }),
              )
            : h.empty,
          model.view === "privacy"
            ? panel(
                h,
                "privacy",
                false,
                h.submodel({
                  slotId: "consent",
                  model: model.consent,
                  view: Consent.view,
                  toParentMessage: toConsentMessage,
                }),
              )
            : h.empty,
        ],
      ),
    ],
  ),
});
