import { Component, type OnInit, computed, inject } from "@angular/core";
import {
  PbButton,
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

import { PlanFields } from "../edits/plan-fields";
import { RecordingEditor } from "../edits/recording-editor";
import { RecordingHistory } from "../history/recording-history";
import { describePhase } from "./describe-phase";
import { OfficeStore } from "./office-store";

@Component({
  selector: "app-office-recorder",
  imports: [
    PbButton,
    PbCard,
    PbDivider,
    PbEyebrow,
    PbNotice,
    PbNoticeRegion,
    PbPeople,
    PbRecordButton,
    PbStatusHeading,
    PlanFields,
    RecordingEditor,
    RecordingHistory,
  ],
  providers: [OfficeStore],
  template: `
    @let status = description();
    <pb-card size="lg">
      <p pbEyebrow>Office recorder</p>
      <pb-status-heading
        [heading]="status.heading"
        [subheading]="store.running()?.title ?? null"
        [description]="status.description"
        [live]="status.live"
      />
      @if (store.running(); as running) {
        <app-recording-editor
          label="Edit title and agenda"
          [recordingId]="running.id"
          [currentTitle]="running.title"
          [currentAgenda]="running.agenda"
          [currentSummaryStyle]="running.summaryStyle"
          (saved)="store.refresh()"
        />
      } @else {
        <details class="plan">
          <summary class="text-body-sm">Add a title and agenda</summary>
          <app-plan-fields
            [(title)]="store.draftTitle"
            [(agenda)]="store.draftAgenda"
            [(summaryStyle)]="store.draftSummaryStyle"
            [disabled]="store.busy()"
          />
        </details>
      }
      <div class="controls">
        <pb-record-button
          [recording]="store.recording()"
          [busy]="store.busy()"
          [disabled]="!store.canPress()"
          (pressed)="store.press()"
        />
        @if (store.recording()) {
          <button
            pbButton
            type="button"
            variant="ghost"
            size="lg"
            [disabled]="!store.canPress()"
            [attr.aria-busy]="store.busy()"
            (click)="store.pressPause()"
          >
            {{ store.paused() ? "Resume" : "Pause" }}
          </button>
        }
      </div>
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
    <app-recording-history [now]="store.now()" />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      width: 100%;
      max-width: var(--space-96);
    }

    .controls {
      display: flex;
      gap: var(--space-3);
    }

    .plan summary {
      cursor: pointer;
      font-weight: 500;
      color: var(--color-text-muted);
    }

    .plan[open] summary {
      margin-bottom: var(--space-3);
    }

    pb-record-button {
      flex: 1;
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
