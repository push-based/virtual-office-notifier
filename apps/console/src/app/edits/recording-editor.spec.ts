import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { type Observable, of } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { RECORDER_TIMING } from "../recorder/timing";
import { EditApi } from "./edit-api";
import type { RecordingChange, SubmittedEdit } from "./models";
import { RecordingEditor } from "./recording-editor";

@Component({
  imports: [RecordingEditor],
  template: `
    <app-recording-editor
      recordingId="r1"
      [currentTitle]="title()"
      [currentAgenda]="agenda()"
      currentSummaryStyle="brief"
      (saved)="saves.set(saves() + 1)"
    />
  `,
})
class Host {
  readonly title = signal<string | null>("Deploy retro");

  readonly agenda = signal<string | null>(null);

  readonly saves = signal(0);
}

const fakeApi = () => ({
  submit: vi.fn<(recordingId: string, change: RecordingChange) => Observable<SubmittedEdit>>(() =>
    of({ id: 1, outcome: null }),
  ),
  find: vi.fn<(id: number) => Observable<SubmittedEdit>>(() => of({ id: 1, outcome: "applied" })),
});

const render = async () => {
  const api = fakeApi();
  TestBed.configureTestingModule({
    providers: [
      { provide: EditApi, useValue: api },
      {
        provide: RECORDER_TIMING,
        useValue: {
          statePollMs: 3000,
          clockTickMs: 1000,
          requestPollMs: 5,
          requestPollLimit: 10,
          noticeMs: 6000,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  return { fixture, element, api };
};

const buttonNamed = (element: HTMLElement, name: string) =>
  [...element.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);

const type = (control: HTMLInputElement | HTMLTextAreaElement | null, text: string) => {
  expect(control).not.toBeNull();
  control!.value = text;
  control!.dispatchEvent(new Event("input"));
};

describe("RecordingEditor", () => {
  it("opens on Edit with the current title and agenda filled in", async () => {
    const { fixture, element } = await render();

    expect(element.querySelector("input")).toBeNull();

    buttonNamed(element, "Edit")?.click();
    await fixture.whenStable();

    expect(element.querySelector("input")?.value).toBe("Deploy retro");
    expect(element.querySelector("textarea")?.value).toBe("");
  });

  it("shows Saving… until the bot has applied the change, then closes", async () => {
    const { fixture, element, api } = await render();
    api.find.mockReturnValueOnce(of({ id: 1, outcome: null }));

    buttonNamed(element, "Edit")?.click();
    await fixture.whenStable();
    type(element.querySelector("textarea"), "What broke on Friday");
    buttonNamed(element, "Save")?.click();
    fixture.detectChanges();

    expect(api.submit).toHaveBeenCalledWith("r1", {
      kind: "agenda",
      agenda: "What broke on Friday",
    });
    expect(buttonNamed(element, "Saving…")?.getAttribute("aria-disabled")).toBe("true");
    expect(element.querySelector("input")?.disabled).toBe(true);

    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector("input")).toBeNull();
    });

    expect(api.find).toHaveBeenCalledTimes(2);
    expect(buttonNamed(element, "Edit")).toBeDefined();
    expect(fixture.componentInstance.saves()).toBe(1);
  });

  it("clears the title when it's emptied", async () => {
    const { fixture, element, api } = await render();

    buttonNamed(element, "Edit")?.click();
    await fixture.whenStable();
    type(element.querySelector("input"), "  ");
    buttonNamed(element, "Save")?.click();

    expect(api.submit).toHaveBeenCalledWith("r1", { kind: "title", title: null });
  });

  it("changes the summary style as an edit of its own", async () => {
    const { fixture, element, api } = await render();

    buttonNamed(element, "Edit")?.click();
    await fixture.whenStable();

    const select = element.querySelector("select");
    expect(select?.value).toBe("brief");

    select!.value = "decisions";
    select!.dispatchEvent(new Event("change"));
    buttonNamed(element, "Save")?.click();

    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenCalledWith("r1", { kind: "summary_style", style: "decisions" });
  });

  it("closes without sending anything on Cancel", async () => {
    const { fixture, element, api } = await render();

    buttonNamed(element, "Edit")?.click();
    await fixture.whenStable();
    type(element.querySelector("input"), "Something else");
    buttonNamed(element, "Cancel")?.click();
    await fixture.whenStable();

    expect(element.querySelector("input")).toBeNull();
    expect(api.submit).not.toHaveBeenCalled();
  });
});
