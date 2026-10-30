import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type Bar, PbBarList } from "./bar-list";

@Component({
  imports: [PbBarList],
  template: `<pb-bar-list label="Most played" [items]="items()" empty="No sounds yet" />`,
})
class Host {
  readonly items = signal<ReadonlyArray<Bar>>([
    { id: "airhorn", label: "airhorn", value: 4, display: "4" },
    { id: "bruh", label: "bruh", value: 1, display: "1" },
  ]);
}

describe("PbBarList", () => {
  it("lists each item under its label, with bars relative to the largest", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const list = element.querySelector("ol");

    expect(element.querySelector(`#${list?.getAttribute("aria-labelledby")}`)?.textContent).toBe(
      "Most played",
    );
    expect(
      [...element.querySelectorAll("li")].map((item) => [
        item.querySelector(".label")?.textContent,
        item.querySelector(".value")?.textContent,
      ]),
    ).toEqual([
      ["airhorn", "4"],
      ["bruh", "1"],
    ]);
    expect(
      [...element.querySelectorAll<HTMLElement>(".bar")].map((bar) => bar.style.width),
    ).toEqual(["100%", "25%"]);
  });

  it("says so when there's nothing to list", async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.items.set([]);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;

    expect(element.querySelector("ol")).toBeNull();
    expect(element.textContent).toContain("No sounds yet");
  });
});
