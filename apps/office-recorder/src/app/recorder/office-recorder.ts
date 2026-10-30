import { Component, type OnInit, computed, inject } from "@angular/core";
import {
  PbCard,
  PbDivider,
  PbEyebrow,
  PbNotice,
  PbNoticeRegion,
  PbPeople,
  PbRecordButton,
  PbStatusHeading,
  type Person,
} from "design-system";

import { describePhase } from "./describe-phase";
import { OfficeStore } from "./office-store";

@Component({
  selector: "app-office-recorder",
  imports: [
    PbCard,
    PbDivider,
    PbEyebrow,
    PbNotice,
    PbNoticeRegion,
    PbPeople,
    PbRecordButton,
    PbStatusHeading,
  ],
  providers: [OfficeStore],
  template: `
    @let status = description();
    <pb-card size="lg">
      <p pbEyebrow>Office recorder</p>
      <pb-status-heading
        [heading]="status.heading"
        [description]="status.description"
        [live]="status.live"
      />
      <pb-record-button
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
      @if (people().length > 0) {
        <hr pbDivider />
        <pb-people [people]="people()" label="In the office · {{ people().length }}" />
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

  protected readonly description = computed(() =>
    describePhase(this.store.phase(), this.store.now()),
  );

  protected readonly people = computed((): ReadonlyArray<Person> =>
    this.store.occupants().map((occupant) => ({
      id: occupant.userId,
      name: occupant.displayName,
      avatarUrl: occupant.avatarUrl,
      speaking: occupant.speaking,
    })),
  );

  ngOnInit(): void {
    void this.store.start();
  }
}
