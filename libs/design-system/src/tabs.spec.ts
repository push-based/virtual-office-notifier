import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbTabs, type Tab } from "./tabs";

@Component({
  imports: [PbTabs],
  template: `<pb-tabs name="view" label="Views" [tabs]="tabs" [(selected)]="selected" />`,
})
class Host {
  readonly tabs: ReadonlyArray<Tab> = [
    { id: "now", label: "Now" },
    { id: "stats", label: "Stats" },
    { id: "history", label: "History" },
  ];

  readonly selected = signal("now");
}

const render = async () => {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;
  const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")];

  return { fixture, host: fixture.componentInstance, element, buttons };
};

const press = (button: HTMLButtonElement, key: string) =>
  button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("PbTabs", () => {
  it("is a labelled tab list with only the selected tab selected and focusable", async () => {
    const { element, buttons } = await render();

    expect(element.querySelector("pb-tabs")?.getAttribute("role")).toBe("tablist");
    expect(element.querySelector("pb-tabs")?.getAttribute("aria-label")).toBe("Views");
    expect(buttons.map((button) => button.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
    expect(buttons[1]?.id).toBe("view-tab-stats");
    expect(buttons[1]?.getAttribute("aria-controls")).toBe("view-panel-stats");
  });

  it("selects a tab when it's clicked", async () => {
    const { fixture, host, buttons } = await render();

    buttons[1]?.click();
    await fixture.whenStable();

    expect(host.selected()).toBe("stats");
    expect(buttons[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("moves between tabs with the arrow keys, wrapping around, and Home and End", async () => {
    const { fixture, host, buttons } = await render();
    const [first, second, third] = buttons;

    if (first === undefined || second === undefined || third === undefined) throw new Error();

    press(first, "ArrowLeft");
    await fixture.whenStable();
    expect(host.selected()).toBe("history");
    expect(document.activeElement).toBe(third);

    press(third, "ArrowRight");
    expect(host.selected()).toBe("now");

    press(first, "End");
    expect(host.selected()).toBe("history");

    press(third, "Home");
    expect(host.selected()).toBe("now");

    press(first, "Enter");
    expect(host.selected()).toBe("now");
  });
});
