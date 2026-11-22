import { Duration, Effect, Option, Schema, Stream } from "effect";
import { button, card, description, eyebrow, notice, noticeRegion } from "design-system";
import { Command, Submodel, Subscription, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { ConsoleApi, reasonOf } from "../api/api.ts";
import * as ActionItems from "../edits/action-items.ts";
import * as RecordingEditor from "../edits/recording-editor.ts";
import * as SummaryRewrite from "../edits/summary-rewrite.ts";
import type { Resources } from "../resources.ts";
import { Session } from "../session/session.ts";
import { RecordingDetail, RecordingPage } from "office-domain/Recording";
import { isChanging } from "./describe-recording.ts";
import { EMPTY_HISTORY, HistoryList, withNewest, withOlder } from "./history-list.ts";
import { recordingPage } from "./recording-page.ts";
import { recordingRow } from "./recording-row.ts";

export const LIST_POLL = Duration.seconds(15);

export const RECORDING_POLL = Duration.seconds(5);

export const Opened = Schema.Struct({
  id: Schema.String,
  opening: Schema.Number,
  recording: Schema.Option(RecordingDetail),
  editor: RecordingEditor.Model,
  rewrite: SummaryRewrite.Model,
  actionItems: ActionItems.Model,
  requests: Schema.Number,
  applied: Schema.Number,
});

export type Opened = typeof Opened.Type;

export const Model = Schema.Struct({
  list: HistoryList,
  isLoaded: Schema.Boolean,
  isLoadingOlder: Schema.Boolean,
  opened: Schema.Option(Opened),
  failure: Schema.Option(Schema.String),
  listRequests: Schema.Number,
  listApplied: Schema.Number,
  openings: Schema.Number,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  list: EMPTY_HISTORY,
  isLoaded: false,
  isLoadingOlder: false,
  opened: Option.none(),
  failure: Option.none(),
  listRequests: 0,
  listApplied: 0,
  openings: 0,
});

const openedAt = (id: string, opening: number): Opened => ({
  id,
  opening,
  recording: Option.none(),
  editor: RecordingEditor.init(),
  rewrite: SummaryRewrite.init(),
  actionItems: ActionItems.init(),
  requests: 0,
  applied: 0,
});

export const Message = defineMessageUnion({
  TickedListPoll: {},
  SucceededFetchNewest: { request: Schema.Number, page: RecordingPage },
  FailedFetchNewest: { request: Schema.Number, reason: Schema.String },
  ClickedShowOlder: {},
  SucceededFetchOlder: { page: RecordingPage },
  FailedFetchOlder: { reason: Schema.String },
  ClickedRecording: { id: Schema.String },
  ClickedBack: {},
  TickedRecordingPoll: { id: Schema.String },
  SucceededFetchRecording: {
    opening: Schema.Number,
    request: Schema.Number,
    recording: RecordingDetail,
  },
  FailedFetchRecording: { opening: Schema.Number, request: Schema.Number, reason: Schema.String },
  ClickedOpenInSlack: { url: Schema.String },
  CompletedOpenInSlack: {},
  FailedOpenInSlack: { reason: Schema.String },
  GotEditorMessage: { id: Schema.String, message: RecordingEditor.Message },
  GotRewriteMessage: { id: Schema.String, message: SummaryRewrite.Message },
  GotActionItemsMessage: { id: Schema.String, message: ActionItems.Message },
});

export type Message = typeof Message.Type;

export const FetchNewest = Command.define("FetchNewest", {
  args: { request: Schema.Number },
  messages: [Message.SucceededFetchNewest, Message.FailedFetchNewest],
  execute: ({ request }) =>
    ConsoleApi.use((api) => api.history.recordings({ query: {} })).pipe(
      Effect.map((page) => Message.SucceededFetchNewest({ request, page })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchNewest({ request, reason: reasonOf(failure) })),
      ),
    ),
});

export const FetchOlder = Command.define("FetchOlder", {
  args: { before: Schema.DateTimeUtcFromString },
  messages: [Message.SucceededFetchOlder, Message.FailedFetchOlder],
  execute: ({ before }) =>
    ConsoleApi.use((api) => api.history.recordings({ query: { before } })).pipe(
      Effect.map((page) => Message.SucceededFetchOlder({ page })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchOlder({ reason: reasonOf(failure) })),
      ),
    ),
});

export const FetchRecording = Command.define("FetchRecording", {
  args: { id: Schema.String, opening: Schema.Number, request: Schema.Number },
  messages: [Message.SucceededFetchRecording, Message.FailedFetchRecording],
  execute: ({ id, opening, request }) =>
    ConsoleApi.use((api) => api.history.recording({ params: { id } })).pipe(
      Effect.map((recording) => Message.SucceededFetchRecording({ opening, request, recording })),
      Effect.catch((failure) =>
        Effect.succeed(
          Message.FailedFetchRecording({ opening, request, reason: reasonOf(failure) }),
        ),
      ),
    ),
});

export const OpenInSlack = Command.define("OpenInSlack", {
  args: { url: Schema.String },
  messages: [Message.CompletedOpenInSlack, Message.FailedOpenInSlack],
  execute: ({ url }) =>
    Session.use((session) => session.openExternalLink(url)).pipe(
      Effect.as(Message.CompletedOpenInSlack()),
      Effect.catchTag("LinkFailure", ({ reason }) =>
        Effect.succeed(Message.FailedOpenInSlack({ reason })),
      ),
    ),
});

type UpdateReturn = Update.Return<Model, Message, Resources>;

type Step = Update.Step<Model, Message, Resources>;

const requestList: Step = (model) => {
  const request = model.listRequests + 1;

  return {
    model: modifyFields(model, { listRequests: () => request }),
    commands: [FetchNewest({ request })],
  };
};

const writeOpened = (model: Model, write: (opened: Opened) => Opened): Model =>
  modifyFields(model, { opened: Option.map(write) });

const openedWith = (model: Model, id: string): Option.Option<Opened> =>
  Option.filter(model.opened, (opened) => opened.id === id);

const requestRecording: Step = (model) =>
  Option.match(model.opened, {
    onNone: () => ({ model }),
    onSome: (opened) => {
      const request = opened.requests + 1;

      return {
        model: writeOpened(model, (current) => ({ ...current, requests: request })),
        commands: [FetchRecording({ id: opened.id, opening: opened.opening, request })],
      };
    },
  });

const foldEditor = (id: string) =>
  Update.foldChild({
    update: RecordingEditor.update,
    read: (model: Model) => Option.map(openedWith(model, id), ({ editor }) => editor),
    write: (model, nextEditor) =>
      writeOpened(model, (opened) => ({ ...opened, editor: nextEditor })),
    toParentMessage: (message) => Message.GotEditorMessage({ id, message }),
    foldOutMessage: RecordingEditor.OutMessage.match<Step>({ SavedEdits: () => requestRecording }),
  });

const foldRewrite = (id: string) =>
  Update.foldChild({
    update: SummaryRewrite.update,
    read: (model: Model) => Option.map(openedWith(model, id), ({ rewrite }) => rewrite),
    write: (model, nextRewrite) =>
      writeOpened(model, (opened) => ({ ...opened, rewrite: nextRewrite })),
    toParentMessage: (message) => Message.GotRewriteMessage({ id, message }),
    foldOutMessage: SummaryRewrite.OutMessage.match<Step>({ SavedEdits: () => requestRecording }),
  });

const foldActionItems = (id: string) =>
  Update.foldChild({
    update: ActionItems.update,
    read: (model: Model) => Option.map(openedWith(model, id), ({ actionItems }) => actionItems),
    write: (model, nextActionItems) =>
      writeOpened(model, (opened) => ({ ...opened, actionItems: nextActionItems })),
    toParentMessage: (message) => Message.GotActionItemsMessage({ id, message }),
    foldOutMessage: ActionItems.OutMessage.match<Step>({ SavedEdits: () => requestRecording }),
  });

const isAnswerToCurrent = (model: Model, opening: number, request: number): boolean =>
  Option.exists(model.opened, (opened) => opened.opening === opening && request > opened.applied);

const appliedRecording = (model: Model, request: number): Model =>
  writeOpened(model, (opened) => ({ ...opened, applied: request }));

const failed = (model: Model, reason: string): Model =>
  modifyFields(model, { failure: () => Option.some(reason) });

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    TickedListPoll: () => (model.listRequests > model.listApplied ? { model } : requestList(model)),

    SucceededFetchNewest: ({ request, page }) =>
      request <= model.listApplied
        ? { model }
        : {
            model: modifyFields(model, {
              list: (list) => withNewest(list, page),
              isLoaded: () => true,
              listApplied: () => request,
              failure: (failure) => (Option.isNone(model.opened) ? Option.none() : failure),
            }),
          },

    FailedFetchNewest: ({ request, reason }) => {
      if (request <= model.listApplied) {
        return { model };
      }

      const nextModel = modifyFields(model, { listApplied: () => request });

      return { model: Option.isNone(model.opened) ? failed(nextModel, reason) : nextModel };
    },

    ClickedShowOlder: () => {
      const { older } = model.list;

      if (model.isLoadingOlder || older === null) {
        return { model };
      }

      return {
        model: modifyFields(model, { isLoadingOlder: () => true }),
        commands: [FetchOlder({ before: older })],
      };
    },

    SucceededFetchOlder: ({ page }) => ({
      model: modifyFields(model, {
        list: (list) => withOlder(list, page),
        isLoadingOlder: () => false,
        failure: () => Option.none(),
      }),
    }),

    FailedFetchOlder: ({ reason }) => ({
      model: failed(modifyFields(model, { isLoadingOlder: () => false }), reason),
    }),

    ClickedRecording: ({ id }) => {
      const opening = model.openings + 1;

      return {
        model: modifyFields(model, {
          opened: () => Option.some(openedAt(id, opening)),
          openings: () => opening,
          failure: () => Option.none(),
        }),
      };
    },

    ClickedBack: () => ({
      model: modifyFields(model, { opened: () => Option.none(), failure: () => Option.none() }),
    }),

    TickedRecordingPoll: ({ id }) =>
      Option.exists(openedWith(model, id), (opened) => opened.requests === opened.applied)
        ? requestRecording(model)
        : { model },

    SucceededFetchRecording: ({ opening, request, recording }) =>
      isAnswerToCurrent(model, opening, request)
        ? {
            model: modifyFields(
              writeOpened(appliedRecording(model, request), (opened) => ({
                ...opened,
                recording: Option.some(recording),
              })),
              { failure: () => Option.none() },
            ),
          }
        : { model },

    FailedFetchRecording: ({ opening, request, reason }) =>
      isAnswerToCurrent(model, opening, request)
        ? { model: failed(appliedRecording(model, request), reason) }
        : { model },

    ClickedOpenInSlack: ({ url }) => ({ model, commands: [OpenInSlack({ url })] }),

    CompletedOpenInSlack: () => ({ model }),

    FailedOpenInSlack: ({ reason }) => ({ model: failed(model, reason) }),

    GotEditorMessage: ({ id, message: editorMessage }) => foldEditor(id)(model, editorMessage),

    GotRewriteMessage: ({ id, message: rewriteMessage }) => foldRewrite(id)(model, rewriteMessage),

    GotActionItemsMessage: ({ id, message: actionItemsMessage }) =>
      foldActionItems(id)(model, actionItemsMessage),
  });

export const polledRecordingId = (model: Model): string | null =>
  Option.match(model.opened, {
    onNone: () => null,
    onSome: (opened) =>
      Option.match(opened.recording, {
        onNone: () => opened.id,
        onSome: (recording) => (isChanging(recording) ? opened.id : null),
      }),
  });

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  pollList: entry(
    { isListing: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isListing: Option.isNone(model.opened) }),
      dependenciesToStream: ({ isListing }) =>
        isListing ? Stream.tick(LIST_POLL).pipe(Stream.map(Message.TickedListPoll)) : Stream.empty,
    },
  ),
  pollRecording: entry(
    { recordingId: Schema.NullOr(Schema.String) },
    {
      modelToDependencies: (model) => ({ recordingId: polledRecordingId(model) }),
      dependenciesToStream: ({ recordingId }) =>
        recordingId === null
          ? Stream.empty
          : Stream.tick(RECORDING_POLL).pipe(
              Stream.map(() => Message.TickedRecordingPoll({ id: recordingId })),
            ),
    },
  ),
}));

export interface ViewInputs {
  readonly now: number;
}

const problemsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  noticeRegion(
    h,
    Option.match(model.failure, {
      onNone: () => [],
      onSome: (failure) => [
        notice(h, { kind: "error", text: `Couldn't load the recording history: ${failure}` }),
      ],
    }),
  );

const backButton = (h: HtmlBuilder<Message>): Html =>
  button(h, {
    label: ["← Back"],
    variant: "tertiary",
    onClick: Message.ClickedBack(),
    className: "align-start",
  });

const openedView = (model: Model, opened: Opened, now: number, h: HtmlBuilder<Message>): Html =>
  card(h, "lg", [
    ...Option.match(opened.recording, {
      onNone: () => [backButton(h), description(h, ["Loading the recording…"])],
      onSome: (recording) => [
        recordingPage(h, {
          recording,
          now,
          back: backButton(h),
          onOpenInSlack: (url) => Message.ClickedOpenInSlack({ url }),
          editor: h.submodel({
            slotId: "recording-editor",
            model: opened.editor,
            view: RecordingEditor.view,
            viewInputs: {
              idPrefix: "history-editor",
              recordingId: recording.id,
              label: "Edit",
              current: {
                title: recording.title,
                agenda: recording.agenda,
                summaryStyle: recording.summaryStyle,
              },
            },
            toParentMessage: (message) => Message.GotEditorMessage({ id: recording.id, message }),
          }),
          rewrite: h.submodel({
            slotId: "summary-rewrite",
            model: opened.rewrite,
            view: SummaryRewrite.view,
            viewInputs: { recordingId: recording.id, isRewriting: recording.rewriting },
            toParentMessage: (message) => Message.GotRewriteMessage({ id: recording.id, message }),
          }),
          actionItems: h.submodel({
            slotId: "action-items",
            model: opened.actionItems,
            view: ActionItems.view,
            viewInputs: {
              recordingId: recording.id,
              items: recording.actionItems,
              members: recording.members,
            },
            toParentMessage: (message) =>
              Message.GotActionItemsMessage({ id: recording.id, message }),
          }),
        }),
      ],
    }),
    problemsView(model, h),
  ]);

const listView = (model: Model, now: number, h: HtmlBuilder<Message>): Html =>
  card(h, "lg", [
    eyebrow(h, { text: "Recording history", tone: "muted" }),
    h.ul(
      [h.Class("recordings")],
      model.list.recordings.length === 0 && model.isLoaded
        ? [h.li([h.Class("text-body-sm pb-description")], ["Nothing has been recorded yet."])]
        : model.list.recordings.map((recording) =>
            h.keyed("li")(
              recording.id,
              [],
              [
                recordingRow(h, {
                  recording,
                  now,
                  onOpen: Message.ClickedRecording({ id: recording.id }),
                }),
              ],
            ),
          ),
    ),
    model.list.older === null
      ? h.empty
      : button(h, {
          label: ["Show older"],
          variant: "ghost",
          isFullWidth: true,
          isDisabled: model.isLoadingOlder,
          onClick: Message.ClickedShowOlder(),
        }),
    problemsView(model, h),
  ]);

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  Option.match(model.opened, {
    onSome: (opened) => openedView(model, opened, inputs.now, h),
    onNone: () =>
      model.isLoaded || Option.isSome(model.failure) ? listView(model, inputs.now, h) : h.empty,
  }),
);
