import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type NoticeKind, PbNotice } from "./notice";

@Component({
  imports: [PbNotice],
  template: `<pb-notice [kind]="kind()">Saved.</pb-notice>`,
})
class Host {
  readonly kind = signal<NoticeKind>("info");
}

describe("PbNotice", () => {
  it("shows its content as an info notice", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const notice: HTMLElement = fixture.nativeElement.querySelector("pb-notice");

    expect(notice.textContent).toBe("Saved.");
    expect(notice.classList).not.toContain("error");
  });

  it("switches to the error style", async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.kind.set("error");
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector("pb-notice").classList).toContain("error");
  });
});
