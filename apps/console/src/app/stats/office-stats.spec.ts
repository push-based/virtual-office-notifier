import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { OfficeStats as Stats, StatsRange } from "recording-requests/wire";
import { type Observable, of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { RecorderSession } from "../recorder/session";
import { OfficeStats } from "./office-stats";
import { StatsApi } from "./stats-api";

const empty: Stats = {
  range: "week",
  since: "2026-10-25T22:00:00.000Z",
  until: "2026-10-27T12:00:00.000Z",
  timeInOffice: [],
  firstIn: [],
  lastOut: [],
  busiestHours: [],
  sounds: [],
  players: [],
  reactions: [],
  recordings: { count: 0, seconds: 0 },
};

const busy: Stats = {
  ...empty,
  timeInOffice: [{ userId: "ada", name: "Ada Lovelace", seconds: 19_800, days: 2 }],
  sounds: [{ sound: "airhorn", plays: 3 }],
  recordings: { count: 2, seconds: 5400 },
};

const setup = (stats: (range: StatsRange) => Observable<Stats>, token: string | null) => {
  const api = { stats: vi.fn(stats) };
  const session = { token: signal(token) };

  TestBed.configureTestingModule({
    providers: [
      { provide: StatsApi, useValue: api },
      { provide: RecorderSession, useValue: session },
    ],
  });

  const fixture = TestBed.createComponent(OfficeStats);
  const element: HTMLElement = fixture.nativeElement;

  return { api, session, fixture, element };
};

const textOf = (element: HTMLElement, selector: string) =>
  [...element.querySelectorAll(selector)].map((found) => found.textContent?.trim());

describe("OfficeStats", () => {
  it("loads this week's stats once it's opened", async () => {
    const { api, fixture, element } = setup(() => of(busy), "session");
    await fixture.whenStable();

    expect(api.stats).toHaveBeenCalledExactlyOnceWith("week");
    expect(textOf(element, "pb-stat .value")).toEqual(["2", "1h 30m"]);
    expect(textOf(element, "pb-bar-list .label")).toEqual(["Ada Lovelace", "airhorn"]);
    expect(element.querySelector("[role=tabpanel]")?.getAttribute("aria-labelledby")).toBe(
      "range-tab-week",
    );
  });

  it("loads the range that's picked", async () => {
    const { api, fixture, element } = setup(() => of(empty), "session");
    await fixture.whenStable();

    element.querySelectorAll<HTMLButtonElement>("pb-tabs button")[2]?.click();
    await fixture.whenStable();

    expect(api.stats.mock.calls).toEqual([["week"], ["all"]]);
    expect(element.querySelector("[role=tabpanel]")?.id).toBe("range-panel-all");
  });

  it("waits for the sign-in before asking", async () => {
    const { api, session, fixture, element } = setup(() => of(empty), null);
    await fixture.whenStable();

    expect(api.stats).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Counting…");

    session.token.set("session");
    await fixture.whenStable();

    expect(api.stats).toHaveBeenCalledExactlyOnceWith("week");
    expect(element.textContent).toContain("Nobody was in");
  });

  it("says why when the stats can't be counted", async () => {
    const { fixture, element } = setup(
      () => throwError(() => new Error("/api/stats answered 503")),
      "session",
    );

    await fixture.whenStable();

    expect(element.querySelector("pb-notice")?.textContent?.trim()).toBe(
      "Couldn't count the stats: /api/stats answered 503",
    );
  });

  it("counts again when asked after a failure", async () => {
    const answers = [throwError(() => new Error("/api/stats answered 503")), of(busy)];
    const { api, fixture, element } = setup(() => answers.shift() ?? of(empty), "session");
    await fixture.whenStable();

    const retry = element.querySelector<HTMLButtonElement>("button.retry");
    expect(retry?.textContent?.trim()).toBe("Try again");

    retry?.click();
    await fixture.whenStable();

    expect(api.stats.mock.calls).toEqual([["week"], ["week"]]);
    expect(element.querySelector("pb-notice")).toBeNull();
    expect(textOf(element, "pb-stat .value")).toEqual(["2", "1h 30m"]);
  });
});
