import { NgTemplateOutlet } from "@angular/common";
import { Component, inject, input } from "@angular/core";
import {
  PbButton,
  PbCard,
  PbDescription,
  PbEyebrow,
  PbNotice,
  PbNoticeRegion,
} from "design-system";

import { HistoryStore } from "./history-store";
import { RecordingPage } from "./recording-page";
import { RecordingRow } from "./recording-row";

@Component({
  selector: "app-recording-history",
  imports: [
    NgTemplateOutlet,
    PbButton,
    PbCard,
    PbDescription,
    PbEyebrow,
    PbNotice,
    PbNoticeRegion,
    RecordingPage,
    RecordingRow,
  ],
  providers: [HistoryStore],
  template: `
    @if (store.openId() !== null) {
      <pb-card size="lg">
        @if (store.open(); as recording) {
          <app-recording-page
            [recording]="recording"
            [now]="now()"
            (back)="store.back()"
            (openInSlack)="store.openInSlack($event)"
            (edited)="store.refresh()"
          />
        } @else {
          <button pbButton variant="tertiary" type="button" class="back" (click)="store.back()">
            ← Back
          </button>
          <p pbDescription>Loading the recording…</p>
        }
        <ng-container [ngTemplateOutlet]="problems" />
      </pb-card>
    } @else if (store.loaded() || store.failure() !== null) {
      <pb-card size="lg">
        <p pbEyebrow tone="muted">Recording history</p>
        <ul class="recordings">
          @for (recording of store.recordings(); track recording.id) {
            <li>
              <app-recording-row
                [recording]="recording"
                [now]="now()"
                (opened)="store.openRecording(recording.id)"
              />
            </li>
          } @empty {
            @if (store.loaded()) {
              <li pbDescription>Nothing has been recorded yet.</li>
            }
          }
        </ul>
        @if (store.hasOlder()) {
          <button
            pbButton
            variant="ghost"
            type="button"
            fullWidth
            [disabled]="store.loadingOlder()"
            (click)="store.showOlder()"
          >
            Show older
          </button>
        }
        <ng-container [ngTemplateOutlet]="problems" />
      </pb-card>
    }
    <ng-template #problems>
      <pb-notice-region>
        @if (store.failure(); as failure) {
          <pb-notice kind="error">Couldn't load the recording history: {{ failure }}</pb-notice>
        }
      </pb-notice-region>
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
    }

    .recordings {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .back {
      align-self: flex-start;
    }
  `,
})
export class RecordingHistory {
  protected readonly store = inject(HistoryStore);

  readonly now = input.required<number>();
}
