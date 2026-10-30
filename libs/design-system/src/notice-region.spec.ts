import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbNotice } from "./notice";
import { PbNoticeRegion } from "./notice-region";

@Component({
  imports: [PbNotice, PbNoticeRegion],
  template: `
    <pb-notice-region>
      @if (text(); as text) {
        <pb-notice>{{ text }}</pb-notice>
      }
    </pb-notice-region>
  `,
})
class Host {
  readonly text = signal<string | null>(null);
}

describe("PbNoticeRegion", () => {
  it("stays on the page as a status region while there's nothing to announce", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const region: HTMLElement = fixture.nativeElement.querySelector("pb-notice-region");

    expect(region.getAttribute("role")).toBe("status");
    expect(region.querySelector("pb-notice")).toBeNull();
  });

  it("holds the notice once there is one, so it gets announced", async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.text.set("Recording started.");
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('[role="status"] > pb-notice')?.textContent).toBe(
      "Recording started.",
    );
  });
});
