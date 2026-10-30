import { Component, type OnInit, inject } from "@angular/core";
import { PbCard, PbDivider, PbEyebrow, PbNotice, PbNoticeRegion } from "design-system";

import { OfficeStore } from "./office-store";
import { OccupantList } from "./ui/occupant-list";
import { RecordButton } from "./ui/record-button";
import { StatusHeading } from "./ui/status-heading";

@Component({
  selector: "app-office-recorder",
  imports: [
    PbCard,
    PbDivider,
    PbEyebrow,
    PbNotice,
    PbNoticeRegion,
    StatusHeading,
    RecordButton,
    OccupantList,
  ],
  providers: [OfficeStore],
  template: `
    <pb-card size="lg">
      <p pbEyebrow>Office recorder</p>
      <app-status-heading [phase]="store.phase()" [now]="store.now()" />
      <app-record-button
        [recording]="store.recording()"
        [busy]="store.busy()"
        [disabled]="!store.canPress()"
        (pressed)="store.press()"
      />
      <pb-notice-region>
        @if (store.notice(); as notice) {
          <pb-notice [kind]="notice.kind">{{ notice.text }}</pb-notice>
        }
      </pb-notice-region>
      @if (store.occupants().length > 0) {
        <hr pbDivider />
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
  `,
})
export class OfficeRecorder implements OnInit {
  protected readonly store = inject(OfficeStore);

  ngOnInit(): void {
    void this.store.start();
  }
}
