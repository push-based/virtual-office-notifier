import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbPeople, type Person } from "./people";

@Component({
  imports: [PbPeople],
  template: `<pb-people [people]="people()" label="Spoke" />`,
})
class Host {
  readonly people = signal<ReadonlyArray<Person>>([
    { id: "1", name: "Ada Lovelace", avatarUrl: null },
    { id: "2", name: "Linus Torvalds", avatarUrl: "https://cdn.example/linus.png" },
  ]);
}

describe("PbPeople", () => {
  it("shows each person as an avatar in a labelled list", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const list = element.querySelector("ul");

    expect(
      [...element.querySelectorAll("li > pb-avatar")].map((avatar) => avatar.getAttribute("title")),
    ).toEqual(["Ada Lovelace", "Linus Torvalds"]);
    expect(element.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example/linus.png");
    expect(element.querySelector(`#${list?.getAttribute("aria-labelledby")}`)?.textContent).toBe(
      "Spoke",
    );
  });

  it("follows the list as people come and go", async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.people.set([{ id: "3", name: "Grace Hopper", avatarUrl: null }]);
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelectorAll("pb-avatar").length).toBe(1);
  });
});
