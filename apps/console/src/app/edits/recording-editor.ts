import { Effect, Option, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { button, notice, noticeRegion } from "design-system";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { Notice } from "../notice.ts";
import { unreachableNotice } from "../recorder/notices.ts";
import type { Resources } from "../resources.ts";
import { RecordingChange } from "../wire.ts";
import { planFields } from "./plan-fields.ts";
import { changesBetween, Draft, draftOf, Plan, summaryStyleOf } from "./plan.ts";
import { saveChanges } from "./save.ts";

export const Model = Schema.Struct({
  draft: Schema.Option(Draft),
  isSaving: Schema.Boolean,
  notice: Schema.Option(Notice),
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  draft: Option.none(),
  isSaving: false,
  notice: Option.none(),
});

export const Message = defineMessageUnion({
  ClickedEdit: { current: Plan },
  UpdatedTitle: { value: Schema.String },
  UpdatedAgenda: { value: Schema.String },
  UpdatedSummaryStyle: { value: Schema.String },
  ClickedSave: { recordingId: Schema.String, current: Plan },
  ClickedCancel: {},
  CompletedSaveEdits: { notice: Schema.Option(Notice) },
  FailedSaveEdits: { reason: Schema.String },
});

export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  SavedEdits: {},
});

export type OutMessage = typeof OutMessage.Type;

export const SaveEdits = Command.define("SaveEdits", {
  args: { recordingId: Schema.String, changes: Schema.Array(RecordingChange) },
  messages: [Message.CompletedSaveEdits, Message.FailedSaveEdits],
  execute: ({ recordingId, changes }) =>
    saveChanges(recordingId, changes).pipe(
      Effect.map((shown) => Message.CompletedSaveEdits({ notice: shown })),
      Effect.catchTag("ApiFailure", ({ reason }) =>
        Effect.succeed(Message.FailedSaveEdits({ reason })),
      ),
    ),
});

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>;

const editDraft = (model: Model, edit: (draft: Draft) => Draft): UpdateReturn => ({
  model: modifyFields(model, { draft: Option.map(edit) }),
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedEdit: ({ current }) => ({
      model: modifyFields(model, { draft: () => Option.some(draftOf(current)) }),
    }),

    UpdatedTitle: ({ value }) => editDraft(model, (draft) => ({ ...draft, title: value })),

    UpdatedAgenda: ({ value }) => editDraft(model, (draft) => ({ ...draft, agenda: value })),

    UpdatedSummaryStyle: ({ value }) =>
      editDraft(model, (draft) => ({ ...draft, summaryStyle: summaryStyleOf(value) })),

    ClickedSave: ({ recordingId, current }) => {
      if (model.isSaving || Option.isNone(model.draft)) {
        return { model };
      }

      const changes = changesBetween(current, model.draft.value);

      if (changes.length === 0) {
        return {
          model: modifyFields(model, { draft: () => Option.none(), notice: () => Option.none() }),
          outMessage: OutMessage.SavedEdits(),
        };
      }

      return {
        model: modifyFields(model, { isSaving: () => true, notice: () => Option.none() }),
        commands: [SaveEdits({ recordingId, changes })],
      };
    },

    ClickedCancel: () => ({ model: modifyFields(model, { draft: () => Option.none() }) }),

    CompletedSaveEdits: ({ notice: shown }) => ({
      model: modifyFields(model, {
        isSaving: () => false,
        draft: () => Option.none(),
        notice: () => shown,
      }),
      outMessage: OutMessage.SavedEdits(),
    }),

    FailedSaveEdits: ({ reason }) => ({
      model: modifyFields(model, {
        isSaving: () => false,
        notice: () => Option.some(unreachableNotice(reason)),
      }),
    }),
  });

export interface ViewInputs {
  readonly idPrefix: string;
  readonly recordingId: string;
  readonly current: Plan;
  readonly label: string;
}

const formView = (
  model: Model,
  draft: Draft,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  planFields(h, {
    idPrefix: `${inputs.idPrefix}-${inputs.recordingId}`,
    draft,
    isDisabled: model.isSaving,
    onTitle: (value) => Message.UpdatedTitle({ value }),
    onAgenda: (value) => Message.UpdatedAgenda({ value }),
    onSummaryStyle: (value) => Message.UpdatedSummaryStyle({ value }),
  }),
  h.div(
    [h.Class("editor-actions")],
    [
      button(h, {
        label: [model.isSaving ? "Saving…" : "Save"],
        onClick: Message.ClickedSave({ recordingId: inputs.recordingId, current: inputs.current }),
        isDisabled: model.isSaving,
        isBusy: model.isSaving,
      }),
      button(h, {
        label: ["Cancel"],
        variant: "ghost",
        onClick: Message.ClickedCancel(),
        isDisabled: model.isSaving,
      }),
    ],
  ),
];

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class("editor")],
    [
      ...Option.match(model.draft, {
        onNone: () => [
          button(h, {
            label: [inputs.label],
            variant: "ghost",
            onClick: Message.ClickedEdit({ current: inputs.current }),
            className: "align-start",
          }),
        ],
        onSome: (draft) => formView(model, draft, inputs, h),
      }),
      noticeRegion(
        h,
        Option.match(model.notice, { onNone: () => [], onSome: (shown) => [notice(h, shown)] }),
      ),
    ],
  ),
);
