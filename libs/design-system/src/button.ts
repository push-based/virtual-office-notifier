import { Component, input } from "@angular/core";

export type ButtonVariant = "primary" | "ghost" | "tertiary";

export type ButtonSize = "md" | "lg";

@Component({
  selector: "button[pbButton], a[pbButton]",
  template: `<ng-content />`,
  styles: `
    :host(.pb-btn-primary) {
      --btn-bg: var(--color-primary-600);
      --btn-bg-hover: var(--color-primary-700);
    }

    :host([aria-disabled="true"]) {
      --btn-bg-hover: var(--btn-bg);
      cursor: not-allowed;
      opacity: 0.5;
    }
  `,
  host: {
    class: "pb-btn",
    "[class.pb-btn-lg]": "size() === 'lg'",
    "[class.pb-btn-primary]": "variant() === 'primary'",
    "[class.pb-btn-ghost]": "variant() === 'ghost'",
    "[class.pb-btn-tertiary]": "variant() === 'tertiary'",
  },
})
export class PbButton {
  readonly variant = input<ButtonVariant>("primary");

  readonly size = input<ButtonSize>("md");
}
