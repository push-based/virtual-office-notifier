import { Clock, Duration, Effect, Option, Predicate, Schema, Stream } from "effect";
import { card, notice, Tabs } from "design-system";
import { Command, Subscription, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import * as Consent from "./consent/consent.ts";
import * as History from "./history/history.ts";
import * as Recorder from "./recorder/recorder.ts";
import type { Resources } from "./resources.ts";
import { Session } from "./session/session.ts";
import { SignIn } from "./session/sign-in.ts";
import * as Stats from "./stats/stats.ts";
import { startTelemetry } from "./telemetry/telemetry.ts";

const CLOCK_TICK = Duration.seconds(1);

export const View = Schema.Literals(["now", "history", "stats", "privacy"]);

export type View = typeof View.Type;

export const VIEWS: ReadonlyArray<Tabs.Tab<View>> = [
  { id: "now", label: "Now" },
  { id: "history", label: "History" },
  { id: "stats", label: "Stats" },
  { id: "privacy", label: "Privacy" },
];

const ViewTabs = Tabs.create(VIEWS);

export const Model = Schema.Struct({
  view: View,
  viewTabs: Tabs.Model,
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
  GotViewTabsMessage: { message: Tabs.Message },
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
  viewTabs: Tabs.init("view"),
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

const toViewTabsMessage = (message: Tabs.Message) => Message.GotViewTabsMessage({ message });

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

const foldStatsOpen = Update.foldChildStep({
  update: Stats.open,
  read: (model: Model) => Option.some(model.stats),
  write: (model, nextStats) => modifyFields(model, { stats: () => nextStats }),
  toParentMessage: toStatsMessage,
});

const foldConsentOpen = Update.foldChildStep({
  update: Consent.open,
  read: (model: Model) => Option.some(model.consent),
  write: (model, nextConsent) => modifyFields(model, { consent: () => nextConsent }),
  toParentMessage: toConsentMessage,
});

const openView = (model: Model): UpdateReturn => {
  if (!isSignedIn(model)) {
    return { model };
  }

  if (model.view === "stats") {
    return foldStatsOpen(model);
  }

  if (model.view === "privacy") {
    return foldConsentOpen(model);
  }

  return { model };
};

const selectView = (model: Model, view: View): UpdateReturn =>
  view === model.view ? { model } : openView(modifyFields(model, { view: () => view }));

const foldViewTabsOutMessage = Tabs.OutMessage.match<
  Update.Step<Model, Message, Resources>,
  Tabs.OutMessage<View>
>({
  Selected:
    ({ value }) =>
    (stepModel) =>
      selectView(stepModel, value),
});

const foldViewTabs = Update.foldChild({
  update: ViewTabs.update,
  read: (model: Model) => Option.some(model.viewTabs),
  write: (model, nextViewTabs) => modifyFields(model, { viewTabs: () => nextViewTabs }),
  toParentMessage: toViewTabsMessage,
  foldOutMessage: foldViewTabsOutMessage,
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    GotViewTabsMessage: ({ message: viewTabsMessage }) => foldViewTabs(model, viewTabsMessage),

    SucceededSignIn: () => openView(modifyFields(model, { signIn: () => SignIn.SignedIn() })),

    FailedSignIn: ({ reason }) => ({
      model: modifyFields(model, { signIn: () => SignIn.FailedSignIn({ reason }) }),
    }),

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
    when: isSignedIn,
  }),
  Subscription.lift(History.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.history),
    toParentMessage: toHistoryMessage,
    when: isSignedIn,
  }),
);

const failedSignInView = (h: HtmlBuilder<Message>, reason: string): ReadonlyArray<Html> => [
  card(h, [notice(h, { kind: "error", text: `Couldn't sign in through Discord: ${reason}` })]),
];

const onceSignedIn = (
  model: Model,
  h: HtmlBuilder<Message>,
  content: () => ReadonlyArray<Html>,
): ReadonlyArray<Html> =>
  SignIn.match<ReadonlyArray<Html>>(model.signIn, {
    SigningIn: content,
    SignedIn: content,
    FailedSignIn: ({ reason }) => failedSignInView(h, reason),
  });

const whenShown =
  (model: Model, shown: View, content: () => ReadonlyArray<Html>): (() => ReadonlyArray<Html>) =>
  () =>
    model.view === shown ? content() : [];

const frame = (
  model: Model,
  h: HtmlBuilder<Message>,
  { tablist, panel }: Tabs.Layout<View, Message>,
): Html =>
  h.div(
    [h.Class("console-frame")],
    [
      h.nav([h.Class("console-nav")], [tablist]),
      panel(
        "now",
        [],
        [
          h.submodel({
            slotId: "recorder",
            model: model.recorder,
            view: Recorder.view,
            viewInputs: { now: model.now, signIn: model.signIn },
            toParentMessage: toRecorderMessage,
          }),
        ],
      ),
      panel(
        "history",
        [],
        onceSignedIn(model, h, () => [
          h.submodel({
            slotId: "history",
            model: model.history,
            view: History.view,
            viewInputs: { now: model.now },
            toParentMessage: toHistoryMessage,
          }),
        ]),
      ),
      panel(
        "stats",
        [],
        onceSignedIn(
          model,
          h,
          whenShown(model, "stats", () => [
            h.submodel({
              slotId: "stats",
              model: model.stats,
              view: Stats.view,
              toParentMessage: toStatsMessage,
            }),
          ]),
        ),
      ),
      panel(
        "privacy",
        [],
        onceSignedIn(
          model,
          h,
          whenShown(model, "privacy", () => [
            h.submodel({
              slotId: "consent",
              model: model.consent,
              view: Consent.view,
              toParentMessage: toConsentMessage,
            }),
          ]),
        ),
      ),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Console",
  body: h.main(
    [h.Class("console")],
    [
      ViewTabs.view(h, {
        model: model.viewTabs,
        label: "Console",
        appearance: "underline",
        selected: model.view,
        toParentMessage: toViewTabsMessage,
        toView: (layout) => frame(model, h, layout),
      }),
    ],
  ),
});
