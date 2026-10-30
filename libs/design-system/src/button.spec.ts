import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type ButtonSize, type ButtonVariant, PbButton } from "./button";

@Component({
  imports: [PbButton],
  template: `<button pbButton type="button" [variant]="variant()" [size]="size()">
    Book a free call
  </button>`,
})
class Host {
  readonly variant = signal<ButtonVariant>("primary");

  readonly size = signal<ButtonSize>("md");
}

describe("PbButton", () => {
  it("is a primary, default-size button unless told otherwise", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector("button");

    expect([...button.classList]).toEqual(expect.arrayContaining(["pb-btn", "pb-btn-primary"]));
    expect(button.classList).not.toContain("pb-btn-lg");
    expect(button.textContent).toBe("Book a free call");
  });

  it("switches variant and size classes", async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.variant.set("ghost");
    fixture.componentInstance.size.set("lg");
    await fixture.whenStable();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector("button");

    expect([...button.classList]).toEqual(expect.arrayContaining(["pb-btn-ghost", "pb-btn-lg"]));
    expect(button.classList).not.toContain("pb-btn-primary");
  });
});
