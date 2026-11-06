import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { ConsentStatus, SubmittedWithdrawal } from "recording-requests/wire";
import { of, Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RecorderSession } from "../recorder/session";
import { ConsentApi } from "./consent-api";
import { ConsentPanel } from "./consent-panel";

const agreed: ConsentStatus = {
  standing: "agreed",
  since: "2026-11-06T08:42:00.000Z",
  pendingWithdrawal: null,
};

const withdrawn: ConsentStatus = {
  standing: "withdrawn",
  since: "2026-11-06T09:00:00.000Z",
  pendingWithdrawal: null,
};

const setup = (statuses: ReadonlyArray<ConsentStatus>) => {
  const answers = new Subject<SubmittedWithdrawal>();
  let call = 0;

  const api = {
    status: vi.fn(() => of(statuses[Math.min(call++, statuses.length - 1)]!)),
    withdraw: vi.fn(() => of<SubmittedWithdrawal>({ id: 7, outcome: null })),
    find: vi.fn(() => answers),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: ConsentApi, useValue: api },
      { provide: RecorderSession, useValue: { token: signal("session") } },
    ],
  });

  const fixture = TestBed.createComponent(ConsentPanel);
  const element: HTMLElement = fixture.nativeElement;

  return { api, answers, fixture, element };
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
});
