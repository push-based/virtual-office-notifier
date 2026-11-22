import { Tabs } from "@foldkit/ui";
import { Array, Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export interface Tab<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
}

export type Appearance = "underline" | "pills";

export const Model = Tabs.Model;

export type Model = Tabs.Model;

export const Message = Tabs.Message;

export type Message = Tabs.Message;

export const OutMessage = Tabs.OutMessage;

export type OutMessage = Tabs.OutMessage;

export const FocusTab = Tabs.FocusTab;

const tabsBundle = Tabs.create();

export const init = (name: string): Model => Tabs.init({ id: name });

export const update = tabsBundle.update;

export interface Layout<Id extends string, ParentMessage> {
  readonly tablist: Html;
  readonly panel: (
    id: Id,
    attributes: ReadonlyArray<Attribute<ParentMessage>>,
    children: ReadonlyArray<Content>,
  ) => Html;
}

export interface ViewConfig<Id extends string, ParentMessage> {
  readonly slotId: string;
  readonly model: Model;
  readonly label: string;
  readonly tabs: ReadonlyArray<Tab<Id>>;
  readonly selected: Id;
  readonly appearance: Appearance;
  readonly toParentMessage: (message: Message) => ParentMessage;
  readonly toView: (layout: Layout<Id, ParentMessage>) => Html;
}

const layoutOf = <Id extends string, ParentMessage>(
  h: HtmlBuilder<ParentMessage>,
  config: ViewConfig<Id, ParentMessage>,
  render: Tabs.RenderInfo,
): Layout<Id, ParentMessage> => ({
  tablist: h.div(
    [...render.tablist, h.Class(`pb-tabs pb-tabs-${config.appearance}`)],
    Array.map(Array.zip(config.tabs, render.tabs), ([tab, info]) =>
      h.keyed("button")(tab.id, [...info.tab, h.Class("text-body-sm")], [tab.label]),
    ),
  ),
  panel: (id, attributes, children) =>
    Option.match(
      Array.findFirst(render.tabs, (info) => info.value === id),
      {
        onNone: () => h.div(attributes, children),
        onSome: (info) => h.div([...info.panel, h.Tabindex(-1), ...attributes], children),
      },
    ),
});

export const view = <Id extends string, ParentMessage>(
  h: HtmlBuilder<ParentMessage>,
  config: ViewConfig<Id, ParentMessage>,
): Html =>
  h.submodel({
    slotId: config.slotId,
    model: config.model,
    view: tabsBundle.view,
    viewInputs: {
      tabs: Array.map(config.tabs, (tab) => tab.id),
      selectedValue: config.selected,
      ariaLabel: config.label,
      panelMount: "All",
      toView: (render) => config.toView(layoutOf(h, config, render)),
    },
    toParentMessage: config.toParentMessage,
  });
