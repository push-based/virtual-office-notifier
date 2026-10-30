import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type ButtonSize, type ButtonVariant, PbButton } from "./button";

@Component({
  imports: [PbButton],
  template: `<button
    pbButton
    type="button"
    [variant]="variant()"
    [size]="size()"
    [fullWidth]="fullWidth()"
    [disabled]="disabled()"
    (click)="presses.update((count) => count + 1)"
  >
    Book a free call
  </button>`,
})
class Host {
  readonly variant = signal<ButtonVariant>("primary");

  readonly size = signal<ButtonSize>("md");

  readonly fullWidth = signal(false);

  readonly disabled = signal(false);

  readonly presses = signal(0);
}

const render = async () => {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const button: HTMLButtonElement = fixture.nativeElement.querySelector("button");

  return { fixture, host: fixture.componentInstance, button };
};

describe("PbButton", () => {
  it("is a primary, default-size button unless told otherwise", async () => {
    const { button } = await render();

    expect([...button.classList]).toEqual(expect.arrayContaining(["pb-btn", "pb-btn-primary"]));
    expect(button.classList).not.toContain("pb-btn-lg");
    expect(button.classList).not.toContain("pb-btn-full");
    expect(button.textContent?.trim()).toBe("Book a free call");
  });

  it("switches variant and size classes", async () => {
    const { fixture, host, button } = await render();

    host.variant.set("ghost");
    host.size.set("lg");
    await fixture.whenStable();

    expect([...button.classList]).toEqual(expect.arrayContaining(["pb-btn-ghost", "pb-btn-lg"]));
    expect(button.classList).not.toContain("pb-btn-primary");
  });

  it("can fill the width it's given", async () => {
    const { fixture, host, button } = await render();

    host.fullWidth.set(true);
    await fixture.whenStable();

    expect(button.classList).toContain("pb-btn-full");
  });

  it("passes presses through while enabled", async () => {
    const { host, button } = await render();

    button.click();

    expect(host.presses()).toBe(1);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  it("stays focusable but swallows presses while disabled", async () => {
    const { fixture, host, button } = await render();

    host.disabled.set(true);
    await fixture.whenStable();
    button.click();

    expect(host.presses()).toBe(0);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });
});
