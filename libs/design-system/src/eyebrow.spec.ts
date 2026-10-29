import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { type EyebrowTone, PbEyebrow } from "./eyebrow";

@Component({
  imports: [PbEyebrow],
  template: `<p pbEyebrow [tone]="tone()">Our domains of expertise</p>`,
})
class Host {
  readonly tone = signal<EyebrowTone>("brand");
}

describe("PbEyebrow", () => {
  it("uses the subtitle style on the element it's put on", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const eyebrow: HTMLElement = fixture.nativeElement.querySelector("p");

    expect(eyebrow.classList).toContain("text-subtitle");
    expect(eyebrow.classList).not.toContain("muted");
  });

  it("can be muted", async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.tone.set("muted");
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector("p").classList).toContain("muted");
  });
});
