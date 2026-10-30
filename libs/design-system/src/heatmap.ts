import { Component, computed, input } from "@angular/core";

import { PbEyebrow } from "./eyebrow";

export interface HeatmapRow {
  readonly label: string;
  readonly cells: ReadonlyArray<HeatmapCell>;
}

export interface HeatmapCell {
  readonly value: number | null;
  readonly description: string;
}

let nextCaptionId = 0;

@Component({
  selector: "pb-heatmap",
  imports: [PbEyebrow],
  template: `
    <p pbEyebrow tone="muted" [id]="captionId">{{ label() }}</p>
    @if (rows().length > 0 && columns().length > 0) {
      <div class="scroller">
        <table [attr.aria-labelledby]="captionId" class="text-caption">
          <thead>
            <tr>
              <td></td>
              @for (column of columns(); track $index) {
                <th scope="col">{{ column }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of shaded(); track row.label) {
              <tr>
                <th scope="row">{{ row.label }}</th>
                @for (cell of row.cells; track $index) {
                  <td
                    [class.unknown]="cell.value === null"
                    [style.--heat]="cell.heat"
                    [attr.title]="cell.description"
                  >
                    <span class="sr-only">{{ cell.description }}</span>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
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

    .scroller {
      overflow-x: auto;
    }

    table {
      border-collapse: separate;
      border-spacing: var(--space-0-5);
      color: var(--color-text-muted);
    }

    th {
      font-weight: 400;
    }

    th[scope="row"] {
      text-align: left;
      padding-right: var(--space-1);
    }

    th[scope="col"] {
      text-align: center;
      min-width: var(--space-6);
    }

    td {
      height: var(--space-6);
      min-width: var(--space-6);
      border-radius: var(--radius-sm);
      background: color-mix(
        in srgb,
        var(--color-primary-600) calc(var(--heat) * 100%),
        var(--color-primary-50)
      );
    }

    thead td {
      background: none;
    }

    td.unknown {
      background: var(--color-neutral-100);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .empty {
      margin: 0;
      color: var(--color-text-muted);
    }
  `,
})
export class PbHeatmap {
  readonly label = input.required<string>();

  readonly columns = input.required<ReadonlyArray<string>>();

  readonly rows = input.required<ReadonlyArray<HeatmapRow>>();

  readonly empty = input("Nothing yet");

  protected readonly captionId = `pb-heatmap-caption-${nextCaptionId++}`;

  protected readonly shaded = computed(() => {
    const rows = this.rows();
    const hottest = Math.max(0, ...rows.flatMap((row) => row.cells.map((cell) => cell.value ?? 0)));

    return rows.map((row) => ({
      label: row.label,
      cells: row.cells.map((cell) => ({
        ...cell,
        heat: hottest > 0 && cell.value !== null ? cell.value / hottest : 0,
      })),
    }));
  });
}
