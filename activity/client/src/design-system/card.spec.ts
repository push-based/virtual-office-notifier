import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { PbCard } from "./card";

@Component({
  imports: [PbCard],
  template: `<pb-card><h3>Angular</h3></pb-card>`,
})
class Host {}

describe("PbCard", () => {
  it("wraps its content in the card style", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const card: HTMLElement = fixture.nativeElement.querySelector("pb-card");

    expect(card.classList).toContain("pb-card");
    expect(card.querySelector("h3")?.textContent).toBe("Angular");
  });
});
