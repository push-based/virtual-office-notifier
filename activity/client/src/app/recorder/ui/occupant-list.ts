import { Component, input } from "@angular/core";

import { PbAvatar, PbAvatarGroup, PbEyebrow } from "../../../design-system";
import type { Occupant } from "../models";

@Component({
  selector: "app-occupant-list",
  imports: [PbAvatar, PbAvatarGroup, PbEyebrow],
  template: `
    <p pbEyebrow tone="muted" id="occupants-label">In the office · {{ occupants().length }}</p>
    <ul pbAvatarGroup aria-labelledby="occupants-label">
      @for (occupant of occupants(); track occupant.userId) {
        <li>
          <pb-avatar [name]="occupant.displayName" [src]="occupant.avatarUrl" />
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-neutral-200);
    }
  `,
})
export class OccupantList {
  readonly occupants = input.required<ReadonlyArray<Occupant>>();
}
