import { Array, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

export interface Tab<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
}

export type TabsAppearance = "underline" | "pills";

export interface TabsConfig<Id extends string, Message> {
  readonly name: string;
  readonly label: string;
  readonly tabs: ReadonlyArray<Tab<Id>>;
  readonly selected: Id;
  readonly appearance: TabsAppearance;
  readonly onSelect: (id: Id) => Message;
}

export const tabId = (name: string, id: string): string => `${name}-tab-${id}`;

export const tabPanelId = (name: string, id: string): string => `${name}-panel-${id}`;

const MOVES = new Map<string, (index: number, count: number) => number>([
  ["ArrowRight", (index, count) => (index + 1) % count],
  ["ArrowLeft", (index, count) => (index - 1 + count) % count],
  ["Home", () => 0],
  ["End", (_, count) => count - 1],
]);

export const tabAfterKey = <Id extends string>(
  tabs: ReadonlyArray<Tab<Id>>,
  from: Id,
  key: string,
): Option.Option<Tab<Id>> => {
  const index = Array.findFirstIndex(tabs, (tab) => tab.id === from).pipe(
    Option.getOrElse(() => -1),
  );

  return Option.fromNullishOr(MOVES.get(key)).pipe(
    Option.flatMap((move) => Array.get(tabs, move(index, tabs.length))),
  );
};

export const tabs = <Id extends string, Message>(
  h: HtmlBuilder<Message>,
  config: TabsConfig<Id, Message>,
): Html =>
  h.div(
    [h.Class(`pb-tabs pb-tabs-${config.appearance}`), h.Role("tablist"), h.AriaLabel(config.label)],
    Array.map(config.tabs, (tab) =>
      h.keyed("button")(
        tab.id,
        [
          h.Type("button"),
          h.Role("tab"),
          h.Class("text-body-sm"),
          h.Id(tabId(config.name, tab.id)),
          h.AriaControls(tabPanelId(config.name, tab.id)),
          h.AriaSelected(tab.id === config.selected),
          h.Tabindex(tab.id === config.selected ? 0 : -1),
          h.OnClick(config.onSelect(tab.id)),
          h.OnKeyDownFocus((key) =>
            tabAfterKey(config.tabs, tab.id, key).pipe(
              Option.map((target) => ({
                focusSelector: `#${tabId(config.name, target.id)}`,
                message: config.onSelect(target.id),
              })),
            ),
          ),
        ],
        [tab.label],
      ),
    ),
  );
