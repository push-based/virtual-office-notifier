import { Array, Effect, Schema } from "effect";
import {
  avatar,
  checkbox,
  checkboxLabel,
  description,
  descriptionItem,
  eyebrow,
  inlineSelect,
  noticeRegion,
  type SelectOption,
  NoticeContent,
} from "design-system";
import { Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { reasonOf } from "../api/api.ts";
import type { Resources } from "../resources.ts";
import { ActionItem, type OfficeMember } from "office-domain/Recording";
import { RecordingChange } from "office-domain/RecordingEdit";
import { answered, failedSave, isSaving, noticeOf, SaveState, saveChanges } from "./save.ts";

export const NO_ACTION_ITEMS = "No action items could be pulled out.";

export const NONE_TAKEN_ON = "Nobody took anything on.";

const UNASSIGNED = "Unassigned";

export const tickOf = (item: ActionItem): RecordingChange => ({
  kind: item.done ? "untick" : "tick",
  item: item.id,
});

export const reassignOf = (item: ActionItem, chosen: string): ReadonlyArray<RecordingChange> => {
  const owner = chosen === "" ? null : chosen;

  return owner === (item.owner?.userId ?? null) ? [] : [{ kind: "reassign", item: item.id, owner }];
};

const ownerChoices = (
  members: ReadonlyArray<OfficeMember>,
  owner: OfficeMember | null,
): ReadonlyArray<OfficeMember> =>
  owner === null || Array.some(members, ({ userId }) => userId === owner.userId)
    ? members
    : [owner, ...members];

const ownerOptions = (
  members: ReadonlyArray<OfficeMember>,
  owner: OfficeMember | null,
): ReadonlyArray<SelectOption> => [
  { value: "", label: UNASSIGNED },
  ...Array.map(ownerChoices(members, owner), (member) => ({
    value: member.userId,
    label: member.name,
  })),
];

export const Model = Schema.Struct({ save: SaveState });

export type Model = typeof Model.Type;

export const init = (): Model => ({ save: SaveState.Idle() });

export const Message = defineMessageUnion({
  ToggledItem: { recordingId: Schema.String, item: ActionItem },
  ChoseOwner: { recordingId: Schema.String, item: ActionItem, chosen: Schema.String },
  CompletedSaveActionItems: { notice: Schema.Option(NoticeContent) },
  FailedSaveActionItems: { reason: Schema.String },
});

export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  SavedEdits: {},
});

export type OutMessage = typeof OutMessage.Type;

export const SaveActionItems = Command.define("SaveActionItems", {
  args: { recordingId: Schema.String, changes: Schema.Array(RecordingChange) },
  messages: [Message.CompletedSaveActionItems, Message.FailedSaveActionItems],
  execute: ({ recordingId, changes }) =>
    saveChanges(recordingId, changes).pipe(
      Effect.map((shown) => Message.CompletedSaveActionItems({ notice: shown })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedSaveActionItems({ reason: reasonOf(failure) })),
      ),
    ),
});

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>;

const save = (
  model: Model,
  recordingId: string,
  changes: ReadonlyArray<RecordingChange>,
): UpdateReturn => {
  if (isSaving(model.save)) {
    return { model };
  }

  if (changes.length === 0) {
    return {
      model: modifyFields(model, { save: () => SaveState.Idle() }),
      outMessage: OutMessage.SavedEdits(),
    };
  }

  return {
    model: modifyFields(model, { save: () => SaveState.Saving() }),
    commands: [SaveActionItems({ recordingId, changes })],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ToggledItem: ({ recordingId, item }) => save(model, recordingId, [tickOf(item)]),

    ChoseOwner: ({ recordingId, item, chosen }) =>
      save(model, recordingId, reassignOf(item, chosen)),

    CompletedSaveActionItems: ({ notice: shown }) => ({
      model: modifyFields(model, { save: () => answered(shown) }),
      outMessage: OutMessage.SavedEdits(),
    }),

    FailedSaveActionItems: ({ reason }) => ({
      model: modifyFields(model, { save: () => failedSave(reason) }),
    }),
  });

export interface ViewInputs {
  readonly recordingId: string;
  readonly items: ReadonlyArray<ActionItem> | null;
  readonly members: ReadonlyArray<OfficeMember>;
}

const itemView = (
  model: Model,
  inputs: ViewInputs,
  item: ActionItem,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("li")(
    String(item.id),
    [h.Class(item.done ? "action-item action-item-done" : "action-item")],
    [
      checkbox(h, {
        id: `action-item-${item.id}`,
        isChecked: item.done,
        isDisabled: isSaving(model.save),
        onToggle: () => Message.ToggledItem({ recordingId: inputs.recordingId, item }),
      }),
      h.div(
        [h.Class("action-item-body")],
        [
          checkboxLabel(h, {
            checkboxId: `action-item-${item.id}`,
            text: item.text,
            className: "action-item-text",
          }),
          h.div(
            [h.Class("action-item-owner")],
            [
              item.owner === null
                ? h.empty
                : avatar(h, { name: item.owner.name, avatarUrl: item.owner.avatarUrl, size: "sm" }),
              inlineSelect(h, {
                id: `action-item-${item.id}-owner`,
                label: `Owner of ${item.text}`,
                options: ownerOptions(inputs.members, item.owner),
                value: item.owner?.userId ?? "",
                isDisabled: isSaving(model.save),
                onChange: (chosen) =>
                  Message.ChoseOwner({ recordingId: inputs.recordingId, item, chosen }),
              }),
            ],
          ),
        ],
      ),
    ],
  );

const itemsView = (
  model: Model,
  inputs: ViewInputs,
  items: ReadonlyArray<ActionItem>,
  h: HtmlBuilder<Message>,
): Html =>
  items.length === 0
    ? h.ul([h.Class("action-items")], [descriptionItem(h, [NONE_TAKEN_ON])])
    : h.ul(
        [h.Class("action-items")],
        Array.map(items, (item) => itemView(model, inputs, item, h)),
      );

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.section(
    [h.Class("stack-2"), h.AriaLabelledBy("action-items-heading")],
    [
      eyebrow(h, { text: "Action items", tone: "muted", id: "action-items-heading" }),
      inputs.items === null
        ? description(h, [NO_ACTION_ITEMS])
        : itemsView(model, inputs, inputs.items, h),
      noticeRegion(h, noticeOf(model.save)),
    ],
  ),
);
