import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbDescription } from "./description";
import { PbHeading } from "./heading";

@Component({
  imports: [PbDescription, PbHeading],
  template: `
    <h1 pbHeading class="text-tabular">Recording · 00:12:34</h1>
    <p pbDescription>Started by Chris</p>
  `,
})
class Host {}

describe("PbHeading and PbDescription", () => {
  it("style a heading and the muted line under it, keeping the element's own classes", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;

    expect([...(element.querySelector("h1")?.classList ?? [])]).toEqual(
      expect.arrayContaining(["text-section-title", "text-tabular"]),
    );
    expect(element.querySelector("h1")?.textContent).toBe("Recording · 00:12:34");
    expect(element.querySelector("p")?.classList).toContain("text-body-sm");
    expect(element.querySelector("p")?.textContent).toBe("Started by Chris");
  });
});
