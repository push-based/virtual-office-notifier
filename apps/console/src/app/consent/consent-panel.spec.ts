import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type {
  ConsentStatus,
  ErasureCase,
  SubmittedErasure,
  SubmittedWithdrawal,
} from "recording-requests/wire";
import { of, Subject, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RecorderSession } from "../recorder/session";
import { ConsentApi } from "./consent-api";
import { ConsentPanel } from "./consent-panel";

const agreed: ConsentStatus = {
  standing: "agreed",
  since: "2026-11-06T08:42:00.000Z",
  pendingWithdrawal: null,
  pendingErasure: null,
  refusedErasure: null,
  admin: false,
};

const withdrawn: ConsentStatus = {
  ...agreed,
  standing: "withdrawn",
  since: "2026-11-06T09:00:00.000Z",
};

const scheduled: ConsentStatus = {
  ...agreed,
  pendingErasure: {
    id: 9,
    requestedAt: "2026-11-08T12:00:00.000Z",
    dueAt: "2026-12-08T12:00:00.000Z",
    decision: null,
  },
};

const cancelling: ConsentStatus = {
  ...scheduled,
  pendingErasure: { ...scheduled.pendingErasure!, decision: "cancelled" },
};

const refused: ConsentStatus = {
  ...withdrawn,
  refusedErasure: {
    id: 9,
    refusedAt: "2026-11-09T09:00:00.000Z",
    ground: "legal_claim",
    reason: "The recording of 3 November is evidence in a dispute with a supplier.",
  },
};

const submittedErasure: SubmittedErasure = {
  id: 9,
  outcome: null,
  dueAt: "2026-12-08T12:00:00.000Z",
};

const setup = (statuses: ReadonlyArray<ConsentStatus>, cases: ReadonlyArray<ErasureCase> = []) => {
  const answers = new Subject<SubmittedWithdrawal>();
  const openedLinks: Array<string> = [];
  let call = 0;

  const api = {
    status: vi.fn(() => of(statuses[Math.min(call++, statuses.length - 1)]!)),
    withdraw: vi.fn(() => of<SubmittedWithdrawal>({ id: 7, outcome: null })),
    find: vi.fn(() => answers),
    erase: vi.fn(() => of(submittedErasure)),
    findErasure: vi.fn(() => of(submittedErasure)),
    cancelErasure: vi.fn(() => of(submittedErasure)),
    cases: vi.fn(() => of(cases)),
    expedite: vi.fn(() => of(submittedErasure)),
    seen: vi.fn(() => of(submittedErasure)),
    refuse: vi.fn(() => of(submittedErasure)),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: ConsentApi, useValue: api },
      {
        provide: RecorderSession,
        useValue: {
          token: signal("session"),
          openExternalLink: (url: string) => {
            openedLinks.push(url);

            return Promise.resolve();
          },
        },
      },
    ],
  });

  const fixture = TestBed.createComponent(ConsentPanel);
  const element: HTMLElement = fixture.nativeElement;

  return { api, answers, openedLinks, fixture, element };
};

const settle = async (fixture: { detectChanges(): void }) => {
  await vi.advanceTimersByTimeAsync(0);
  fixture.detectChanges();
};

const buttonNamed = (element: HTMLElement, name: string) =>
  [...element.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);

describe("ConsentPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows when you agreed and what the office records", async () => {
    const { element, fixture } = setup([agreed]);
    await settle(fixture);

    expect(element.querySelector("h2")?.textContent?.trim()).toBe("You agreed to being recorded");
    expect(element.querySelectorAll("li")).toHaveLength(3);
    expect(buttonNamed(element, "Withdraw consent")).toBeDefined();
    expect(element.querySelector("app-erasure-admin")).toBeNull();
  });

  it("asks you to confirm, then withdraws and waits for the bot", async () => {
    const { api, answers, element, fixture } = setup([agreed, withdrawn]);
    await settle(fixture);

    buttonNamed(element, "Withdraw consent")?.click();
    await settle(fixture);

    expect(element.textContent).toContain("Withdrawing shows you out of the office straight away");

    buttonNamed(element, "Withdraw my consent")?.click();
    await settle(fixture);

    expect(api.withdraw).toHaveBeenCalledOnce();
    expect(buttonNamed(element, "Withdrawing…")).toBeDefined();

    await vi.advanceTimersByTimeAsync(2_000);
    answers.next({ id: 7, outcome: "withdrawn" });
    await settle(fixture);

    expect(api.find).toHaveBeenCalledWith(7);
    expect(element.querySelector("pb-notice")?.textContent).toContain("Your consent is withdrawn");
    expect(element.querySelector("h2")?.textContent?.trim()).toBe("You withdrew your consent");
    expect(buttonNamed(element, "Withdraw consent")).toBeUndefined();
  });

  it("lets you keep your consent", async () => {
    const { api, element, fixture } = setup([agreed]);
    await settle(fixture);

    buttonNamed(element, "Withdraw consent")?.click();
    await settle(fixture);
    buttonNamed(element, "Keep it")?.click();
    await settle(fixture);

    expect(api.withdraw).not.toHaveBeenCalled();
    expect(buttonNamed(element, "Withdraw consent")).toBeDefined();
  });

  it("asks you to confirm, then schedules the deletion and shows the date", async () => {
    const { api, element, fixture } = setup([agreed, scheduled]);
    await settle(fixture);

    expect(element.textContent).toContain("The deletion runs 30 days later");

    buttonNamed(element, "Delete my data")?.click();
    await settle(fixture);

    expect(element.textContent).toContain("Once it runs, this can't be undone.");

    buttonNamed(element, "Delete everything")?.click();
    await settle(fixture);

    expect(api.erase).toHaveBeenCalledOnce();
    expect(element.querySelector("pb-notice")?.textContent).toContain(
      "the office admins have been told",
    );
    expect(element.querySelector("h2")?.textContent?.trim()).toBe(
      "Your data will be deleted on Tue 8 Dec, 14:00, UTC+2",
    );
    expect(buttonNamed(element, "Delete my data")).toBeUndefined();
    expect(buttonNamed(element, "Withdraw consent")).toBeUndefined();
    expect(buttonNamed(element, "Cancel the deletion")).toBeDefined();
  });

  it("lets you cancel the deletion until it runs", async () => {
    const { api, element, fixture } = setup([scheduled, cancelling]);
    await settle(fixture);

    buttonNamed(element, "Cancel the deletion")?.click();
    await settle(fixture);

    expect(element.textContent).toContain("Cancelling keeps everything as it is");

    buttonNamed(element, "Cancel the deletion")?.click();
    await settle(fixture);

    expect(api.cancelErasure).toHaveBeenCalledWith(9);
    expect(element.querySelector("pb-notice")?.textContent).toContain(
      "Your deletion request is cancelled",
    );
    expect(element.querySelector("h2")?.textContent?.trim()).toBe(
      "Cancelling your deletion request…",
    );
  });

  it("says so when the request couldn't be cancelled", async () => {
    const { api, element, fixture } = setup([scheduled]);
    api.cancelErasure.mockReturnValue(throwError(() => new Error("/api answered 404")));
    await settle(fixture);

    buttonNamed(element, "Cancel the deletion")?.click();
    await settle(fixture);
    buttonNamed(element, "Cancel the deletion")?.click();
    await settle(fixture);

    expect(element.querySelector("pb-notice")?.textContent).toContain(
      "Couldn't cancel the request",
    );
  });

  it("shows why a deletion was refused, with the way to complain", async () => {
    const { element, fixture, openedLinks } = setup([refused]);
    await settle(fixture);

    expect(element.textContent).toContain("Why your data wasn't deleted");
    expect(element.textContent).toContain("an ongoing legal claim that needs it");
    expect(element.querySelector("blockquote")?.textContent).toContain("evidence in a dispute");
    expect(buttonNamed(element, "Delete my data")).toBeDefined();

    buttonNamed(element, "Data protection authorities")?.click();

    expect(openedLinks).toEqual(["https://www.edpb.europa.eu/about-edpb/about-edpb/members_en"]);
  });

  it("shows the admins the requests to review", async () => {
    const { element, fixture } = setup([{ ...agreed, admin: true }]);
    await settle(fixture);

    expect(element.querySelector("app-erasure-admin")).not.toBeNull();
  });
});
