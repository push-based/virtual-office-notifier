import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbDivider } from "./divider";

@Component({
  imports: [PbDivider],
  template: `<hr pbDivider />`,
})
class Host {}

describe("PbDivider", () => {
  it("is a native separator", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const divider: HTMLHRElement | null = fixture.nativeElement.querySelector("hr");

    expect(divider?.getAttribute("role")).toBeNull();
    expect(divider?.childNodes.length).toBe(0);
  });
});
