import { Component, input } from "@angular/core";
import { PbAvatar, PbAvatarGroup } from "design-system";

import type { Occupant } from "../models";

@Component({
  selector: "app-occupant-list",
  imports: [PbAvatar, PbAvatarGroup],
  template: `
    <pb-avatar-group label="In the office · {{ occupants().length }}">
      @for (occupant of occupants(); track occupant.userId) {
        <li>
          <pb-avatar [name]="occupant.displayName" [src]="occupant.avatarUrl" />
        </li>
      }
    </pb-avatar-group>
  `,
})
export class OccupantList {
  readonly occupants = input.required<ReadonlyArray<Occupant>>();
}
