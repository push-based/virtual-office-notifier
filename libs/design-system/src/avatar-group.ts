import { Component, input } from "@angular/core";

import { PbEyebrow } from "./eyebrow";

let nextLabelId = 0;

@Component({
  selector: "pb-avatar-group",
  imports: [PbEyebrow],
  template: `
    @if (label(); as label) {
      <p pbEyebrow tone="muted" [id]="labelId">{{ label }}</p>
    }
    <ul [attr.aria-labelledby]="label() ? labelId : null">
      <ng-content />
    </ul>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
})
export class PbAvatarGroup {
  readonly label = input<string | null>(null);

  protected readonly labelId = `pb-avatar-group-label-${nextLabelId++}`;
}
