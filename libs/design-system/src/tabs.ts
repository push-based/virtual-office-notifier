import { Tabs } from "@foldkit/ui";
import { Array, Function, Option } from "effect";
import { Update } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export interface Tab<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

export type Appearance = "underline" | "pills";

export const Model = Tabs.Model;

export type Model = Tabs.Model;

export const Message = Tabs.Message;

export type Message = Tabs.Message;

export const OutMessage = Tabs.OutMessage;

export type OutMessage<Id extends string = string> = Tabs.OutMessage<Id>;

export const FocusTab = Tabs.FocusTab;

const tabsBundle = Tabs.create();

export const init = (name: string): Model => Tabs.init({ id: name });

export interface Layout<Id extends string, ParentMessage> {
  readonly tablist: Html;
  readonly panel: (
    id: Id,
    attributes: ReadonlyArray<Attribute<ParentMessage>>,
    children: ReadonlyArray<Content>,
  ) => Html;
}

export interface ViewConfig<Id extends string, ParentMessage> {
  readonly model: Model;
  readonly label: string;
  readonly selected: Id;
  readonly appearance: Appearance;
  readonly toParentMessage: (message: Message) => ParentMessage;
  readonly toView: (layout: Layout<Id, ParentMessage>) => Html;
}

export interface Bundle<Id extends string> {
  readonly update: (
    model: Model,
    message: Message,
  ) => Update.ReturnWithOutMessage<Model, Message, OutMessage<Id>>;
  readonly view: <ParentMessage>(
    h: HtmlBuilder<ParentMessage>,
    config: ViewConfig<Id, ParentMessage>,
  ) => Html;
}

const layoutOf = <Id extends string, ParentMessage>(
  h: HtmlBuilder<ParentMessage>,
  tabs: ReadonlyArray<Tab<Id>>,
  config: ViewConfig<Id, ParentMessage>,
  render: Tabs.RenderInfo,
): Layout<Id, ParentMessage> => ({
  tablist: h.div(
    [...render.tablist, h.Class(`pb-tabs pb-tabs-${config.appearance}`)],
    Array.map(Array.zip(tabs, render.tabs), ([tab, info]) =>
      h.keyed("button")(tab.id, [...info.tab, h.Class("text-body-sm")], [tab.label]),
    ),
  ),
  panel: (id, attributes, children) =>
    Option.match(
      Array.findFirst(render.tabs, (info) => info.value === id),
      {
        onNone: () => h.div(attributes, children),
        onSome: (info) =>
          h.div([...info.panel, h.Tabindex(-1), h.Hidden(!info.isActive), ...attributes], children),
      },
    ),
});

const foldSelectedAmong = <Id extends string>(tabs: ReadonlyArray<Tab<Id>>) =>
  Tabs.OutMessage.match<Update.StepWithOutMessage<Model, Message, OutMessage<Id>>>({
    Selected: (selected) => (stepModel) =>
      Update.withOutMessage(
        { model: stepModel },
        Option.getOrUndefined(
          Option.map(
            Array.findFirst(tabs, (tab) => tab.id === selected.value),
            (tab) => ({ ...selected, value: tab.id }),
          ),
        ),
      ),
  });

export const create = <Id extends string>(tabs: ReadonlyArray<Tab<Id>>): Bundle<Id> => ({
  update: Update.foldChild({
    update: tabsBundle.update,
    read: (model: Model) => Option.some(model),
    write: (_model, nextModel) => nextModel,
    toParentMessage: Function.identity<Message>,
    foldOutMessage: foldSelectedAmong(tabs),
  }),
  view: (h, config) =>
    h.submodel({
      slotId: config.model.id,
      model: config.model,
      view: tabsBundle.view,
      viewInputs: {
        tabs: Array.map(tabs, (tab) => tab.id),
        selectedValue: config.selected,
        ariaLabel: config.label,
        panelMount: "All",
        toView: (render) => config.toView(layoutOf(h, tabs, config, render)),
      },
      toParentMessage: config.toParentMessage,
    }),
});
