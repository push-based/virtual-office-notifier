import { Duration, Effect, Option, Schema, Stream } from "effect";
import { button, card, description, eyebrow, notice, noticeRegion } from "design-system";
import { Command, Submodel, Subscription, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import * as Api from "../api/api.ts";
import * as ActionItems from "../edits/action-items.ts";
import * as RecordingEditor from "../edits/recording-editor.ts";
import * as SummaryRewrite from "../edits/summary-rewrite.ts";
import type { Resources } from "../resources.ts";
import { Session } from "../session/session.ts";
import { RecordingDetail, RecordingPage } from "../wire.ts";
import { isChanging } from "./describe-recording.ts";
import { EMPTY_HISTORY, HistoryList, withNewest, withOlder } from "./history-list.ts";
import { recordingPage } from "./recording-page.ts";
import { recordingRow } from "./recording-row.ts";

export const LIST_POLL = Duration.seconds(15);

export const RECORDING_POLL = Duration.seconds(5);

export const Opened = Schema.Struct({
  id: Schema.String,
  recording: Schema.Option(RecordingDetail),
  editor: RecordingEditor.Model,
  rewrite: SummaryRewrite.Model,
  actionItems: ActionItems.Model,
});

export type Opened = typeof Opened.Type;

export const Model = Schema.Struct({
  list: HistoryList,
  isLoaded: Schema.Boolean,
  isLoadingOlder: Schema.Boolean,
  opened: Schema.Option(Opened),
  failure: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  list: EMPTY_HISTORY,
  isLoaded: false,
  isLoadingOlder: false,
  opened: Option.none(),
  failure: Option.none(),
});

const openedAt = (id: string): Opened => ({
  id,
  recording: Option.none(),
  editor: RecordingEditor.init(),
  rewrite: SummaryRewrite.init(),
  actionItems: ActionItems.init(),
});

export const Message = defineMessageUnion({
  TickedListPoll: {},
  SucceededFetchNewest: { page: RecordingPage },
  ClickedShowOlder: {},
  SucceededFetchOlder: { page: RecordingPage },
  FailedFetchOlder: { reason: Schema.String },
  ClickedRecording: { id: Schema.String },
  ClickedBack: {},
  TickedRecordingPoll: { id: Schema.String },
  SucceededFetchRecording: { recording: RecordingDetail },
  FailedFetchHistory: { reason: Schema.String },
  ClickedOpenInSlack: { url: Schema.String },
  CompletedOpenInSlack: {},
  FailedOpenInSlack: { reason: Schema.String },
  GotEditorMessage: { message: RecordingEditor.Message },
  GotRewriteMessage: { message: SummaryRewrite.Message },
  GotActionItemsMessage: { message: ActionItems.Message },
});

export type Message = typeof Message.Type;

const failedFetch = ({ reason }: Api.ApiFailure) =>
  Effect.succeed(Message.FailedFetchHistory({ reason }));

export const FetchNewest = Command.define("FetchNewest", {
  messages: [Message.SucceededFetchNewest, Message.FailedFetchHistory],
  execute: Api.get("/api/recordings", RecordingPage).pipe(
    Effect.map((page) => Message.SucceededFetchNewest({ page })),
    Effect.catchTag("ApiFailure", failedFetch),
  ),
});

export const FetchOlder = Command.define("FetchOlder", {
  args: { before: Schema.String },
  messages: [Message.SucceededFetchOlder, Message.FailedFetchOlder],
  execute: ({ before }) =>
    Api.get("/api/recordings", RecordingPage, { before }).pipe(
      Effect.map((page) => Message.SucceededFetchOlder({ page })),
      Effect.catchTag("ApiFailure", ({ reason }) =>
        Effect.succeed(Message.FailedFetchOlder({ reason })),
      ),
    ),
});

export const FetchRecording = Command.define("FetchRecording", {
  args: { id: Schema.String },
  messages: [Message.SucceededFetchRecording, Message.FailedFetchHistory],
  execute: ({ id }) =>
    Api.get(`/api/recordings/${encodeURIComponent(id)}`, RecordingDetail).pipe(
      Effect.map((recording) => Message.SucceededFetchRecording({ recording })),
      Effect.catchTag("ApiFailure", failedFetch),
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

const refetchOpened: Step = (model) => ({
  model,
  commands: Option.match(model.opened, {
    onNone: () => [],
    onSome: ({ id }) => [FetchRecording({ id })],
  }),
});

const writeOpened = (model: Model, write: (opened: Opened) => Opened): Model =>
  modifyFields(model, { opened: Option.map(write) });

const foldEditor = Update.foldChild({
  update: RecordingEditor.update,
  read: (model: Model) => Option.map(model.opened, ({ editor }) => editor),
  write: (model, nextEditor) => writeOpened(model, (opened) => ({ ...opened, editor: nextEditor })),
  toParentMessage: (message) => Message.GotEditorMessage({ message }),
  foldOutMessage: RecordingEditor.OutMessage.match<Step>({ SavedEdits: () => refetchOpened }),
});

const foldRewrite = Update.foldChild({
  update: SummaryRewrite.update,
  read: (model: Model) => Option.map(model.opened, ({ rewrite }) => rewrite),
  write: (model, nextRewrite) =>
    writeOpened(model, (opened) => ({ ...opened, rewrite: nextRewrite })),
  toParentMessage: (message) => Message.GotRewriteMessage({ message }),
  foldOutMessage: SummaryRewrite.OutMessage.match<Step>({ SavedEdits: () => refetchOpened }),
});

const foldActionItems = Update.foldChild({
  update: ActionItems.update,
  read: (model: Model) => Option.map(model.opened, ({ actionItems }) => actionItems),
  write: (model, nextActionItems) =>
    writeOpened(model, (opened) => ({ ...opened, actionItems: nextActionItems })),
  toParentMessage: (message) => Message.GotActionItemsMessage({ message }),
  foldOutMessage: ActionItems.OutMessage.match<Step>({ SavedEdits: () => refetchOpened }),
});

const failed = (model: Model, reason: string): Model =>
  modifyFields(model, { failure: () => Option.some(reason) });

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    TickedListPoll: () => ({ model, commands: [FetchNewest()] }),

    SucceededFetchNewest: ({ page }) => ({
      model: modifyFields(model, {
        list: (list) => withNewest(list, page),
        isLoaded: () => true,
        failure: () => Option.none(),
      }),
    }),

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

    ClickedRecording: ({ id }) => ({
      model: modifyFields(model, {
        opened: () => Option.some(openedAt(id)),
        failure: () => Option.none(),
      }),
    }),

    ClickedBack: () => ({
      model: modifyFields(model, { opened: () => Option.none(), failure: () => Option.none() }),
    }),

    TickedRecordingPoll: ({ id }) => ({ model, commands: [FetchRecording({ id })] }),

    SucceededFetchRecording: ({ recording }) => ({
      model: modifyFields(
        writeOpened(model, (opened) =>
          opened.id === recording.id ? { ...opened, recording: Option.some(recording) } : opened,
        ),
        { failure: () => Option.none() },
      ),
    }),

    FailedFetchHistory: ({ reason }) => ({ model: failed(model, reason) }),

    ClickedOpenInSlack: ({ url }) => ({ model, commands: [OpenInSlack({ url })] }),

    CompletedOpenInSlack: () => ({ model }),

    FailedOpenInSlack: ({ reason }) => ({ model: failed(model, reason) }),

    GotEditorMessage: ({ message: editorMessage }) => foldEditor(model, editorMessage),

    GotRewriteMessage: ({ message: rewriteMessage }) => foldRewrite(model, rewriteMessage),

    GotActionItemsMessage: ({ message: actionItemsMessage }) =>
      foldActionItems(model, actionItemsMessage),
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
              recordingId: recording.id,
              label: "Edit",
              current: {
                title: recording.title,
                agenda: recording.agenda,
                summaryStyle: recording.summaryStyle,
              },
            },
            toParentMessage: (message) => Message.GotEditorMessage({ message }),
          }),
          rewrite: h.submodel({
            slotId: "summary-rewrite",
            model: opened.rewrite,
            view: SummaryRewrite.view,
            viewInputs: { recordingId: recording.id, isRewriting: recording.rewriting },
            toParentMessage: (message) => Message.GotRewriteMessage({ message }),
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
            toParentMessage: (message) => Message.GotActionItemsMessage({ message }),
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
