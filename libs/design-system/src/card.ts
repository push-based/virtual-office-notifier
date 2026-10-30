import { Component, input } from "@angular/core";

export type CardSize = "md" | "lg";

@Component({
  selector: "pb-card",
  template: `<ng-content />`,
  styles: `
    :host(.pb-card-lg) {
      max-width: none;
      gap: var(--space-4);
    }
  `,
  host: { class: "pb-card", "[class.pb-card-lg]": "size() === 'lg'" },
})
export class PbCard {
  readonly size = input<CardSize>("md");
}
