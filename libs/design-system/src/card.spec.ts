import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type CardSize, PbCard } from "./card";

@Component({
  imports: [PbCard],
  template: `<pb-card [size]="size()"><h3>Angular</h3></pb-card>`,
})
class Host {
  readonly size = signal<CardSize>("md");
}

const render = async (size: CardSize) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.size.set(size);
  await fixture.whenStable();
  const card: HTMLElement = fixture.nativeElement.querySelector("pb-card");

  return card;
};

describe("PbCard", () => {
  it("wraps its content in the card style", async () => {
    const card = await render("md");

    expect(card.classList).toContain("pb-card");
    expect(card.classList).not.toContain("pb-card-lg");
    expect(card.querySelector("h3")?.textContent).toBe("Angular");
  });

  it("has a large size that fills its container", async () => {
    expect((await render("lg")).classList).toContain("pb-card-lg");
  });
});
