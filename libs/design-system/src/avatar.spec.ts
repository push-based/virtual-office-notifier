import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { PbAvatar } from "./avatar";
import { PbAvatarGroup } from "./avatar-group";

@Component({
  imports: [PbAvatar, PbAvatarGroup],
  template: `
    <pb-avatar-group>
      <li><pb-avatar [name]="name()" [src]="src()" [speaking]="speaking()" /></li>
    </pb-avatar-group>
  `,
})
class Host {
  readonly name = signal("Ada Lovelace");

  readonly src = signal<string | null>(null);

  readonly speaking = signal(false);
}

@Component({
  imports: [PbAvatar, PbAvatarGroup],
  template: `
    <pb-avatar-group label="In the office · 1">
      <li><pb-avatar name="Ada Lovelace" /></li>
    </pb-avatar-group>
    <pb-avatar-group label="Spoke">
      <li><pb-avatar name="Linus" /></li>
    </pb-avatar-group>
  `,
})
class LabelledHost {}

const render = async (src: string | null) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.src.set(src);
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;

  return element;
};

describe("PbAvatar", () => {
  it("shows named initials when there's no picture", async () => {
    const element = await render(null);
    const initials = element.querySelector('[role="img"]');

    expect(initials?.textContent).toBe("AL");
    expect(initials?.getAttribute("aria-label")).toBe("Ada Lovelace");
    expect(element.querySelector("pb-avatar")?.getAttribute("title")).toBe("Ada Lovelace");
  });

  it("shows the picture when there is one", async () => {
    const element = await render("https://cdn.example/ada.png");
    const image = element.querySelector("img");

    expect(image?.getAttribute("src")).toBe("https://cdn.example/ada.png");
    expect(image?.getAttribute("alt")).toBe("Ada Lovelace");
    expect(element.querySelector('[role="img"]')).toBeNull();
  });

  it("wears a ring only while speaking", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const avatar: HTMLElement | null = fixture.nativeElement.querySelector("pb-avatar");

    expect(avatar?.classList.contains("speaking")).toBe(false);

    fixture.componentInstance.speaking.set(true);
    await fixture.whenStable();

    expect(avatar?.classList.contains("speaking")).toBe(true);
  });
});

describe("PbAvatarGroup", () => {
  it("puts the avatars in a list", async () => {
    const element = await render(null);

    expect(element.querySelector("pb-avatar-group ul > li > pb-avatar")).not.toBeNull();
    expect(element.querySelector("p")).toBeNull();
    expect(element.querySelector("ul")?.hasAttribute("aria-labelledby")).toBe(false);
  });

  it("names each list by its own label", async () => {
    const fixture = TestBed.createComponent(LabelledHost);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;

    const names = [...element.querySelectorAll("ul")].map(
      (list) => element.querySelector(`#${list.getAttribute("aria-labelledby")}`)?.textContent,
    );

    expect(names).toEqual(["In the office · 1", "Spoke"]);
  });
});
