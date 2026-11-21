import { identity, Option } from "effect";
import { Scene, Story } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it } from "vite-plus/test";

import { anna, ben } from "../history/fixtures.ts";
import type { ActionItem } from "../wire.ts";
import * as ActionItems from "./action-items.ts";
import * as RecordingEditor from "./recording-editor.ts";
import * as SummaryRewrite from "./summary-rewrite.ts";

const current = { title: "Deploy retro", agenda: null, summaryStyle: "brief" as const };

const editorScene = {
  update: RecordingEditor.update,
  view: (model: RecordingEditor.Model, h: HtmlBuilder<RecordingEditor.Message>) =>
    h.submodel({
      slotId: "editor",
      model,
      view: RecordingEditor.view,
      viewInputs: { idPrefix: "editor", recordingId: "r1", current, label: "Edit" },
      toParentMessage: identity,
    }),
};

describe("the recording editor", () => {
  it("opens on Edit with the current title and agenda filled in", () => {
    Scene.scene(
      editorScene,
      Scene.given(RecordingEditor.init()),
      Scene.click(Scene.role("button", { name: "Edit" })),
      Scene.expect(Scene.label("Title")).toHaveValue("Deploy retro"),
      Scene.expect(Scene.label("Agenda")).toHaveValue(""),
    );
  });

  it("shows Saving… until the bot has applied the change, then closes and says it saved", () => {
    Scene.scene(
      editorScene,
      Scene.given(RecordingEditor.init()),
      Scene.click(Scene.role("button", { name: "Edit" })),
      Scene.type(Scene.label("Title"), ""),
      Scene.change(Scene.label("Summary"), "decisions"),
      Scene.click(Scene.role("button", { name: "Save" })),
      Scene.Command.expectExact(
        RecordingEditor.SaveEdits({
          recordingId: "r1",
          changes: [
            { kind: "title", title: null },
            { kind: "summary_style", style: "decisions" },
          ],
        }),
      ),
      Scene.expect(Scene.role("button", { name: "Saving…" })).toBeDisabled(),
      Scene.Command.resolve(
        RecordingEditor.SaveEdits,
        RecordingEditor.Message.CompletedSaveEdits({ notice: Option.none() }),
      ),
      Scene.expectOutMessage(RecordingEditor.OutMessage.SavedEdits()),
      Scene.expect(Scene.role("button", { name: "Edit" })).toExist(),
    );
  });

  it("closes without sending anything when nothing changed, and on Cancel", () => {
    Story.story(
      RecordingEditor.update,
      Story.given(RecordingEditor.init()),
      Story.message(RecordingEditor.Message.ClickedEdit({ current })),
      Story.message(RecordingEditor.Message.ClickedSave({ recordingId: "r1", current })),
      Story.Command.expectNone(),
      Story.expectOutMessage(RecordingEditor.OutMessage.SavedEdits()),
      Story.message(RecordingEditor.Message.ClickedEdit({ current })),
      Story.message(RecordingEditor.Message.ClickedCancel()),
      Story.model((model) => expect(model.draft).toEqual(Option.none())),
    );
  });

  it("keeps the form open and says why when the change couldn't be sent", () => {
    Scene.scene(
      editorScene,
      Scene.given(RecordingEditor.init()),
      Scene.click(Scene.role("button", { name: "Edit" })),
      Scene.type(Scene.label("Title"), "Retro"),
      Scene.click(Scene.role("button", { name: "Save" })),
      Scene.Command.resolve(
        RecordingEditor.SaveEdits,
        RecordingEditor.Message.FailedSaveEdits({ reason: "/api/edits answered 503" }),
      ),
      Scene.expect(Scene.text("Couldn't reach the bot: /api/edits answered 503")).toExist(),
      Scene.expect(Scene.label("Title")).toHaveValue("Retro"),
    );
  });

  it("explains a change the bot ignored", () => {
    Story.story(
      RecordingEditor.update,
      Story.given({ ...RecordingEditor.init(), isSaving: true }),
      Story.message(
        RecordingEditor.Message.CompletedSaveEdits({
          notice: Option.some({ kind: "error", text: "That recording is still running." }),
        }),
      ),
      Story.model((model) =>
        expect(model.notice).toEqual(
          Option.some({ kind: "error", text: "That recording is still running." }),
        ),
      ),
      Story.expectOutMessage(RecordingEditor.OutMessage.SavedEdits()),
    );
  });
});

describe("rewriting the summary", () => {
  it("asks the bot to rewrite it, and holds the button while it's busy", () => {
    Story.story(
      SummaryRewrite.update,
      Story.given(SummaryRewrite.init()),
      Story.message(SummaryRewrite.Message.ClickedRewrite({ recordingId: "r1" })),
      Story.Command.expectExact(SummaryRewrite.RewriteSummary({ recordingId: "r1" })),
      Story.model((model) => expect(model.isSaving).toBe(true)),
      Story.Command.resolve(
        SummaryRewrite.RewriteSummary,
        SummaryRewrite.Message.CompletedRewriteSummary({ notice: Option.none() }),
      ),
      Story.expectOutMessage(SummaryRewrite.OutMessage.SavedEdits()),
    );
  });
});

const checklist: ActionItem = {
  id: 4,
  text: "write up the deploy checklist",
  owner: anna,
  done: false,
};

const vpn: ActionItem = { id: 5, text: "ask IT about the VPN", owner: null, done: false };

const room: ActionItem = { id: 6, text: "book the room for Thursday", owner: ben, done: true };

const itemsScene = (items: ReadonlyArray<ActionItem> | null, members = [anna, ben]) => ({
  update: ActionItems.update,
  view: (model: ActionItems.Model, h: HtmlBuilder<ActionItems.Message>) =>
    h.submodel({
      slotId: "action-items",
      model,
      view: ActionItems.view,
      viewInputs: { recordingId: "r1", items, members },
      toParentMessage: identity,
    }),
});

describe("the action items", () => {
  it("ticks an open item as a recording edit and says so once the bot has applied it", () => {
    Scene.scene(
      itemsScene([checklist, vpn, room]),
      Scene.given(ActionItems.init()),
      Scene.change(Scene.role("checkbox", { name: checklist.text }), "on"),
      Scene.Command.expectExact(
        ActionItems.SaveActionItems({ recordingId: "r1", changes: [{ kind: "tick", item: 4 }] }),
      ),
      Scene.expect(Scene.role("checkbox", { name: vpn.text })).toBeDisabled(),
      Scene.Command.resolve(
        ActionItems.SaveActionItems,
        ActionItems.Message.CompletedSaveActionItems({ notice: Option.none() }),
      ),
      Scene.expectOutMessage(ActionItems.OutMessage.SavedEdits()),
    );
  });

  it("unticks a done item and gives an item to someone else", () => {
    Story.story(
      ActionItems.update,
      Story.given(ActionItems.init()),
      Story.message(ActionItems.Message.ToggledItem({ recordingId: "r1", item: room })),
      Story.Command.expectExact(
        ActionItems.SaveActionItems({ recordingId: "r1", changes: [{ kind: "untick", item: 6 }] }),
      ),
      Story.Command.resolve(
        ActionItems.SaveActionItems,
        ActionItems.Message.CompletedSaveActionItems({ notice: Option.none() }),
      ),
      Story.message(ActionItems.Message.ChoseOwner({ recordingId: "r1", item: vpn, chosen: "u2" })),
      Story.Command.expectExact(
        ActionItems.SaveActionItems({
          recordingId: "r1",
          changes: [{ kind: "reassign", item: 5, owner: "u2" }],
        }),
      ),
      Story.Command.resolve(
        ActionItems.SaveActionItems,
        ActionItems.Message.CompletedSaveActionItems({ notice: Option.none() }),
      ),
    );
  });

  it("offers Unassigned, everyone from the office, and an owner who isn't among them", () => {
    const outsider = { userId: "u9", name: "Cleo", avatarUrl: null };

    Scene.scene(
      itemsScene([{ ...vpn, owner: outsider }], [anna, ben]),
      Scene.given(ActionItems.init()),
      Scene.expect(Scene.role("combobox", { name: `Owner of ${vpn.text}` })).toContainText(
        "UnassignedCleoAnnaBen",
      ),
    );
  });

  it("says when nobody took anything on, and when no model could pull the items out", () => {
    Scene.scene(
      itemsScene([]),
      Scene.given(ActionItems.init()),
      Scene.expect(Scene.text(ActionItems.NONE_TAKEN_ON)).toExist(),
    );
    Scene.scene(
      itemsScene(null),
      Scene.given(ActionItems.init()),
      Scene.expect(Scene.text(ActionItems.NO_ACTION_ITEMS)).toExist(),
    );
  });

  it("builds the changes for ticking and reassigning", () => {
    expect(ActionItems.tickOf(checklist)).toEqual({ kind: "tick", item: 4 });
    expect(ActionItems.tickOf(room)).toEqual({ kind: "untick", item: 6 });
    expect(ActionItems.reassignOf(checklist, "")).toEqual([
      { kind: "reassign", item: 4, owner: null },
    ]);
    expect(ActionItems.reassignOf(checklist, "u1")).toEqual([]);
  });
});
