import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type BadgeTone, PbBadge } from "./badge";

@Component({
  imports: [PbBadge],
  template: `<pb-badge [tone]="tone()">Running</pb-badge>`,
})
class Host {
  readonly tone = signal<BadgeTone>("live");
}

const render = async (tone: BadgeTone) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.tone.set(tone);
  await fixture.whenStable();
  const badge: HTMLElement = fixture.nativeElement.querySelector("pb-badge");

  return badge;
};

describe("PbBadge", () => {
  it("shows its label in the caption type", async () => {
    const badge = await render("live");

    expect(badge.textContent).toBe("Running");
    expect(badge.classList).toContain("text-caption");
  });

  it("takes the colour of its tone", async () => {
    for (const tone of ["live", "pending", "done", "quiet"] as const) {
      const badge = await render(tone);

      expect(badge.classList).toContain(tone);
    }
  });
});
