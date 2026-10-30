import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import { PbAvatar } from "./avatar";
import { PbAvatarGroup } from "./avatar-group";

@Component({
  imports: [PbAvatar, PbAvatarGroup],
  template: `
    <ul pbAvatarGroup>
      <li><pb-avatar [name]="name()" [src]="src()" /></li>
    </ul>
  `,
})
class Host {
  readonly name = signal("Ada Lovelace");

  readonly src = signal<string | null>(null);
}

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

  it("sits in a list", async () => {
    const element = await render(null);

    expect(element.querySelector("ul > li > pb-avatar")).not.toBeNull();
  });
});
