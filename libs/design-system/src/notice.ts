import { Component, input } from "@angular/core";

export type NoticeKind = "info" | "error";

@Component({
  selector: "pb-notice",
  template: `<ng-content />`,
  styles: `
    :host {
      display: block;
      padding: var(--space-2-5) var(--space-4);
      border: 1px solid var(--color-info-200);
      border-radius: var(--radius-lg);
      background: var(--color-info-50);
      color: var(--color-info-800);
    }

    :host(.error) {
      border-color: var(--color-error-200);
      background: var(--color-error-50);
      color: var(--color-error-800);
    }
  `,
  host: { class: "text-body-sm", "[class.error]": "kind() === 'error'" },
})
export class PbNotice {
  readonly kind = input<NoticeKind>("info");
}
