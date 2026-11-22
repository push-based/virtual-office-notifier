import { Effect, Option, Schema } from "effect";
import { Command, Submodel, type Update } from "foldkit";
import { button, NoticeContent, noticeRegion } from "design-system";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { reasonOf } from "../api/api.ts";
import type { Resources } from "../resources.ts";
import { RecordingChange } from "office-domain/RecordingEdit";
import { planFields } from "./plan-fields.ts";
import { changesBetween, Draft, draftOf, Plan, summaryStyleOf } from "./plan.ts";
import { answered, failedSave, isSaving, noticeOf, SaveState, saveChanges } from "./save.ts";

export const Model = Schema.Struct({
  draft: Schema.Option(Draft),
  save: SaveState,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  draft: Option.none(),
  save: SaveState.Idle(),
});

export const Message = defineMessageUnion({
  ClickedEdit: { current: Plan },
  UpdatedTitle: { value: Schema.String },
  UpdatedAgenda: { value: Schema.String },
  UpdatedSummaryStyle: { value: Schema.String },
  ClickedSave: { recordingId: Schema.String, current: Plan },
  ClickedCancel: {},
  CompletedSaveEdits: { notice: Schema.Option(NoticeContent) },
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
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedSaveEdits({ reason: reasonOf(failure) })),
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
      if (isSaving(model.save) || Option.isNone(model.draft)) {
        return { model };
      }

      const changes = changesBetween(current, model.draft.value);

      if (changes.length === 0) {
        return {
          model: modifyFields(model, { draft: () => Option.none(), save: () => SaveState.Idle() }),
          outMessage: OutMessage.SavedEdits(),
        };
      }

      return {
        model: modifyFields(model, { save: () => SaveState.Saving() }),
        commands: [SaveEdits({ recordingId, changes })],
      };
    },

    ClickedCancel: () => ({ model: modifyFields(model, { draft: () => Option.none() }) }),

    CompletedSaveEdits: ({ notice: shown }) => ({
      model: modifyFields(model, { draft: () => Option.none(), save: () => answered(shown) }),
      outMessage: OutMessage.SavedEdits(),
    }),

    FailedSaveEdits: ({ reason }) => ({
      model: modifyFields(model, { save: () => failedSave(reason) }),
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
    isDisabled: isSaving(model.save),
    onTitle: (value) => Message.UpdatedTitle({ value }),
    onAgenda: (value) => Message.UpdatedAgenda({ value }),
    onSummaryStyle: (value) => Message.UpdatedSummaryStyle({ value }),
  }),
  h.div(
    [h.Class("editor-actions")],
    [
      button(h, {
        label: [isSaving(model.save) ? "Saving…" : "Save"],
        onClick: Message.ClickedSave({ recordingId: inputs.recordingId, current: inputs.current }),
        isDisabled: isSaving(model.save),
        isBusy: isSaving(model.save),
      }),
      button(h, {
        label: ["Cancel"],
        variant: "ghost",
        onClick: Message.ClickedCancel(),
        isDisabled: isSaving(model.save),
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
      noticeRegion(h, noticeOf(model.save)),
    ],
  ),
);
