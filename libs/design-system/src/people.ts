import { Component, input } from "@angular/core";

import { PbAvatar } from "./avatar";
import { PbAvatarGroup } from "./avatar-group";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly speaking?: boolean;
}

@Component({
  selector: "pb-people",
  imports: [PbAvatar, PbAvatarGroup],
  template: `
    <pb-avatar-group [label]="label()">
      @for (person of people(); track person.id) {
        <li>
          <pb-avatar
            [name]="person.name"
            [src]="person.avatarUrl"
            [speaking]="person.speaking ?? false"
          />
        </li>
      }
    </pb-avatar-group>
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class PbPeople {
  readonly people = input.required<ReadonlyArray<Person>>();

  readonly label = input<string | null>(null);
}
