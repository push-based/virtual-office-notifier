import { Component, input } from "@angular/core";

@Component({
  selector: "pb-stat",
  template: `
    <span class="value text-title text-tabular">{{ value() }}</span>
    <span class="label text-caption">{{ label() }}</span>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-0-5);
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-surface);
    }

    .value {
      color: var(--color-text-heading);
    }

    .label {
      color: var(--color-text-muted);
    }
  `,
})
export class PbStat {
  readonly value = input.required<string>();

  readonly label = input.required<string>();
}
