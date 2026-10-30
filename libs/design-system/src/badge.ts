import { Component, input } from "@angular/core";

export type BadgeTone = "live" | "pending" | "done" | "quiet";

@Component({
  selector: "pb-badge",
  template: `<ng-content />`,
  styles: `
    :host {
      --badge-bg: var(--color-neutral-100);
      --badge-color: var(--color-neutral-600);
      display: inline-flex;
      align-items: center;
      padding: var(--space-0-5) var(--space-2);
      border-radius: var(--radius-full);
      background: var(--badge-bg);
      color: var(--badge-color);
      font-weight: 600;
      white-space: nowrap;
    }

    :host(.live) {
      --badge-bg: var(--color-error-50);
      --badge-color: var(--color-error-700);
    }

    :host(.pending) {
      --badge-bg: var(--color-warning-50);
      --badge-color: var(--color-warning-700);
    }

    :host(.done) {
      --badge-bg: var(--color-success-50);
      --badge-color: var(--color-success-700);
    }
  `,
  host: { class: "text-caption", "[class]": "tone()" },
})
export class PbBadge {
  readonly tone = input<BadgeTone>("quiet");
}
