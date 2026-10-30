import { Component, computed, input } from "@angular/core";

import { PbEyebrow } from "./eyebrow";

export interface Bar {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
}

let nextLabelId = 0;

@Component({
  selector: "pb-bar-list",
  imports: [PbEyebrow],
  template: `
    <p pbEyebrow tone="muted" [id]="labelId">{{ label() }}</p>
    @if (bars().length > 0) {
      <ol [attr.aria-labelledby]="labelId">
        @for (bar of bars(); track bar.id) {
          <li class="text-body-sm">
            <span class="label">{{ bar.label }}</span>
            <span class="value text-tabular">{{ bar.display }}</span>
            <span class="bar" aria-hidden="true" [style.width.%]="bar.share"></span>
          </li>
        }
      </ol>
    } @else {
      <p class="empty text-body-sm">{{ empty() }}</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-width: 0;
    }

    ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      column-gap: var(--space-3);
      row-gap: var(--space-1);
      color: var(--color-text);
    }

    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .value {
      color: var(--color-text-heading);
      font-weight: 500;
    }

    .bar {
      grid-column: 1 / -1;
      height: var(--space-1-5);
      min-width: var(--space-1-5);
      border-radius: var(--radius-full);
      background: var(--color-primary-400);
    }

    .empty {
      margin: 0;
      color: var(--color-text-muted);
    }
  `,
})
export class PbBarList {
  readonly label = input.required<string>();

  readonly items = input.required<ReadonlyArray<Bar>>();

  readonly empty = input("Nothing yet");

  protected readonly labelId = `pb-bar-list-label-${nextLabelId++}`;

  protected readonly bars = computed(() => {
    const items = this.items();
    const most = Math.max(0, ...items.map((item) => item.value));

    return items.map((item) => ({ ...item, share: most > 0 ? (item.value / most) * 100 : 0 }));
  });
}
