import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { of } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EditApi } from "../edits/edit-api";
import { RECORDER_TIMING } from "../recorder/timing";
import { NO_SUMMARY } from "./describe-recording";
import { recordingDetail } from "./fixtures";
import type { RecordingDetail } from "./models";
import { RecordingPage } from "./recording-page";

@Component({
  imports: [RecordingPage],
  template: `
    <app-recording-page
      [recording]="recording()"
      [now]="0"
      (back)="backs.set(backs() + 1)"
      (openInSlack)="opened.set($event)"
      (edited)="edits.set(edits() + 1)"
    />
  `,
})
class Host {
  readonly recording = signal<RecordingDetail>(recordingDetail());

  readonly backs = signal(0);

  readonly opened = signal<string | null>(null);

  readonly edits = signal(0);
}

const render = async (recording: RecordingDetail) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.recording.set(recording);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  return { fixture, element };
};

const texts = (element: HTMLElement, selector: string) =>
  [...element.querySelectorAll(selector)].map((found) => found.textContent?.trim());

const buttonNamed = (element: HTMLElement, name: string) =>
  [...element.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);

describe("RecordingPage", () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        {
          provide: EditApi,
          useValue: {
            submit: () => of({ id: 1, outcome: null }),
            find: () => of({ id: 1, outcome: "applied" }),
          },
        },
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
    }),
  );

  it("heads the page with the title, when it ran and the agenda when it has them", async () => {
    const { element } = await render(
      recordingDetail({ title: "Deploy retro", agenda: "• What broke\n• Who fixes it" }),
    );

    expect(element.querySelector("h2")?.textContent).toBe("Deploy retro");
    expect(element.querySelector("header p")?.textContent).toBe(
      "Thu 29 Oct, 14:05 · 1h 12m · Started by Anna · Stopped by Anna",
    );
    expect(element.querySelector(".agenda-text")?.textContent).toBe("• What broke\n• Who fixes it");
  });

  it("has no agenda section without an agenda", async () => {
    const { element } = await render(recordingDetail());

    expect(element.querySelector(".agenda")).toBeNull();
  });

  it("edits the title and agenda behind an Edit button, and says when it's saved", async () => {
    const { fixture, element } = await render(recordingDetail({ title: "Deploy retro" }));

    buttonNamed(element, "Edit")?.click();
    await fixture.whenStable();

    expect(element.querySelector("app-recording-editor input")?.getAttribute("value")).toBeNull();
    expect(element.querySelector<HTMLInputElement>("app-recording-editor input")?.value).toBe(
      "Deploy retro",
    );

    buttonNamed(element, "Cancel")?.click();
    await fixture.whenStable();

    expect(fixture.componentInstance.edits()).toBe(0);
  });

  it("heads the page with when it ran, who started it and how it stopped", async () => {
    const { element } = await render(recordingDetail());

    expect(element.querySelector("h2")?.textContent).toBe("Thu 29 Oct, 14:05");
    expect(element.querySelector("pb-badge")?.textContent).toBe("Finished");
    expect(element.querySelector("header p")?.textContent).toBe(
      "1h 12m · Started by Anna · Stopped by Anna",
    );
    expect(
      [...element.querySelectorAll("header pb-avatar")].map((avatar) =>
        avatar.getAttribute("title"),
      ),
    ).toEqual(["Anna", "Ben"]);
  });

  it("shows the summary as posted in Slack, with the model that wrote it", async () => {
    const { element } = await render(recordingDetail());

    expect(element.querySelector(".summary")?.textContent).toBe("• Anna said hello");
    expect(element.querySelector(".footer")?.textContent).toBe("✨ Summary by model");
  });

  it("says no model wrote a summary when none could", async () => {
    const { element } = await render(recordingDetail({ summary: null, summaryModel: null }));

    expect(element.querySelector(".summary")?.textContent).toBe(NO_SUMMARY);
    expect(element.querySelector(".footer")).toBeNull();
  });

  it("lists the action items under the summary", async () => {
    const { element } = await render(recordingDetail());

    const sections = [...element.querySelectorAll("[pbEyebrow]")].map((eyebrow) =>
      eyebrow.textContent?.trim(),
    );

    expect(sections).toEqual(["Who spoke", "Summary", "Action items", "Transcript"]);
    expect(texts(element, "app-action-items .text")).toEqual([
      "write up the deploy checklist",
      "ask IT about the VPN",
      "book the room for Thursday",
    ]);
  });

  it("refreshes the recording once an action item edit is applied", async () => {
    const { fixture, element } = await render(recordingDetail());

    element.querySelector<HTMLInputElement>("app-action-items .tick")?.click();

    await vi.waitFor(() => expect(fixture.componentInstance.edits()).toBe(1));
  });

  it("groups the transcript by who spoke, and says nothing more is coming once finished", async () => {
    const { element } = await render(recordingDetail());

    expect(texts(element, ".turn .name")).toEqual(["Anna", "Ben"]);
    expect(texts(element, ".turn .time")).toEqual(["14:06", "14:07"]);
    expect(texts(element, ".turn .line")).toEqual(["Hello", "Anyone there?", "Morning"]);
    expect(element.querySelector(".more")).toBeNull();
  });

  it("shows the transcript so far while transcribing, without a summary", async () => {
    const { element } = await render(
      recordingDetail({ state: "transcribing", summary: null, slackPermalink: null }),
    );

    expect(element.querySelector(".summary")).toBeNull();
    expect(element.querySelector("app-action-items")).toBeNull();
    expect(buttonNamed(element, "Open in Slack")).toBeUndefined();
    expect(element.querySelector(".more")?.textContent).toBe("More on the way…");
  });

  it("opens the Slack post and goes back when asked", async () => {
    const { fixture, element } = await render(recordingDetail());

    buttonNamed(element, "Open in Slack")?.click();
    buttonNamed(element, "← Back")?.click();

    expect(fixture.componentInstance.opened()).toBe("https://office.slack.com/archives/C1/p12");
    expect(fixture.componentInstance.backs()).toBe(1);
  });
});
