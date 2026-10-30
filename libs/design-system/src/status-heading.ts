import { NgTemplateOutlet } from "@angular/common";
import { Component, input } from "@angular/core";

import { PbDescription } from "./description";
import { PbHeading } from "./heading";
import { PbLiveDot } from "./live-dot";

export type HeadingLevel = 1 | 2 | 3;

@Component({
  selector: "pb-status-heading",
  imports: [NgTemplateOutlet, PbDescription, PbHeading, PbLiveDot],
  template: `
    <ng-template #content>
      @if (live()) {
        <pb-live-dot />
      }
      {{ heading() }}
    </ng-template>
    @switch (level()) {
      @case (1) {
        <h1 pbHeading class="text-tabular"><ng-container [ngTemplateOutlet]="content" /></h1>
      }
      @case (2) {
        <h2 pbHeading class="text-tabular"><ng-container [ngTemplateOutlet]="content" /></h2>
      }
      @case (3) {
        <h3 pbHeading class="text-tabular"><ng-container [ngTemplateOutlet]="content" /></h3>
      }
    }
    @if (subheading(); as subheading) {
      <p class="text-body subheading">{{ subheading }}</p>
    }
    @if (description(); as description) {
      <p pbDescription>{{ description }}</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .subheading {
      margin: 0;
      font-weight: 600;
      color: var(--color-text-heading);
      overflow-wrap: anywhere;
    }

    pb-live-dot {
      margin-right: var(--space-2-5);
    }
  `,
})
export class PbStatusHeading {
  readonly heading = input.required<string>();

  readonly subheading = input<string | null>(null);

  readonly description = input<string | null>(null);

  readonly live = input(false);

  readonly level = input<HeadingLevel>(1);
}
