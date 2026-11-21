import { Effect, Option, Schema } from "effect";
import { avatar, description, eyebrow, notice, noticeRegion } from "design-system";
import { Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { Notice } from "../notice.ts";
import { unreachableNotice } from "../recorder/notices.ts";
import type { Resources } from "../resources.ts";
import { ActionItem, type OfficeMember, RecordingChange } from "../wire.ts";
import { saveChanges } from "./save.ts";

export const NO_ACTION_ITEMS = "No action items could be pulled out.";

export const NONE_TAKEN_ON = "Nobody took anything on.";

export const UNASSIGNED = "Unassigned";

export const tickOf = (item: ActionItem): RecordingChange => ({
  kind: item.done ? "untick" : "tick",
  item: item.id,
});

export const reassignOf = (item: ActionItem, chosen: string): ReadonlyArray<RecordingChange> => {
  const owner = chosen === "" ? null : chosen;

  return owner === (item.owner?.userId ?? null) ? [] : [{ kind: "reassign", item: item.id, owner }];
};

export const ownerChoices = (
  members: ReadonlyArray<OfficeMember>,
  owner: OfficeMember | null,
): ReadonlyArray<OfficeMember> =>
  owner === null || members.some(({ userId }) => userId === owner.userId)
    ? members
    : [owner, ...members];

export const Model = Schema.Struct({
  isSaving: Schema.Boolean,
  notice: Schema.Option(Notice),
});

export type Model = typeof Model.Type;

export const init = (): Model => ({ isSaving: false, notice: Option.none() });

export const Message = defineMessageUnion({
  ToggledItem: { recordingId: Schema.String, item: ActionItem },
  ChoseOwner: { recordingId: Schema.String, item: ActionItem, chosen: Schema.String },
  CompletedSaveActionItems: { notice: Schema.Option(Notice) },
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
      Effect.catchTag("ApiFailure", ({ reason }) =>
        Effect.succeed(Message.FailedSaveActionItems({ reason })),
      ),
    ),
});

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>;

const save = (
  model: Model,
  recordingId: string,
  changes: ReadonlyArray<RecordingChange>,
): UpdateReturn => {
  if (model.isSaving) {
    return { model };
  }

  if (changes.length === 0) {
    return {
      model: modifyFields(model, { notice: () => Option.none() }),
      outMessage: OutMessage.SavedEdits(),
    };
  }

  return {
    model: modifyFields(model, { isSaving: () => true, notice: () => Option.none() }),
    commands: [SaveActionItems({ recordingId, changes })],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ToggledItem: ({ recordingId, item }) => save(model, recordingId, [tickOf(item)]),

    ChoseOwner: ({ recordingId, item, chosen }) =>
      save(model, recordingId, reassignOf(item, chosen)),

    CompletedSaveActionItems: ({ notice: shown }) => ({
      model: modifyFields(model, { isSaving: () => false, notice: () => shown }),
      outMessage: OutMessage.SavedEdits(),
    }),

    FailedSaveActionItems: ({ reason }) => ({
      model: modifyFields(model, {
        isSaving: () => false,
        notice: () => Option.some(unreachableNotice(reason)),
      }),
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
      h.input([
        h.Type("checkbox"),
        h.Class("action-item-tick"),
        h.Checked(item.done),
        h.Disabled(model.isSaving),
        h.AriaLabel(item.text),
        h.OnChange(() => Message.ToggledItem({ recordingId: inputs.recordingId, item })),
      ]),
      h.div(
        [h.Class("action-item-body")],
        [
          h.p([h.Class("text-body action-item-text")], [item.text]),
          h.div(
            [h.Class("action-item-owner")],
            [
              item.owner === null
                ? h.empty
                : avatar(h, { name: item.owner.name, src: item.owner.avatarUrl, size: "sm" }),
              h.select(
                [
                  h.Class("text-body-sm action-item-choice"),
                  h.AriaLabel(`Owner of ${item.text}`),
                  h.Disabled(model.isSaving),
                  h.OnChange((chosen) =>
                    Message.ChoseOwner({ recordingId: inputs.recordingId, item, chosen }),
                  ),
                ],
                [
                  h.option([h.Value(""), h.Selected(item.owner === null)], [UNASSIGNED]),
                  ...ownerChoices(inputs.members, item.owner).map((member) =>
                    h.keyed("option")(
                      member.userId,
                      [h.Value(member.userId), h.Selected(member.userId === item.owner?.userId)],
                      [member.name],
                    ),
                  ),
                ],
              ),
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
    ? h.ul(
        [h.Class("action-items")],
        [h.li([h.Class("text-body-sm pb-description")], [NONE_TAKEN_ON])],
      )
    : h.ul(
        [h.Class("action-items")],
        items.map((item) => itemView(model, inputs, item, h)),
      );

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.section(
    [h.Class("stack-2"), h.AriaLabelledBy("action-items-heading")],
    [
      eyebrow(h, { text: "Action items", tone: "muted", id: "action-items-heading" }),
      inputs.items === null
        ? description(h, [NO_ACTION_ITEMS])
        : itemsView(model, inputs, inputs.items, h),
      noticeRegion(
        h,
        Option.match(model.notice, { onNone: () => [], onSome: (shown) => [notice(h, shown)] }),
      ),
    ],
  ),
);
