import { Effect, Schema } from "effect";
import { button, NoticeContent, noticeRegion } from "design-system";
import { Command, Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { reasonOf } from "../api/api.ts";
import type { Resources } from "../resources.ts";
import { answered, failedSave, isSaving, noticeOf, SaveState, saveChanges } from "./save.ts";

export const Model = Schema.Struct({ save: SaveState });

export type Model = typeof Model.Type;

export const init = (): Model => ({ save: SaveState.Idle() });

export const Message = defineMessageUnion({
  ClickedRewrite: { recordingId: Schema.String },
  CompletedRewriteSummary: { notice: Schema.Option(NoticeContent) },
  FailedRewriteSummary: { reason: Schema.String },
});

export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  SavedEdits: {},
});

export type OutMessage = typeof OutMessage.Type;

export const RewriteSummary = Command.define("RewriteSummary", {
  args: { recordingId: Schema.String },
  messages: [Message.CompletedRewriteSummary, Message.FailedRewriteSummary],
  execute: ({ recordingId }) =>
    saveChanges(recordingId, [{ kind: "rewrite_summary" }]).pipe(
      Effect.map((shown) => Message.CompletedRewriteSummary({ notice: shown })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedRewriteSummary({ reason: reasonOf(failure) })),
      ),
    ),
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>>(message, {
    ClickedRewrite: ({ recordingId }) =>
      isSaving(model.save)
        ? { model }
        : {
            model: modifyFields(model, { save: () => SaveState.Saving() }),
            commands: [RewriteSummary({ recordingId })],
          },

    CompletedRewriteSummary: ({ notice: shown }) => ({
      model: modifyFields(model, { save: () => answered(shown) }),
      outMessage: OutMessage.SavedEdits(),
    }),

    FailedRewriteSummary: ({ reason }) => ({
      model: modifyFields(model, { save: () => failedSave(reason) }),
    }),
  });

export interface ViewInputs {
  readonly recordingId: string;
  readonly isRewriting: boolean;
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const isBusy = isSaving(model.save) || inputs.isRewriting;

  return h.div(
    [h.Class("editor")],
    [
      button(h, {
        label: [isBusy ? "Rewriting…" : "Rewrite summary"],
        variant: "ghost",
        onClick: Message.ClickedRewrite({ recordingId: inputs.recordingId }),
        isDisabled: isBusy,
        isBusy,
        className: "align-start",
      }),
      noticeRegion(h, noticeOf(model.save)),
    ],
  );
});
