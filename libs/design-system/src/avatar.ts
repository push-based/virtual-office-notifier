import { Component, input } from "@angular/core";

import { InitialsPipe } from "./initials.pipe";

@Component({
  selector: "pb-avatar",
  imports: [InitialsPipe],
  template: `
    @if (src(); as src) {
      <img [src]="src" [alt]="name()" />
    } @else {
      <span class="text-caption initials" role="img" [attr.aria-label]="name()">{{
        name() | initials
      }}</span>
    }
  `,
  styles: `
    :host {
      width: var(--space-10);
      height: var(--space-10);
      border-radius: var(--radius-full);
      overflow: hidden;
      background: var(--color-primary-100);
      color: var(--color-primary-700);
      display: flex;
      align-items: center;
      justify-content: center;
      outline: var(--space-0-5) solid transparent;
      outline-offset: var(--space-0-5);
      transition: outline-color 150ms ease-out;
    }

    :host(.speaking) {
      outline-color: var(--color-success-500);
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        transition: none;
      }
    }

    .initials {
      font-weight: 600;
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
  host: { "[attr.title]": "name()", "[class.speaking]": "speaking()" },
})
export class PbAvatar {
  readonly name = input.required<string>();

  readonly src = input<string | null>(null);

  readonly speaking = input(false);
}
