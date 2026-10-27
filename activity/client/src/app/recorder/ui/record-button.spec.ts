import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { RecordButton } from "./record-button";

@Component({
  imports: [RecordButton],
  template: `
    <app-record-button [recording]="recording()" [busy]="busy()" [disabled]="disabled()" (pressed)="presses.update((count) => count + 1)" />
  `,
})
class Host {
  readonly recording = signal(false);

  readonly busy = signal(false);

  readonly disabled = signal(false);

  readonly presses = signal(0);
}

const render = async () => {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();

  const button = (): HTMLButtonElement => fixture.nativeElement.querySelector("button");

  return { fixture, host: fixture.componentInstance, button };
};

describe("RecordButton", () => {
  it("offers to start, then to stop while recording", async () => {
    const { fixture, host, button } = await render();

    expect(button().textContent?.trim()).toBe("Start recording");

    host.recording.set(true);
    await fixture.whenStable();

    expect(button().textContent?.trim()).toBe("Stop recording");
    expect(fixture.nativeElement.querySelector("app-record-button").classList).toContain("recording");
  });

  it("reports a press", async () => {
    const { host, button } = await render();

    button().click();

    expect(host.presses()).toBe(1);
  });

  it("stays focusable but ignores presses while unavailable", async () => {
    const { fixture, host, button } = await render();

    host.disabled.set(true);
    host.busy.set(true);
    await fixture.whenStable();
    button().click();

    expect(host.presses()).toBe(0);
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().getAttribute("aria-busy")).toBe("true");
  });
});
