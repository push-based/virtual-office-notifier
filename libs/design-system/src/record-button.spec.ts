import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbRecordButton } from "./record-button";

@Component({
  imports: [PbRecordButton],
  template: `
    <pb-record-button
      [recording]="recording()"
      [busy]="busy()"
      [disabled]="disabled()"
      (pressed)="presses.update((count) => count + 1)"
    />
  `,
})
class Host {
  readonly recording = signal(false);

  readonly busy = signal(false);

  readonly disabled = signal(false);

  readonly presses = signal(0);
}

@Component({
  imports: [PbRecordButton],
  template: `<pb-record-button startLabel="Record the call" stopLabel="End the call" />`,
})
class LabelledHost {}

const render = async () => {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();

  const button = (): HTMLButtonElement => fixture.nativeElement.querySelector("button");

  return { fixture, host: fixture.componentInstance, button };
};

describe("PbRecordButton", () => {
  it("offers to start, then to stop while recording", async () => {
    const { fixture, host, button } = await render();

    expect(button().textContent?.trim()).toBe("Start recording");

    host.recording.set(true);
    await fixture.whenStable();

    expect(button().textContent?.trim()).toBe("Stop recording");
    expect(fixture.nativeElement.querySelector("pb-record-button").classList).toContain(
      "recording",
    );
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

  it("takes its own labels", async () => {
    const fixture = TestBed.createComponent(LabelledHost);
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector("button").textContent?.trim()).toBe(
      "Record the call",
    );
  });
});
