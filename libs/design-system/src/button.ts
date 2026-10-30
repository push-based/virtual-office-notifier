import {
  Component,
  DestroyRef,
  booleanAttribute,
  ElementRef,
  Renderer2,
  inject,
  input,
} from "@angular/core";

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

    :host(.pb-btn-full) {
      width: 100%;
      justify-content: center;
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
    "[class.pb-btn-full]": "fullWidth()",
    "[class.pb-btn-primary]": "variant() === 'primary'",
    "[class.pb-btn-ghost]": "variant() === 'ghost'",
    "[class.pb-btn-tertiary]": "variant() === 'tertiary'",
    "[attr.aria-disabled]": "disabled() || null",
  },
})
export class PbButton {
  readonly variant = input<ButtonVariant>("primary");

  readonly size = input<ButtonSize>("md");

  readonly fullWidth = input(false, { transform: booleanAttribute });

  readonly disabled = input(false, { transform: booleanAttribute });

  constructor() {
    const stopListening = inject(Renderer2).listen(
      inject(ElementRef).nativeElement,
      "click",
      (event: Event) => this.swallowWhileDisabled(event),
      { capture: true },
    );

    inject(DestroyRef).onDestroy(stopListening);
  }

  private swallowWhileDisabled(event: Event): void {
    if (!this.disabled()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
