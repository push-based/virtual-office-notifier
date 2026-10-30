import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import type { OfficePhase } from "../models";
import { StatusHeading } from "./status-heading";

@Component({
  imports: [StatusHeading],
  template: `<app-status-heading [phase]="phase()" [now]="now()" />`,
})
class Host {
  readonly phase = signal<OfficePhase>({ kind: "connecting" });

  readonly now = signal(Date.parse("2026-10-27T12:12:34Z"));
}

const render = async (phase: OfficePhase) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.phase.set(phase);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  const text = (selector: string) =>
    element.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();

  return {
    headline: text("h1"),
    detail: text("p"),
    live: element.querySelector("pb-live-dot") !== null,
  };
};

describe("StatusHeading", () => {
  it("explains a failed start", async () => {
    expect(await render({ kind: "failed", reason: "/api/config answered 502" })).toEqual({
      headline: "Couldn't start",
      detail: "/api/config answered 502",
      live: false,
    });
  });

  it("asks for patience while connecting", async () => {
    expect((await render({ kind: "connecting" })).headline).toBe("Connecting…");
  });

  it("explains why nothing can start while the bot is away", async () => {
    expect(await render({ kind: "away" })).toEqual({
      headline: "The bot isn't in the office yet",
      detail: "It joins once someone is in the voice channel.",
      live: false,
    });
  });

  it("invites a start when idle", async () => {
    expect((await render({ kind: "idle" })).headline).toBe("Not recording");
  });

  it("shows the running clock, who started it and the time left", async () => {
    const recording = {
      id: "1",
      startedAt: "2026-10-27T12:00:00Z",
      startedByName: "Chris",
      endsAt: "2026-10-27T12:59:34Z",
    };

    expect(await render({ kind: "recording", recording })).toEqual({
      headline: "Recording · 00:12:34",
      detail: "Started by Chris · 47m left",
      live: true,
    });
  });
});
