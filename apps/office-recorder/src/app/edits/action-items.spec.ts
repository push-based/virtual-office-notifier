import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { type Observable, of } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";

import { anna, ben } from "../history/fixtures";
import { RECORDER_TIMING } from "../recorder/timing";
import {
  ActionItems,
  NO_ACTION_ITEMS,
  NONE_TAKEN_ON,
  ownerChoices,
  reassignOf,
  tickOf,
} from "./action-items";
import { EditApi } from "./edit-api";
import type { ActionItem, OfficeMember, RecordingChange, SubmittedEdit } from "./models";

const checklist: ActionItem = {
  id: 4,
  text: "write up the deploy checklist",
  owner: anna,
  done: false,
};

const vpn: ActionItem = { id: 5, text: "ask IT about the VPN", owner: null, done: false };

const room: ActionItem = { id: 6, text: "book the room for Thursday", owner: ben, done: true };

@Component({
  imports: [ActionItems],
  template: `
    <app-action-items
      recordingId="r1"
      [items]="items()"
      [members]="members()"
      (saved)="saves.set(saves() + 1)"
    />
  `,
})
class Host {
  readonly items = signal<ReadonlyArray<ActionItem> | null>([checklist, vpn, room]);

  readonly members = signal<ReadonlyArray<OfficeMember>>([anna, ben]);

  readonly saves = signal(0);
}

const fakeApi = () => ({
  submit: vi.fn<(recordingId: string, change: RecordingChange) => Observable<SubmittedEdit>>(() =>
    of({ id: 1, outcome: null }),
  ),
  find: vi.fn<(id: number) => Observable<SubmittedEdit>>(() => of({ id: 1, outcome: "applied" })),
});

const render = async (items: ReadonlyArray<ActionItem> | null = [checklist, vpn, room]) => {
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
  fixture.componentInstance.items.set(items);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  return { fixture, element, api };
};

const rows = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(".item")];

describe("ActionItems", () => {
  it("lists each item with its owner's avatar and name or Unassigned, and whether it's done", async () => {
    const { element } = await render();

    expect(rows(element).map((row) => row.querySelector(".text")?.textContent)).toEqual([
      "write up the deploy checklist",
      "ask IT about the VPN",
      "book the room for Thursday",
    ]);
    expect(
      rows(element).map((row) => row.querySelector("pb-avatar")?.getAttribute("title") ?? null),
    ).toEqual(["Anna", null, "Ben"]);
    expect(
      rows(element).map((row) => {
        const choice = row.querySelector("select");

        return choice?.selectedOptions[0]?.textContent?.trim();
      }),
    ).toEqual(["Anna", "Unassigned", "Ben"]);
    expect(
      rows(element).map((row) => row.querySelector<HTMLInputElement>(".tick")?.checked),
    ).toEqual([false, false, true]);
    expect(rows(element).map((row) => row.classList.contains("done"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("offers Unassigned and everyone from the office as the owner", async () => {
    const { element } = await render();

    expect(
      [...(rows(element)[0]?.querySelectorAll("option") ?? [])].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Unassigned", "Anna", "Ben"]);
  });

  it("ticks an item as a recording edit and says so once the bot has applied it", async () => {
    const { fixture, element, api } = await render();

    rows(element)[0]?.querySelector<HTMLInputElement>(".tick")?.click();
    fixture.detectChanges();

    expect(api.submit).toHaveBeenCalledWith("r1", { kind: "tick", item: 4 });
    expect(rows(element)[1]?.querySelector<HTMLInputElement>(".tick")?.disabled).toBe(true);

    await vi.waitFor(() => expect(fixture.componentInstance.saves()).toBe(1));
  });

  it("unticks a done item and changes an owner", async () => {
    const { fixture, element, api } = await render();

    rows(element)[2]?.querySelector<HTMLInputElement>(".tick")?.click();
    await vi.waitFor(() => expect(fixture.componentInstance.saves()).toBe(1));
    await fixture.whenStable();

    const choice = rows(element)[1]?.querySelector("select");
    expect(choice).not.toBeNull();
    choice!.value = "u2";
    choice!.dispatchEvent(new Event("change"));

    expect(api.submit.mock.calls).toEqual([
      ["r1", { kind: "untick", item: 6 }],
      ["r1", { kind: "reassign", item: 5, owner: "u2" }],
    ]);
  });

  it("says when nobody took anything on, and when no model could pull the items out", async () => {
    const empty = await render([]);
    expect(empty.element.querySelector("li")?.textContent?.trim()).toBe(NONE_TAKEN_ON);

    TestBed.resetTestingModule();

    const none = await render(null);
    expect(none.element.querySelector("p[pbDescription]")?.textContent).toBe(NO_ACTION_ITEMS);
    expect(none.element.querySelector(".item")).toBeNull();
  });
});

describe("tickOf and reassignOf", () => {
  it("ticks an open item and unticks a done one", () => {
    expect(tickOf(checklist)).toEqual({ kind: "tick", item: 4 });
    expect(tickOf(room)).toEqual({ kind: "untick", item: 6 });
  });

  it("gives an item to someone or to nobody, and changes nothing when the owner stays", () => {
    expect(reassignOf(vpn, "u1")).toEqual([{ kind: "reassign", item: 5, owner: "u1" }]);
    expect(reassignOf(checklist, "")).toEqual([{ kind: "reassign", item: 4, owner: null }]);
    expect(reassignOf(checklist, "u1")).toEqual([]);
    expect(reassignOf(vpn, "")).toEqual([]);
  });

  it("keeps an owner who isn't among the office members as a choice", () => {
    const carla: OfficeMember = { userId: "u9", name: "Carla", avatarUrl: null };

    expect(ownerChoices([anna, ben], carla)).toEqual([carla, anna, ben]);
    expect(ownerChoices([anna, ben], anna)).toEqual([anna, ben]);
    expect(ownerChoices([anna, ben], null)).toEqual([anna, ben]);
  });
});
