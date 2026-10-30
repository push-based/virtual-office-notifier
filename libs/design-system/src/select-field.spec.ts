import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbSelectField } from "./select-field";

@Component({
  imports: [PbSelectField],
  template: `
    <pb-select-field
      label="Summary"
      [options]="options"
      [(value)]="style"
      [disabled]="disabled()"
    />
  `,
})
class Host {
  readonly options = [
    { value: "brief", label: "Brief" },
    { value: "detailed", label: "Detailed" },
  ];

  readonly style = signal("detailed");

  readonly disabled = signal(false);
}

const render = async () => {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  return { fixture, element };
};

describe("PbSelectField", () => {
  it("labels a list of options with the current one picked", async () => {
    const { element } = await render();
    const select = element.querySelector("select");

    expect(select?.closest("label")?.textContent).toContain("Summary");
    expect([...(select?.options ?? [])].map((option) => option.textContent?.trim())).toEqual([
      "Brief",
      "Detailed",
    ]);
    expect(select?.value).toBe("detailed");
  });

  it("passes what's picked back to its value", async () => {
    const { fixture, element } = await render();
    const select = element.querySelector("select");

    expect(select).not.toBeNull();

    select!.value = "brief";
    select!.dispatchEvent(new Event("change"));
    await fixture.whenStable();

    expect(fixture.componentInstance.style()).toBe("brief");
  });

  it("can be disabled", async () => {
    const { fixture, element } = await render();

    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();

    expect(element.querySelector("select")?.disabled).toBe(true);
  });
});
