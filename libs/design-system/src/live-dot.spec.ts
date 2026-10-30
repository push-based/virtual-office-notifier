import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type LiveDotTone, PbLiveDot } from "./live-dot";

@Component({
  imports: [PbLiveDot],
  template: `<pb-live-dot [tone]="tone()" />`,
})
class Host {
  readonly tone = signal<LiveDotTone>("error");
}

const render = async (tone: LiveDotTone) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.tone.set(tone);
  await fixture.whenStable();
  const dot: HTMLElement = fixture.nativeElement.querySelector("pb-live-dot");

  return dot;
};

describe("PbLiveDot", () => {
  it("is decoration that screen readers skip", async () => {
    const dot = await render("error");

    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.classList).not.toContain("success");
  });

  it("can pulse in the success tone", async () => {
    expect((await render("success")).classList).toContain("success");
  });
});
