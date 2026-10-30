import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type HeadingLevel, PbStatusHeading } from "./status-heading";

@Component({
  imports: [PbStatusHeading],
  template: `
    <pb-status-heading
      [heading]="heading()"
      [description]="description()"
      [live]="live()"
      [level]="level()"
    />
  `,
})
class Host {
  readonly heading = signal("Not recording");

  readonly description = signal<string | null>("Press start to record and transcribe the office.");

  readonly live = signal(false);

  readonly level = signal<HeadingLevel>(1);
}

const render = async (changes: (host: Host) => void = () => {}) => {
  const fixture = TestBed.createComponent(Host);
  changes(fixture.componentInstance);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  return element;
};

describe("PbStatusHeading", () => {
  it("shows a heading with a muted description under it", async () => {
    const element = await render();

    expect(element.querySelector("h1")?.textContent?.trim()).toBe("Not recording");
    expect(element.querySelector("h1")?.classList).toContain("text-tabular");
    expect(element.querySelector("p")?.textContent).toBe(
      "Press start to record and transcribe the office.",
    );
    expect(element.querySelector("pb-live-dot")).toBeNull();
  });

  it("puts the live dot in the heading while it's live", async () => {
    const element = await render((host) => {
      host.heading.set("Recording · 00:12:34");
      host.live.set(true);
    });

    expect(element.querySelector("h1 > pb-live-dot")).not.toBeNull();
    expect(element.querySelector("h1")?.textContent?.trim()).toBe("Recording · 00:12:34");
  });

  it("can sit lower in the outline and leave out the description", async () => {
    const element = await render((host) => {
      host.level.set(2);
      host.description.set(null);
    });

    expect(element.querySelector("h1")).toBeNull();
    expect(element.querySelector("h2")?.textContent?.trim()).toBe("Not recording");
    expect(element.querySelector("p")).toBeNull();
  });
});
