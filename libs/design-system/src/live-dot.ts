import { Component, input } from "@angular/core";

export type LiveDotTone = "error" | "success";

@Component({
  selector: "pb-live-dot",
  template: ``,
  styles: `
    :host {
      --live-dot-color: var(--color-error-500);
      display: inline-block;
      vertical-align: middle;
      width: var(--space-3);
      height: var(--space-3);
      border-radius: var(--radius-full);
      background: var(--live-dot-color);
      animation: pulse 1.6s ease-out infinite;
    }

    :host(.success) {
      --live-dot-color: var(--color-success-500);
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none;
      }
    }

    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--live-dot-color) 50%, transparent);
      }
      100% {
        box-shadow: 0 0 0 var(--space-2) transparent;
      }
    }
  `,
  host: { "aria-hidden": "true", "[class.success]": "tone() === 'success'" },
})
export class PbLiveDot {
  readonly tone = input<LiveDotTone>("error");
}
