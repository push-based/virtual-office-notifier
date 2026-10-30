import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbTextField } from "./text-field";

@Component({
  imports: [PbTextField],
  template: `
    <pb-text-field label="Title" [maxLength]="80" [(value)]="title" [disabled]="disabled()" />
    <pb-text-field label="Agenda" multiline [(value)]="agenda" />
  `,
})
class Host {
  readonly title = signal("Deploy retro");

  readonly agenda = signal("");

  readonly disabled = signal(false);
}

const render = async () => {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  return { fixture, element };
};

describe("PbTextField", () => {
  it("labels a one-line input and a multi-line one, each with its value", async () => {
    const { element } = await render();
    const input = element.querySelector("input");
    const textarea = element.querySelector("textarea");

    expect(input?.closest("label")?.textContent).toContain("Title");
    expect(input?.value).toBe("Deploy retro");
    expect(input?.getAttribute("maxlength")).toBe("80");
    expect(textarea?.closest("label")?.textContent).toContain("Agenda");
    expect(textarea?.hasAttribute("maxlength")).toBe(false);
  });

  it("counts characters against the limit, and only when there is one", async () => {
    const { element } = await render();

    expect([...element.querySelectorAll(".count")].map((count) => count.textContent)).toEqual([
      "12/80",
    ]);
  });

  it("passes what's typed back to its value", async () => {
    const { fixture, element } = await render();
    const textarea = element.querySelector("textarea");

    expect(textarea).not.toBeNull();

    textarea!.value = "What broke\nWho fixes it";
    textarea!.dispatchEvent(new Event("input"));
    await fixture.whenStable();

    expect(fixture.componentInstance.agenda()).toBe("What broke\nWho fixes it");
  });

  it("can be disabled", async () => {
    const { fixture, element } = await render();

    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();

    expect(element.querySelector("input")?.disabled).toBe(true);
  });
});
