import { Array, Duration, Effect, Option, Schema, Stream } from "effect";
import { button, card, description, descriptionItem, eyebrow, noticeRegion } from "design-system";
import { AsyncData, Command, Submodel, Subscription, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { ConsoleApi, reasonOf } from "../api/api.ts";
import {
  ignoreSentRequests,
  isAwaitingAnswer,
  isNewerAnswer,
  NO_REQUESTS,
  recordAnswer,
  RequestCount,
  sendRequest,
} from "../api/request-count.ts";
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

const LIST_POLL = Duration.seconds(15);

export const RECORDING_POLL = Duration.seconds(5);

const ListData = AsyncData.Schema(HistoryList, Schema.String);

const RecordingData = AsyncData.Schema(RecordingDetail, Schema.String);

export const Opened = Schema.Struct({
  id: Schema.String,
  recording: RecordingData.schema,
  editor: RecordingEditor.Model,
  rewrite: SummaryRewrite.Model,
  actionItems: ActionItems.Model,
});

export type Opened = typeof Opened.Type;

export const Model = Schema.Struct({
  list: ListData.schema,
  isFetchingNewest: Schema.Boolean,
  isLoadingOlder: Schema.Boolean,
  opened: Schema.Option(Opened),
  recordingRequests: RequestCount,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  list: ListData.Idle(),
  isFetchingNewest: false,
  isLoadingOlder: false,
  opened: Option.none(),
  recordingRequests: NO_REQUESTS,
});

const openedAt = (id: string): Opened => ({
  id,
  recording: RecordingData.Loading(),
  editor: RecordingEditor.init(),
  rewrite: SummaryRewrite.init(),
  actionItems: ActionItems.init(),
});

export const Message = defineMessageUnion({
  TickedListPoll: {},
  SucceededFetchNewest: { page: RecordingPage },
  FailedFetchNewest: { reason: Schema.String },
  ClickedShowOlder: {},
  SucceededFetchOlder: { page: RecordingPage },
  FailedFetchOlder: { reason: Schema.String },
  ClickedRecording: { id: Schema.String },
  ClickedBack: {},
  TickedRecordingPoll: { id: Schema.String },
  SucceededFetchRecording: { request: Schema.Finite, recording: RecordingDetail },
  FailedFetchRecording: { request: Schema.Finite, reason: Schema.String },
  ClickedOpenInSlack: { url: Schema.String },
  CompletedOpenInSlack: {},
  FailedOpenInSlack: { reason: Schema.String },
  GotEditorMessage: { id: Schema.String, message: RecordingEditor.Message },
  GotRewriteMessage: { id: Schema.String, message: SummaryRewrite.Message },
  GotActionItemsMessage: { id: Schema.String, message: ActionItems.Message },
});

export type Message = typeof Message.Type;

export const FetchNewest = Command.define("FetchNewest", {
  messages: [Message.SucceededFetchNewest, Message.FailedFetchNewest],
  execute: ConsoleApi.use((api) => api.history.recordings({ query: {} })).pipe(
    Effect.map((page) => Message.SucceededFetchNewest({ page })),
    Effect.catch((failure) =>
      Effect.succeed(Message.FailedFetchNewest({ reason: reasonOf(failure) })),
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
  args: { id: Schema.String, request: Schema.Finite },
  messages: [Message.SucceededFetchRecording, Message.FailedFetchRecording],
  execute: ({ id, request }) =>
    ConsoleApi.use((api) => api.history.recording({ params: { id } })).pipe(
      Effect.map((recording) => Message.SucceededFetchRecording({ request, recording })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchRecording({ request, reason: reasonOf(failure) })),
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

const failedWith = <A>(data: AsyncData.AsyncData<A, string>, reason: string) =>
  Option.match(AsyncData.getData(data), {
    onNone: () => AsyncData.fail<string, A>(reason),
    onSome: (kept) => AsyncData.Stale({ data: kept, error: reason }),
  });

const withoutError = (list: Model["list"]): Model["list"] =>
  Option.match(AsyncData.getData(list), {
    onNone: () => ListData.Idle(),
    onSome: (data) => ListData.Success({ data }),
  });

const listOf = (model: Model): HistoryList =>
  Option.getOrElse(AsyncData.getData(model.list), () => EMPTY_HISTORY);

const openedWith = (model: Model, id: string): Option.Option<Opened> =>
  Option.filter(model.opened, (opened) => opened.id === id);

const writeOpened = (model: Model, write: (opened: Opened) => Opened): Model =>
  modifyFields(model, { opened: Option.map(write) });

const writeOpenedWith = (model: Model, id: string, write: (opened: Opened) => Opened): Model =>
  writeOpened(model, (opened) => (opened.id === id ? write(opened) : opened));

const requestRecording: Step = (model) =>
  Option.match(model.opened, {
    onNone: () => ({ model }),
    onSome: (opened) => {
      const recordingRequests = sendRequest(model.recordingRequests);

      return {
        model: modifyFields(model, { recordingRequests: () => recordingRequests }),
        commands: [FetchRecording({ id: opened.id, request: recordingRequests.sent })],
      };
    },
  });

const answerRecording = (
  model: Model,
  request: number,
  write: (recording: Opened["recording"]) => Opened["recording"],
): UpdateReturn =>
  Option.isSome(model.opened) && isNewerAnswer(model.recordingRequests, request)
    ? {
        model: modifyFields(
          writeOpened(model, (opened) => ({ ...opened, recording: write(opened.recording) })),
          {
            recordingRequests: (count) => recordAnswer(count, request),
          },
        ),
      }
    : { model };

const foldEditorOutMessage = () =>
  RecordingEditor.OutMessage.match<Step>({ SavedEdits: () => requestRecording });

const foldEditor = Update.foldChildAt({
  update: RecordingEditor.update,
  readAt: (model: Model, id: string) => Option.map(openedWith(model, id), ({ editor }) => editor),
  writeAt: (model, id, nextEditor) =>
    writeOpenedWith(model, id, (opened) => ({ ...opened, editor: nextEditor })),
  toParentMessage: (id, message) => Message.GotEditorMessage({ id, message }),
  foldOutMessage: foldEditorOutMessage,
});

const foldRewriteOutMessage = () =>
  SummaryRewrite.OutMessage.match<Step>({ SavedEdits: () => requestRecording });

const foldRewrite = Update.foldChildAt({
  update: SummaryRewrite.update,
  readAt: (model: Model, id: string) => Option.map(openedWith(model, id), ({ rewrite }) => rewrite),
  writeAt: (model, id, nextRewrite) =>
    writeOpenedWith(model, id, (opened) => ({ ...opened, rewrite: nextRewrite })),
  toParentMessage: (id, message) => Message.GotRewriteMessage({ id, message }),
  foldOutMessage: foldRewriteOutMessage,
});

const foldActionItemsOutMessage = () =>
  ActionItems.OutMessage.match<Step>({ SavedEdits: () => requestRecording });

const foldActionItems = Update.foldChildAt({
  update: ActionItems.update,
  readAt: (model: Model, id: string) =>
    Option.map(openedWith(model, id), ({ actionItems }) => actionItems),
  writeAt: (model, id, nextActionItems) =>
    writeOpenedWith(model, id, (opened) => ({ ...opened, actionItems: nextActionItems })),
  toParentMessage: (id, message) => Message.GotActionItemsMessage({ id, message }),
  foldOutMessage: foldActionItemsOutMessage,
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    TickedListPoll: () =>
      model.isFetchingNewest
        ? { model }
        : {
            model: modifyFields(model, { isFetchingNewest: () => true }),
            commands: [FetchNewest()],
          },

    SucceededFetchNewest: ({ page }) => ({
      model: modifyFields(model, {
        list: () => ListData.Success({ data: withNewest(listOf(model), page) }),
        isFetchingNewest: () => false,
      }),
    }),

    FailedFetchNewest: ({ reason }) => ({
      model: modifyFields(model, {
        list: (list) => failedWith(list, reason),
        isFetchingNewest: () => false,
      }),
    }),

    ClickedShowOlder: () => {
      const { older } = listOf(model);

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
        list: () => ListData.Success({ data: withOlder(listOf(model), page) }),
        isLoadingOlder: () => false,
      }),
    }),

    FailedFetchOlder: ({ reason }) => ({
      model: modifyFields(model, {
        list: (list) => failedWith(list, reason),
        isLoadingOlder: () => false,
      }),
    }),

    ClickedRecording: ({ id }) => ({
      model: modifyFields(model, {
        opened: () => Option.some(openedAt(id)),
        recordingRequests: ignoreSentRequests,
      }),
    }),

    ClickedBack: () => ({
      model: modifyFields(model, { opened: () => Option.none(), list: withoutError }),
    }),

    TickedRecordingPoll: ({ id }) =>
      Option.isSome(openedWith(model, id)) && !isAwaitingAnswer(model.recordingRequests)
        ? requestRecording(model)
        : { model },

    SucceededFetchRecording: ({ request, recording }) =>
      answerRecording(model, request, () => RecordingData.Success({ data: recording })),

    FailedFetchRecording: ({ request, reason }) =>
      answerRecording(model, request, (current) => failedWith(current, reason)),

    ClickedOpenInSlack: ({ url }) => ({ model, commands: [OpenInSlack({ url })] }),

    CompletedOpenInSlack: () => ({ model }),

    FailedOpenInSlack: ({ reason }) => ({
      model: Option.isSome(model.opened)
        ? writeOpened(model, (opened) => ({
            ...opened,
            recording: failedWith(opened.recording, reason),
          }))
        : modifyFields(model, { list: (list) => failedWith(list, reason) }),
    }),

    GotEditorMessage: ({ id, message: editorMessage }) => foldEditor(model, id, editorMessage),

    GotRewriteMessage: ({ id, message: rewriteMessage }) => foldRewrite(model, id, rewriteMessage),

    GotActionItemsMessage: ({ id, message: actionItemsMessage }) =>
      foldActionItems(model, id, actionItemsMessage),
  });

export const polledRecordingId = (model: Model): string | null =>
  Option.match(model.opened, {
    onNone: () => null,
    onSome: (opened) =>
      Option.match(AsyncData.getData(opened.recording), {
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

const problemsView = <A>(data: AsyncData.AsyncData<A, string>, h: HtmlBuilder<Message>): Html =>
  noticeRegion(
    h,
    Option.map(AsyncData.getError(data), (failure) => ({
      kind: "error",
      text: `Couldn't load the recording history: ${failure}`,
    })),
  );

const backButton = (h: HtmlBuilder<Message>): Html =>
  button(h, {
    label: ["← Back"],
    variant: "tertiary",
    onClick: Message.ClickedBack(),
    className: "align-start",
  });

const openedView = (opened: Opened, now: number, h: HtmlBuilder<Message>): Html =>
  card(h, [
    ...Option.match(AsyncData.getData(opened.recording), {
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
    problemsView(opened.recording, h),
  ]);

const listView = (model: Model, list: HistoryList, now: number, h: HtmlBuilder<Message>): Html =>
  card(h, [
    eyebrow(h, { text: "Recording history", tone: "muted" }),
    h.ul(
      [h.Class("recordings")],
      Option.exists(AsyncData.getData(model.list), ({ recordings }) => recordings.length === 0)
        ? [descriptionItem(h, ["Nothing has been recorded yet."])]
        : Array.map(list.recordings, (recording) =>
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
    list.older === null
      ? h.empty
      : button(h, {
          label: ["Show older"],
          variant: "ghost",
          isFullWidth: true,
          isDisabled: model.isLoadingOlder,
          onClick: Message.ClickedShowOlder(),
        }),
    problemsView(model.list, h),
  ]);

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  Option.match(model.opened, {
    onSome: (opened) => openedView(opened, inputs.now, h),
    onNone: () =>
      AsyncData.isIdle(model.list) ? h.empty : listView(model, listOf(model), inputs.now, h),
  }),
);
