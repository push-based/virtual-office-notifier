import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { type Observable, of } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { RecorderSession } from "../recorder/session";
import { listedRecording, recordingDetail } from "./fixtures";
import { HistoryApi } from "./history-api";
import type { RecordingDetail, RecordingPage } from "./models";
import { RecordingHistory } from "./recording-history";

const page: RecordingPage = {
  recordings: [
    listedRecording({ id: "r3", state: "running", stoppedAt: null, speakers: [] }),
    listedRecording({ id: "r2" }),
    listedRecording({ id: "r4", title: "Deploy retro" }),
    listedRecording({ id: "r1", state: "silent", speakers: [] }),
  ],
  older: "2026-10-29T12:05:00.000Z",
};

const render = async () => {
  const api = {
    page: vi.fn<(before: string | null) => Observable<RecordingPage>>(() => of(page)),
    recording: vi.fn<(id: string) => Observable<RecordingDetail>>((id) =>
      of(recordingDetail({ id })),
    ),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: HistoryApi, useValue: api },
      { provide: RecorderSession, useValue: { token: signal("session-1") } },
    ],
  });

  const fixture = TestBed.createComponent(RecordingHistory);
  fixture.componentRef.setInput("now", Date.parse("2026-10-29T14:00:00Z"));
  const element: HTMLElement = fixture.nativeElement;

  await vi.waitFor(async () => {
    await fixture.whenStable();
    expect(element.querySelectorAll("app-recording-row").length).toBe(4);
  });

  return { fixture, element, api };
};

describe("RecordingHistory", () => {
  it("lists every recording with its state, and only opens those with something to show", async () => {
    const { element } = await render();
    const rows = [...element.querySelectorAll("app-recording-row")];

    expect(rows.map((row) => row.querySelector("pb-badge")?.textContent)).toEqual([
      "Running",
      "Finished",
      "Finished",
      "Silent",
    ]);
    expect(rows.map((row) => row.querySelector("button.row") !== null)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(rows[1]?.querySelector(".when")?.textContent).toBe("Thu 29 Oct, 14:05");
    expect(rows[1]?.querySelector("[pbDescription]")?.textContent).toBe("1h 12m · Started by Anna");
    expect(rows[2]?.querySelector(".when")?.textContent).toBe("Deploy retro");
    expect(rows[2]?.querySelector("[pbDescription]")?.textContent).toBe(
      "Thu 29 Oct, 14:05 · 1h 12m · Started by Anna",
    );
    expect(element.textContent).toContain("Show older");
  });

  it("replaces the list with a recording's page, and goes back", async () => {
    const { fixture, element, api } = await render();

    element.querySelector<HTMLButtonElement>("app-recording-row button.row")?.click();

    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector("app-recording-page h2")?.textContent).toBe("Thu 29 Oct, 14:05");
    });

    expect(api.recording).toHaveBeenCalledWith("r3");
    expect(element.querySelector("app-recording-row")).toBeNull();

    element.querySelector<HTMLButtonElement>("app-recording-page .back")?.click();

    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll("app-recording-row").length).toBe(4);
    });

    expect(element.querySelector("app-recording-page")).toBeNull();
  });
});
