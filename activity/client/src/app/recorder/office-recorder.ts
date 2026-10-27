import { Component, type OnInit, inject } from "@angular/core";

import { PbCard, PbEyebrow, PbNotice } from "../../design-system";
import { OfficeStore } from "./office-store";
import { OccupantList } from "./ui/occupant-list";
import { RecordButton } from "./ui/record-button";
import { StatusHeading } from "./ui/status-heading";

@Component({
  selector: "app-office-recorder",
  imports: [PbCard, PbEyebrow, PbNotice, StatusHeading, RecordButton, OccupantList],
  providers: [OfficeStore],
  template: `
    <pb-card>
      <p pbEyebrow>Office recorder</p>
      <app-status-heading [phase]="store.phase()" [now]="store.now()" />
      <app-record-button
        [recording]="store.recording()"
        [busy]="store.busy()"
        [disabled]="!store.canPress()"
        (pressed)="store.press()"
      />
      <div class="announcer" role="status">
        @if (store.notice(); as notice) {
          <pb-notice [kind]="notice.kind">{{ notice.text }}</pb-notice>
        }
      </div>
      @if (store.occupants().length > 0) {
        <app-occupant-list [occupants]="store.occupants()" />
      }
    </pb-card>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      max-width: var(--space-96);
    }

    pb-card {
      max-width: none;
      gap: var(--space-4);
    }

    .announcer {
      display: contents;
    }
  `,
})
export class OfficeRecorder implements OnInit {
  protected readonly store = inject(OfficeStore);

  ngOnInit(): void {
    void this.store.start();
  }
}
