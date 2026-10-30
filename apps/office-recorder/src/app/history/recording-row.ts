import { NgTemplateOutlet } from "@angular/common";
import { Component, computed, input, output } from "@angular/core";
import { PbBadge, PbDescription, PbPeople, type Person } from "design-system";

import { canOpen, formatOfficeTime, formatRunTime, stateBadge } from "./describe-recording";
import type { ListedRecording, OfficeMember } from "./models";

export const personOf = (member: OfficeMember): Person => ({
  id: member.userId,
  name: member.name,
  avatarUrl: member.avatarUrl,
});

@Component({
  selector: "app-recording-row",
  imports: [NgTemplateOutlet, PbBadge, PbDescription, PbPeople],
  template: `
    <ng-template #facts>
      <span class="top">
        <span class="text-body when">{{ startedAt() }}</span>
        <pb-badge [tone]="badge().tone">{{ badge().label }}</pb-badge>
      </span>
      <span pbDescription>{{ runTime() }} · Started by {{ recording().startedBy.name }}</span>
      @if (speakers().length > 0) {
        <pb-people [people]="speakers()" />
      }
    </ng-template>
    @if (openable()) {
      <button type="button" class="row" (click)="opened.emit()">
        <ng-container [ngTemplateOutlet]="facts" />
      </button>
    } @else {
      <div class="row">
        <ng-container [ngTemplateOutlet]="facts" />
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .row {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      width: 100%;
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-surface);
      font: inherit;
      color: inherit;
      text-align: left;
    }

    button.row {
      cursor: pointer;
      transition: border-color 0.2s ease-out;
    }

    button.row:hover {
      border-color: var(--color-primary-300);
    }

    button.row:focus-visible {
      outline: none;
      box-shadow: var(--shadow-focus);
    }

    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .when {
      font-weight: 600;
      color: var(--color-text-heading);
    }
  `,
})
export class RecordingRow {
  readonly recording = input.required<ListedRecording>();

  readonly now = input.required<number>();

  readonly opened = output();

  protected readonly openable = computed(() => canOpen(this.recording().state));

  protected readonly badge = computed(() => stateBadge(this.recording().state));

  protected readonly startedAt = computed(() => formatOfficeTime(this.recording().startedAt));

  protected readonly runTime = computed(() =>
    formatRunTime(this.recording().startedAt, this.recording().stoppedAt, this.now()),
  );

  protected readonly speakers = computed(() => this.recording().speakers.map(personOf));
}
