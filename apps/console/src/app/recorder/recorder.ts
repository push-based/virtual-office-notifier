import { Array, Duration, Effect, Option, Schema, Stream } from "effect";
import {
  button,
  card,
  disclosure,
  divider,
  eyebrow,
  noticeRegion,
  people,
  type Person,
  statusHeading,
  NoticeContent,
} from "design-system";
import { Command, Submodel, Subscription, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";

import { ConsoleApi, reasonOf } from "../api/api.ts";
import { awaitAnswer } from "../api/answer.ts";
import * as RecordingEditor from "../edits/recording-editor.ts";
import { planFields } from "../edits/plan-fields.ts";
import { Draft, EMPTY_DRAFT, planOf, summaryStyleOf } from "../edits/plan.ts";
import type { Resources } from "../resources.ts";
import { Session } from "../session/session.ts";
import { SignIn } from "../session/sign-in.ts";
import {
  isAwaitingAnswer,
  isNewerAnswer,
  NO_REQUESTS,
  recordAnswer,
  RequestCount,
  sendRequest,
} from "../api/request-count.ts";
import {
  HandledRequest,
  RecordingStatus,
  RequestSubmission,
  type RunningRecording,
} from "office-domain/RecordingRequest";
import { describePhase, type OfficePhase } from "./describe-phase.ts";
import { describePresence, Presence, samePresence } from "./describe-presence.ts";
import { outcomeNotice, unreachableNotice } from "./notices.ts";
import { recordButton } from "./record-button.ts";

const STATE_POLL = Duration.seconds(3);

export const RECORDING_POLL = Duration.seconds(1);

const NOTICE_SHOWN_FOR = Duration.seconds(6);

export const Connection = defineTaggedUnion({
  Loading: {},
  Loaded: { status: RecordingStatus },
});

export type Connection = typeof Connection.Type;

const ShownNotice = Schema.Struct({ id: Schema.Finite, notice: NoticeContent });

export const Model = Schema.Struct({
  connection: Connection,
  draft: Draft,
  isPlanOpen: Schema.Boolean,
  isSubmitting: Schema.Boolean,
  notice: Schema.Option(ShownNotice),
  noticeCount: Schema.Finite,
  presence: Schema.Option(Presence),
  editor: RecordingEditor.Model,
  statusRequests: RequestCount,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  connection: Connection.Loading(),
  draft: EMPTY_DRAFT,
  isPlanOpen: false,
  isSubmitting: false,
  notice: Option.none(),
  noticeCount: 0,
  presence: Option.none(),
  editor: RecordingEditor.init(),
  statusRequests: NO_REQUESTS,
});

const statusOf = (model: Model): RecordingStatus | null =>
  Connection.match<RecordingStatus | null>(model.connection, {
    Loading: () => null,
    Loaded: ({ status }) => status,
  });

const runningOf = (model: Model): RunningRecording | null => statusOf(model)?.recording ?? null;

const connectionPhase = (connection: Connection): OfficePhase =>
  Connection.match<OfficePhase>(connection, {
    Loading: () => ({ kind: "connecting" }),
    Loaded: ({ status }) => {
      const { recording } = status;

      if (recording === null) return status.botInOffice ? { kind: "idle" } : { kind: "away" };

      return recording.pause === null
        ? { kind: "recording", recording }
        : { kind: "paused", recording, pause: recording.pause };
    },
  });

const phaseOf = (model: Model, signIn: SignIn): OfficePhase =>
  SignIn.match<OfficePhase>(signIn, {
    SigningIn: () => ({ kind: "connecting" }),
    FailedSignIn: ({ reason }) => ({ kind: "failed", reason }),
    SignedIn: () => connectionPhase(model.connection),
  });

const canPress = (model: Model): boolean =>
  !model.isSubmitting && statusOf(model)?.botInOffice === true;

export const Message = defineMessageUnion({
  TickedStatusPoll: {},
  SucceededFetchStatus: { request: Schema.Finite, status: RecordingStatus },
  FailedFetchStatus: { request: Schema.Finite, reason: Schema.String },
  CompletedShowPresence: {},
  ToggledPlan: { isOpen: Schema.Boolean },
  UpdatedDraftTitle: { value: Schema.String },
  UpdatedDraftAgenda: { value: Schema.String },
  UpdatedDraftSummaryStyle: { value: Schema.String },
  ClickedRecord: {},
  ClickedPause: {},
  CompletedSubmitRequest: { handled: Schema.NullOr(HandledRequest) },
  FailedSubmitRequest: { reason: Schema.String },
  CompletedWaitBeforeDismissal: { id: Schema.Finite },
  GotEditorMessage: { message: RecordingEditor.Message },
});

export type Message = typeof Message.Type;

export const FetchStatus = Command.define("FetchStatus", {
  args: { request: Schema.Finite },
  messages: [Message.SucceededFetchStatus, Message.FailedFetchStatus],
  execute: ({ request }) =>
    ConsoleApi.use((api) => api.recording.status()).pipe(
      Effect.map((status) => Message.SucceededFetchStatus({ request, status })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchStatus({ request, reason: reasonOf(failure) })),
      ),
    ),
});

export const ShowPresence = Command.define("ShowPresence", {
  args: { presence: Presence },
  messages: [Message.CompletedShowPresence],
  execute: ({ presence }) =>
    Session.use((session) => session.showPresence(presence)).pipe(
      Effect.as(Message.CompletedShowPresence()),
    ),
});

const isHandled = Schema.is(HandledRequest);

export const SubmitRequest = Command.define("SubmitRequest", {
  args: { submission: RequestSubmission },
  messages: [Message.CompletedSubmitRequest, Message.FailedSubmitRequest],
  execute: ({ submission }) =>
    ConsoleApi.use((api) =>
      api.recording
        .submit({ payload: submission })
        .pipe(
          Effect.flatMap(({ id }) =>
            awaitAnswer(api.recording.find({ params: { id } }), isHandled),
          ),
        ),
    ).pipe(
      Effect.map((handled) =>
        Message.CompletedSubmitRequest({ handled: Option.getOrNull(handled) }),
      ),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedSubmitRequest({ reason: reasonOf(failure) })),
      ),
    ),
});

export const WaitBeforeDismissal = Command.define("WaitBeforeDismissal", {
  args: { id: Schema.Finite },
  messages: [Message.CompletedWaitBeforeDismissal],
  execute: ({ id }) =>
    Effect.sleep(NOTICE_SHOWN_FOR).pipe(Effect.as(Message.CompletedWaitBeforeDismissal({ id }))),
});

type UpdateReturn = Update.Return<Model, Message, Resources>;

type Step = Update.Step<Model, Message, Resources>;

const requestStatus: Step = (model) => {
  const statusRequests = sendRequest(model.statusRequests);

  return {
    model: modifyFields(model, { statusRequests: () => statusRequests }),
    commands: [FetchStatus({ request: statusRequests.sent })],
  };
};

const showNotice =
  (shown: NoticeContent): Step =>
  (model) => {
    const id = model.noticeCount + 1;

    return {
      model: modifyFields(model, {
        notice: () => Option.some({ id, notice: shown }),
        noticeCount: () => id,
      }),
      commands: [WaitBeforeDismissal({ id })],
    };
  };

const answerStatus = (model: Model, request: number): Model =>
  modifyFields(model, { statusRequests: (count) => recordAnswer(count, request) });

const submit = (model: Model, submission: RequestSubmission): UpdateReturn =>
  canPress(model)
    ? {
        model: modifyFields(model, { isSubmitting: () => true }),
        commands: [SubmitRequest({ submission })],
      }
    : { model };

const settle = (model: Model, shown: NoticeContent): UpdateReturn =>
  Update.combine(modifyFields(model, { isSubmitting: () => false }), [
    showNotice(shown),
    requestStatus,
  ]);

const withStatus = (model: Model, status: RecordingStatus): UpdateReturn => {
  const presence = describePresence(status);
  const isSameRecording = runningOf(model)?.id === status.recording?.id;

  const nextModel = modifyFields(model, {
    connection: () => Connection.Loaded({ status }),
    editor: (editor) => (isSameRecording ? editor : RecordingEditor.init()),
    isPlanOpen: (isOpen) => isOpen && status.recording === null,
  });

  if (Option.isSome(model.presence) && samePresence(model.presence.value, presence)) {
    return { model: nextModel };
  }

  return {
    model: modifyFields(nextModel, { presence: () => Option.some(presence) }),
    commands: [ShowPresence({ presence })],
  };
};

const foldEditor = Update.foldChild({
  update: RecordingEditor.update,
  read: (model: Model) => Option.some(model.editor),
  write: (model, nextEditor) => modifyFields(model, { editor: () => nextEditor }),
  toParentMessage: (message) => Message.GotEditorMessage({ message }),
  foldOutMessage: RecordingEditor.OutMessage.match<Step>({
    SavedEdits: () => requestStatus,
  }),
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    TickedStatusPoll: () =>
      isAwaitingAnswer(model.statusRequests) ? { model } : requestStatus(model),

    SucceededFetchStatus: ({ request, status }) =>
      isNewerAnswer(model.statusRequests, request)
        ? withStatus(answerStatus(model, request), status)
        : { model },

    FailedFetchStatus: ({ request, reason }) =>
      isNewerAnswer(model.statusRequests, request)
        ? showNotice(unreachableNotice(reason))(answerStatus(model, request))
        : { model },

    CompletedShowPresence: () => ({ model }),

    ToggledPlan: ({ isOpen }) => ({ model: modifyFields(model, { isPlanOpen: () => isOpen }) }),

    UpdatedDraftTitle: ({ value }) => ({
      model: modifyFields(model, { draft: (draft) => modifyFields(draft, { title: () => value }) }),
    }),

    UpdatedDraftAgenda: ({ value }) => ({
      model: modifyFields(model, {
        draft: (draft) => modifyFields(draft, { agenda: () => value }),
      }),
    }),

    UpdatedDraftSummaryStyle: ({ value }) => ({
      model: modifyFields(model, {
        draft: (draft) => modifyFields(draft, { summaryStyle: () => summaryStyleOf(value) }),
      }),
    }),

    ClickedRecord: () => {
      if (runningOf(model) !== null) {
        return submit(model, { action: "stop" });
      }

      const plan = planOf(model.draft);

      return submit(model, {
        action: "start",
        title: plan.title,
        agenda: plan.agenda,
        summaryStyle: plan.summaryStyle,
      });
    },

    ClickedPause: () => {
      const running = runningOf(model);

      return running === null
        ? { model }
        : submit(model, { action: running.pause === null ? "pause" : "resume" });
    },

    CompletedSubmitRequest: ({ handled }) =>
      settle(
        handled?.outcome === "started" ? modifyFields(model, { draft: () => EMPTY_DRAFT }) : model,
        outcomeNotice(handled),
      ),

    FailedSubmitRequest: ({ reason }) => settle(model, unreachableNotice(reason)),

    CompletedWaitBeforeDismissal: ({ id }) =>
      Option.exists(model.notice, (shown) => shown.id === id)
        ? { model: modifyFields(model, { notice: () => Option.none() }) }
        : { model },

    GotEditorMessage: ({ message: editorMessage }) => foldEditor(model, editorMessage),
  });

export const pollInterval = (model: Model): number =>
  Duration.toMillis(runningOf(model) === null ? STATE_POLL : RECORDING_POLL);

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  pollStatus: entry(
    { intervalMs: Schema.Finite },
    {
      modelToDependencies: (model) => ({ intervalMs: pollInterval(model) }),
      dependenciesToStream: ({ intervalMs }) =>
        Stream.tick(Duration.millis(intervalMs)).pipe(Stream.map(Message.TickedStatusPoll)),
    },
  ),
}));

export interface ViewInputs {
  readonly now: number;
  readonly signIn: SignIn;
}

const peopleOf = (status: RecordingStatus | null): ReadonlyArray<Person> =>
  Array.map(status?.occupants ?? [], (occupant) => ({
    id: occupant.userId,
    name: occupant.displayName,
    avatarUrl: occupant.avatarUrl,
    isSpeaking: occupant.speaking,
  }));

const planView = (model: Model, h: HtmlBuilder<Message>): Html =>
  disclosure(h, {
    id: "plan",
    label: "Add a title and agenda",
    isOpen: model.isPlanOpen,
    onToggle: (isOpen) => Message.ToggledPlan({ isOpen }),
    children: [
      planFields(h, {
        idPrefix: "plan",
        draft: model.draft,
        isDisabled: model.isSubmitting,
        onTitle: (value) => Message.UpdatedDraftTitle({ value }),
        onAgenda: (value) => Message.UpdatedDraftAgenda({ value }),
        onSummaryStyle: (value) => Message.UpdatedDraftSummaryStyle({ value }),
      }),
    ],
  });

const editorView = (model: Model, running: RunningRecording, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: "running-recording-editor",
    model: model.editor,
    view: RecordingEditor.view,
    viewInputs: {
      idPrefix: "now-editor",
      recordingId: running.id,
      label: "Edit title and agenda",
      current: { title: running.title, agenda: running.agenda, summaryStyle: running.summaryStyle },
    },
    toParentMessage: (message) => Message.GotEditorMessage({ message }),
  });

const controlsView = (
  model: Model,
  running: RunningRecording | null,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("recorder-controls")],
    [
      recordButton(h, {
        isRecording: running !== null,
        isBusy: model.isSubmitting,
        isDisabled: !canPress(model),
        onPress: Message.ClickedRecord(),
      }),
      running === null
        ? h.empty
        : button(h, {
            label: [running.pause === null ? "Pause" : "Resume"],
            variant: "ghost",
            size: "lg",
            onClick: Message.ClickedPause(),
            isDisabled: !canPress(model),
            isBusy: model.isSubmitting,
          }),
    ],
  );

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const status = statusOf(model);
  const running = runningOf(model);
  const phase = describePhase(phaseOf(model, inputs.signIn), inputs.now);
  const inTheOffice = peopleOf(status);

  return card(h, [
    eyebrow(h, { text: "Recording" }),
    statusHeading(h, {
      heading: phase.heading,
      subheading: running?.title ?? null,
      description: phase.description,
      isLive: phase.live,
    }),
    running === null ? planView(model, h) : editorView(model, running, h),
    controlsView(model, running, h),
    noticeRegion(
      h,
      Option.map(model.notice, (shown) => shown.notice),
    ),
    ...(inTheOffice.length === 0
      ? []
      : [
          divider(h),
          people(h, {
            id: "in-the-office",
            people: inTheOffice,
            label: `In the office · ${inTheOffice.length}`,
          }),
        ]),
  ]);
});
