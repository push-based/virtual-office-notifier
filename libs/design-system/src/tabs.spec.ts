import { Array, Option, Schema } from "effect";
import { Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  Command,
  click,
  expect,
  expectIgnored,
  given,
  keydown,
  role,
  scene,
  selector,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { describe, it } from "vite-plus/test";

import * as Tabs from "./tabs.ts";

const View = Schema.Literals(["now", "stats", "history"]);

type View = typeof View.Type;

const VIEWS: ReadonlyArray<Tabs.Tab<View>> = [
  { id: "now", label: "Now" },
  { id: "stats", label: "Stats" },
  { id: "history", label: "History" },
];

const viewOf = (value: string): View => (Schema.is(View)(value) ? value : "now");

const Model = Schema.Struct({ tabs: Tabs.Model, selected: View });

type Model = typeof Model.Type;

const Message = defineMessageUnion({ GotTabsMessage: { message: Tabs.Message } });

type Message = typeof Message.Type;

const toTabsMessage = (message: Tabs.Message) => Message.GotTabsMessage({ message });

const foldTabsOutMessage = Tabs.OutMessage.match<Update.Step<Model, Message>>({
  Selected:
    ({ value }) =>
    (stepModel) => ({ model: modifyFields(stepModel, { selected: () => viewOf(value) }) }),
});

const foldTabs = Update.foldChild({
  update: Tabs.update,
  read: (model: Model) => Option.some(model.tabs),
  write: (model, nextTabs) => modifyFields(model, { tabs: () => nextTabs }),
  toParentMessage: toTabsMessage,
  foldOutMessage: foldTabsOutMessage,
});

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotTabsMessage: ({ message: tabsMessage }) => foldTabs(model, tabsMessage),
  });

const view = (model: Model, h: HtmlBuilder<Message>) =>
  Tabs.view(h, {
    slotId: "views",
    model: model.tabs,
    label: "Views",
    tabs: VIEWS,
    selected: model.selected,
    appearance: "underline",
    toParentMessage: toTabsMessage,
    toView: ({ tablist, panel }) =>
      h.div(
        [],
        [
          tablist,
          ...Array.map(VIEWS, ({ id }) =>
            panel(id, id === model.selected ? [h.Class("panel")] : [], [`${id} panel`]),
          ),
        ],
      ),
  });

const start = (selected: View): Model => ({ tabs: Tabs.init("view"), selected });

const tab = (name: string) => role("tab", { name });

const focused = Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab());

describe("Tabs", () => {
  it("is a labelled tab list where only the selected tab is selected and focusable", () => {
    scene(
      { update, view },
      given(start("now")),
      expect(role("tablist", { name: "Views" })).toExist(),
      expect(tab("Now")).toHaveAttr("aria-selected", "true"),
      expect(tab("Now")).toHaveAttr("tabIndex", "0"),
      expect(tab("Stats")).toHaveAttr("aria-selected", "false"),
      expect(tab("Stats")).toHaveAttr("tabIndex", "-1"),
    );
  });

  it("labels the panel with its tab and keeps it out of the tab order", () => {
    scene(
      { update, view },
      given(start("stats")),
      expect(role("tabpanel", { name: "Stats" })).toHaveText("stats panel"),
      expect(role("tabpanel", { name: "Stats" })).toHaveClass("panel"),
      expect(selector(".panel")).toHaveAttr("tabIndex", "-1"),
    );
  });

  it("points every tab at a panel that's in the page, and hides the ones not selected", () => {
    scene(
      { update, view },
      given(start("stats")),
      expect(tab("Now")).toHaveAttr("aria-controls", "view-panel-0"),
      expect(selector("#view-panel-0")).toExist(),
      expect(selector("#view-panel-0")).toHaveAttr("hidden", "true"),
      expect(tab("History")).toHaveAttr("aria-controls", "view-panel-2"),
      expect(selector("#view-panel-2")).toHaveAttr("hidden", "true"),
      expect(selector("#view-panel-1")).toHaveAttr("hidden", "false"),
    );
  });

  it("selects a tab when it's clicked", () => {
    scene(
      { update, view },
      given(start("now")),
      click(tab("Stats")),
      focused,
      expect(tab("Stats")).toHaveAttr("aria-selected", "true"),
      expect(tab("Now")).toHaveAttr("aria-selected", "false"),
      expect(role("tabpanel", { name: "Stats" })).toExist(),
    );
  });

  it("selects the next tab with the arrow keys, wrapping around", () => {
    scene(
      { update, view },
      given(start("now")),
      keydown(tab("Now"), "ArrowLeft"),
      focused,
      expect(tab("History")).toHaveAttr("aria-selected", "true"),
      keydown(tab("History"), "ArrowRight"),
      focused,
      expect(tab("Now")).toHaveAttr("aria-selected", "true"),
    );
  });

  it("jumps to the ends with Home and End", () => {
    scene(
      { update, view },
      given(start("now")),
      keydown(tab("Now"), "End"),
      focused,
      expect(tab("History")).toHaveAttr("aria-selected", "true"),
      keydown(tab("History"), "Home"),
      focused,
      expect(tab("Now")).toHaveAttr("aria-selected", "true"),
    );
  });

  it("ignores any other key", () => {
    scene(
      { update, view },
      given(start("now")),
      keydown(tab("Now"), "a"),
      expectIgnored(),
      expect(tab("Now")).toHaveAttr("aria-selected", "true"),
    );
  });
});
