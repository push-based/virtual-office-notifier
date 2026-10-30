import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbStat } from "./stat";

@Component({
  imports: [PbStat],
  template: `<pb-stat value="3" label="Recordings" />`,
})
class Host {}

describe("PbStat", () => {
  it("shows the value above its label", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;

    expect(element.querySelector(".value")?.textContent).toBe("3");
    expect(element.querySelector(".label")?.textContent).toBe("Recordings");
  });
});
