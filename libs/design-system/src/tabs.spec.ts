import { Option } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { click, expect, given, keydown, role, scene } from "foldkit/scene";
import { describe, expect as expectValue, it } from "vite-plus/test";

import { type Tab, tabAfterKey, tabs } from "./tabs.ts";

type View = "now" | "stats" | "history";

const VIEWS: ReadonlyArray<Tab<View>> = [
  { id: "now", label: "Now" },
  { id: "stats", label: "Stats" },
  { id: "history", label: "History" },
];

const update = (_model: View, selected: View) => ({ model: selected });

const view = (selected: View, h: HtmlBuilder<View>) =>
  tabs(h, {
    name: "view",
    label: "Views",
    tabs: VIEWS,
    selected,
    appearance: "underline",
    onSelect: (id) => id,
  });

const tab = (name: string) => role("tab", { name });

describe("tabs", () => {
  it("is a labelled tab list with only the selected tab selected and focusable", () => {
    scene(
      { update, view },
      given<View>("now"),
      expect(role("tablist", { name: "Views" })).toExist(),
      expect(tab("Now")).toHaveAttr("aria-selected", "true"),
      expect(tab("Stats")).toHaveAttr("aria-selected", "false"),
      expect(tab("Stats")).toHaveId("view-tab-stats"),
      expect(tab("Stats")).toHaveAttr("aria-controls", "view-panel-stats"),
    );
  });

  it("selects a tab when it's clicked", () => {
    scene(
      { update, view },
      given<View>("now"),
      click(tab("Stats")),
      expect(tab("Stats")).toHaveAttr("aria-selected", "true"),
      expect(tab("Now")).toHaveAttr("aria-selected", "false"),
    );
  });

  it("selects the next tab with the arrow keys", () => {
    scene(
      { update, view },
      given<View>("now"),
      keydown(tab("Now"), "ArrowLeft"),
      expect(tab("History")).toHaveAttr("aria-selected", "true"),
      keydown(tab("History"), "ArrowRight"),
      expect(tab("Now")).toHaveAttr("aria-selected", "true"),
    );
  });
});

describe("tabAfterKey", () => {
  const after = (from: View, key: string) =>
    Option.map(tabAfterKey(VIEWS, from, key), (target) => target.id);

  it("moves with the arrow keys, wrapping around", () => {
    expectValue(after("now", "ArrowLeft")).toEqual(Option.some("history"));
    expectValue(after("history", "ArrowRight")).toEqual(Option.some("now"));
  });

  it("jumps to the ends with Home and End", () => {
    expectValue(after("now", "End")).toEqual(Option.some("history"));
    expectValue(after("history", "Home")).toEqual(Option.some("now"));
  });

  it("ignores any other key", () => {
    expectValue(after("now", "Enter")).toEqual(Option.none());
  });
});
