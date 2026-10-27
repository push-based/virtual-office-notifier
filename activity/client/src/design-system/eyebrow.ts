import { Component, input } from "@angular/core";

export type EyebrowTone = "brand" | "muted";

@Component({
  selector: "[pbEyebrow]",
  template: `<ng-content />`,
  styles: `
    :host {
      margin: 0;
      color: var(--color-brand-hover);
    }

    :host(.muted) {
      color: var(--color-text-muted);
    }
  `,
  host: { class: "text-subtitle", "[class.muted]": "tone() === 'muted'" },
})
export class PbEyebrow {
  readonly tone = input<EyebrowTone>("brand");
}
