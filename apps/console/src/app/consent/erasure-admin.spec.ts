import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ErasureCase, SubmittedErasure } from "recording-requests/wire";
import { of, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RecorderSession } from "../recorder/session";
import { ConsentApi } from "./consent-api";
import { ErasureAdmin } from "./erasure-admin";

const erasure: ErasureCase = {
  id: 12,
  userId: "u-ada",
  displayName: "Ada",
  requestedAt: "2026-11-08T12:00:00.000Z",
  dueAt: "2026-12-08T12:00:00.000Z",
  decision: null,
  decidedBy: null,
  decidedByName: null,
  refusal: null,
  seenBy: [],
  seenByNames: [],
  inventory: {
    voiceActivity: 41,
    soundsAndEmoji: 3,
    slackMessages: 2,
    slackReactions: 5,
    clips: 17,
    audioFiles: 17,
    recordingsSpokenIn: 2,
    recordingsStartedStoppedOrPaused: 1,
    recordingRequests: 1,
    recordingEdits: 0,
    actionItemsOwned: 1,
    names: ["Ada", "Ada Lovelace"],
    linesMentioningThem: 4,
    recordingTextsMentioningThem: 1,
    slackPostsMentioningThem: 2,
    slackMessagesMentioningThem: 0,
  },
};

const submitted: SubmittedErasure = { id: 12, outcome: null, dueAt: "2026-12-08T12:00:00.000Z" };

const setup = (cases: ReadonlyArray<ReadonlyArray<ErasureCase>>) => {
  let call = 0;

  const api = {
    cases: vi.fn(() => of(cases[Math.min(call++, cases.length - 1)]!)),
    expedite: vi.fn(() => of(submitted)),
    seen: vi.fn(() => of(submitted)),
    refuse: vi.fn(() => of(submitted)),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: ConsentApi, useValue: api },
      { provide: RecorderSession, useValue: { token: signal("session") } },
    ],
  });

  const fixture = TestBed.createComponent(ErasureAdmin);
  const element: HTMLElement = fixture.nativeElement;

  return { api, fixture, element };
};

const settle = async (fixture: { detectChanges(): void }) => {
  await vi.advanceTimersByTimeAsync(0);
  fixture.detectChanges();
};

const buttonNamed = (element: HTMLElement, name: string) =>
  [...element.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);

describe("ErasureAdmin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists each request with exactly what will be deleted", async () => {
    const { element, fixture } = setup([[erasure]]);
    await settle(fixture);

    expect(element.querySelector("h3")?.textContent).toContain("Ada");
    expect(element.textContent).toContain("Asked on Sun 8 Nov, 14:00, UTC+2");
    expect(element.textContent).toContain("deleted on Tue 8 Dec, 14:00, UTC+2");
    expect(element.textContent).toContain("Nobody has looked at it yet");

    const lines = [...element.querySelectorAll("li")].map((item) => item.textContent?.trim());

    expect(lines[0]).toBe(
      "41 voice activity rows: joins, leaves, mutes, cameras and screen shares",
    );
    expect(lines[3]).toContain("17 spoken lines in 2 recordings, with 17 audio files");
    expect(lines[6]).toContain(
      "Their name (Ada, Ada Lovelace) taken out of 4 other people's lines",
    );
    expect(lines).toHaveLength(8);
  });

  it("says when nobody has asked", async () => {
    const { element, fixture } = setup([[]]);
    await settle(fixture);

    expect(element.textContent).toContain("Nobody has asked for their data to be deleted.");
  });

  it("asks before deleting now, then does", async () => {
    const { api, element, fixture } = setup([
      [erasure],
      [
        {
          ...erasure,
          decision: "now",
          decidedBy: "553340374836314142",
          decidedByName: "Christopher Holder",
        },
      ],
    ]);

    await settle(fixture);

    buttonNamed(element, "Delete now")?.click();
    await settle(fixture);

    expect(element.textContent).toContain(
      "runs the deletion within a minute, and it can't be undone",
    );

    buttonNamed(element, "Delete now")?.click();
    await settle(fixture);

    expect(api.expedite).toHaveBeenCalledWith(12);
    expect(element.querySelector("pb-notice")?.textContent).toContain(
      "The bot deletes it within a minute",
    );
    expect(element.textContent).toContain("Christopher Holder asked for it to run now");
    expect(buttonNamed(element, "Delete now")).toBeUndefined();
  });

  it("notes that an admin has seen it", async () => {
    const { api, element, fixture } = setup([
      [erasure],
      [
        {
          ...erasure,
          seenBy: ["757606441010855957", "no-longer-an-admin"],
          seenByNames: ["Julian Jandl", null],
        },
      ],
    ]);

    await settle(fixture);

    buttonNamed(element, "Let it run")?.click();
    await settle(fixture);

    expect(api.seen).toHaveBeenCalledWith(12);
    expect(element.textContent).toContain("Seen by Julian Jandl and an admin.");
  });

  it("refuses only with a ground and a reason", async () => {
    const { api, element, fixture } = setup([[erasure]]);
    await settle(fixture);

    buttonNamed(element, "Refuse…")?.click();
    await settle(fixture);

    const submit = buttonNamed(element, "Refuse the deletion");

    expect(submit?.getAttribute("aria-disabled")).toBe("true");

    const select = element.querySelector("select")!;

    select.value = "legal_claim";
    select.dispatchEvent(new Event("change"));

    const textarea = element.querySelector("textarea")!;

    textarea.value = "  The 3 November recording is evidence in a dispute.  ";
    textarea.dispatchEvent(new Event("input"));
    await settle(fixture);

    expect(submit?.getAttribute("aria-disabled")).toBeNull();

    element.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(fixture);

    expect(api.refuse).toHaveBeenCalledWith(12, {
      ground: "legal_claim",
      reason: "The 3 November recording is evidence in a dispute.",
    });
    expect(element.querySelector("pb-notice")?.textContent).toContain(
      "Refused. They'll be told why",
    );
  });

  it("says when a request was already decided", async () => {
    const { api, element, fixture } = setup([[erasure]]);
    api.seen.mockReturnValue(
      throwError(() => new Error("/api/admin/erasures/12/seen answered 404")),
    );
    await settle(fixture);

    buttonNamed(element, "Let it run")?.click();
    await settle(fixture);

    expect(element.querySelector("pb-notice")?.textContent).toContain("already decided");
  });
});
